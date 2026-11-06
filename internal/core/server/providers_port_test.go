package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/settings"
)

// WS-50.3 and WS-50.4: setup, the Providers app and the model list are this engine's own. Each is
// judged against what the TypeScript agent answered on the same settings and the same network
// (testdata/providers.json, written by tooling/port/providers-fixtures.ts), and none may reach the
// TypeScript agent.

type providersFixture struct {
	Setup []struct {
		Env      string            `json:"env"`
		Values   map[string]string `json:"values"`
		Rows     []map[string]any  `json:"providers"`
		Overview []map[string]any  `json:"overview"`
	} `json:"setup"`
	Save []struct {
		Params json.RawMessage   `json:"params"`
		Stored map[string]string `json:"stored"`
		Check  string            `json:"check"`
		Result map[string]any    `json:"result"`
		Saved  map[string]string `json:"saved"`
	} `json:"save"`
	Connect []struct {
		Params json.RawMessage   `json:"params"`
		Stored map[string]string `json:"stored"`
		Good   string            `json:"good"`
		Check  string            `json:"check"`
		Result map[string]any    `json:"result"`
		Saved  map[string]string `json:"saved"`
		Asked  []string          `json:"asked"`
	} `json:"connect"`
	Remember []struct {
		Params json.RawMessage   `json:"params"`
		Result map[string]any    `json:"result"`
		Saved  map[string]string `json:"saved"`
	} `json:"remember"`
	ProviderModels []struct {
		Provider string            `json:"provider"`
		Env      map[string]string `json:"env"`
		Result   map[string]any    `json:"result"`
	} `json:"providerModels"`
	List []struct {
		Name         string            `json:"name"`
		Env          map[string]string `json:"env"`
		Params       json.RawMessage   `json:"params"`
		Asked        []string          `json:"asked"`
		Choices      []map[string]any  `json:"choices"`
		Unconfigured []map[string]any  `json:"unconfigured"`
		Errors       []string          `json:"errors"`
	} `json:"list"`
}

func loadProvidersFixture(t *testing.T) providersFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/providers.json")
	if err != nil {
		t.Fatal(err)
	}
	var f providersFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Setup) < 5 || len(f.Save) < 8 || len(f.Connect) < 10 || len(f.List) < 3 {
		t.Fatal("the fixture is too small; regenerate it")
	}
	return f
}

// net answers like the fixture's fake network; the OpenRouter key check answers check, and is not
// counted among the listings asked.
type portNet struct {
	good, check string
	mu          sync.Mutex // the model list asks several providers at once
	asked       []string
	routes      func(url string) (int, string, bool)
}

func (n *portNet) get(_ context.Context, url string, headers map[string]string) (int, []byte, error) {
	if url == llm.OpenRouterKeyURL {
		switch n.check {
		case "invalid":
			return 401, nil, nil
		case "network":
			return 0, nil, errors.New("offline")
		}
		return 200, []byte(`{"data":{}}`), nil
	}
	n.mu.Lock()
	n.asked = append(n.asked, url)
	n.mu.Unlock()
	if n.routes != nil {
		if status, body, ok := n.routes(url); ok {
			return status, []byte(body), nil
		}
	}
	if strings.Contains(url, "down.example") {
		return 0, nil, errors.New("ECONNREFUSED")
	}
	if strings.Contains(url, "empty.example") {
		return 200, []byte(`{"data":[]}`), nil
	}
	auth, sent := headers["authorization"]
	if key, ok := headers["x-api-key"]; ok {
		auth, sent = key, true
	}
	if sent && auth != "Bearer "+n.good && auth != n.good {
		return 401, []byte(`{}`), nil
	}
	return 200, []byte(`{"data":[{"id":"gpt-a"},{"id":"gpt-b"}]}`), nil
}

// portServer is a server on its own settings, with no Claude Code, no Codex and no TypeScript
// agent: anything forwarded fails the test.
func portServer(t *testing.T, stored map[string]string, environ []string, net *portNet) *Server {
	t.Helper()
	dir := t.TempDir()
	if len(stored) > 0 {
		if _, err := settings.Save(dir, stored); err != nil {
			t.Fatal(err)
		}
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	environ = append([]string{"PATH=" + home, "HOME=" + home, "ARCHYMEDES_CLAUDE_PATH=/nonexistent/claude", "ARCHYMEDES_CODEX_PATH=/nonexistent/codex"}, environ...)
	return New(nil, Options{ConfigDir: dir, Environ: environ, Net: net.get, Forward: func(_ context.Context, method string, _ json.RawMessage) (json.RawMessage, error) {
		t.Errorf("%s was forwarded to the TypeScript agent", method)
		return nil, errors.New("forwarded")
	}})
}

// asJSON is v as generic JSON, for comparing with the fixture.
func asJSON(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(data, &out)
	return out
}

func call(t *testing.T, s *Server, method string, params json.RawMessage) map[string]any {
	t.Helper()
	got, err := s.dispatch(context.Background(), method, params)
	if err != nil {
		t.Fatalf("%s %s: %v", method, params, err)
	}
	out, _ := asJSON(t, got).(map[string]any)
	return out
}

func initialized(s *Server) *Server {
	s.initialized.Store(true)
	return s
}

// withoutOutside drops Claude's and Codex's rows, which the TypeScript fixture adds elsewhere.
func withoutOutside(rows []any) []any {
	var out []any
	for _, r := range rows {
		row, _ := r.(map[string]any)
		if id := firstNonEmpty(str(row["id"]), str(row["provider"])); id != "claude" && id != "codex" {
			out = append(out, r)
		}
	}
	return out
}

func str(v any) string { s, _ := v.(string); return s }

// environ is values as "KEY=value" pairs: the fixture's environment, which holds variables that
// are not settings (a free gateway, offline listings) as well as ones that are.
func environ(values map[string]string) []string {
	var out []string
	for k, v := range values {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func TestSetupAndProvidersAreTypeScripts(t *testing.T) {
	for _, c := range loadProvidersFixture(t).Setup {
		s := initialized(portServer(t, nil, environ(c.Values), &portNet{}))
		status := call(t, s, "_archymedes/setup/status", json.RawMessage(`{}`))
		rows, _ := status["providers"].([]any)
		if want := asJSON(t, c.Rows); !reflect.DeepEqual(rows, want) {
			t.Errorf("%s: setup rows\n go %v\n ts %v", c.Env, rows, want)
		}
		overview, _ := call(t, s, "_archymedes/providers", json.RawMessage(`{}`))["providers"].([]any)
		if want := asJSON(t, c.Overview); !reflect.DeepEqual(withoutOutside(overview), want) {
			t.Errorf("%s: providers\n go %v\n ts %v", c.Env, withoutOutside(overview), want)
		}
	}
}

// file is the result with the settings file's path as the fixture writes it.
func file(result map[string]any) map[string]any {
	if f, ok := result["file"].(string); ok && f != "" {
		result["file"] = "/settings.json"
	}
	return result
}

func savedSettings(s *Server) map[string]string {
	values := settings.Load(s.opts.ConfigDir)
	if len(values) == 0 {
		return nil
	}
	return values
}

func TestSavingAKeyIsTypeScripts(t *testing.T) {
	for _, c := range loadProvidersFixture(t).Save {
		s := initialized(portServer(t, c.Stored, nil, &portNet{check: c.Check}))
		got := file(call(t, s, "_archymedes/setup/save", c.Params))
		if !reflect.DeepEqual(got, c.Result) {
			t.Errorf("%s: %v, TypeScript %v", c.Params, got, c.Result)
		}
		want := c.Saved
		if want == nil {
			want = c.Stored
		}
		if saved := savedSettings(s); !reflect.DeepEqual(saved, want) && !(len(saved) == 0 && len(want) == 0) {
			t.Errorf("%s: saved %v, TypeScript %v", c.Params, saved, want)
		}
	}
}

func TestConnectingAProviderIsTypeScripts(t *testing.T) {
	for _, c := range loadProvidersFixture(t).Connect {
		net := &portNet{good: c.Good, check: c.Check}
		s := initialized(portServer(t, c.Stored, nil, net))
		got := file(call(t, s, "_archymedes/providers/connect", c.Params))
		if want := asJSON(t, c.Result); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v, TypeScript %v", c.Params, got, want)
		}
		want := c.Saved
		if want == nil {
			want = c.Stored
		}
		if saved := savedSettings(s); !reflect.DeepEqual(saved, want) && !(len(saved) == 0 && len(want) == 0) {
			t.Errorf("%s: saved %v, TypeScript %v", c.Params, saved, want)
		}
		if !slices.Equal(net.asked, c.Asked) && !(len(net.asked) == 0 && len(c.Asked) == 0) {
			t.Errorf("%s: asked %v, TypeScript %v", c.Params, net.asked, c.Asked)
		}
		// The models a connect listed are what the pickers offer next.
		if models, _ := got["models"].([]any); len(models) > 0 {
			var p struct{ Provider string }
			_ = json.Unmarshal(c.Params, &p)
			if cache := llm.ReadModelCache(s.opts.ConfigDir); cache == nil || len(cache.Models[p.Provider]) != len(models) {
				t.Errorf("%s: the listed models were not remembered: %+v", c.Params, cache)
			}
		}
	}
}

func TestRememberingAModelIsTypeScripts(t *testing.T) {
	for _, c := range loadProvidersFixture(t).Remember {
		s := initialized(portServer(t, nil, nil, &portNet{}))
		if got := call(t, s, "_archymedes/providers/remember-model", c.Params); !reflect.DeepEqual(got, c.Result) {
			t.Errorf("%s: %v, TypeScript %v", c.Params, got, c.Result)
		}
		if saved := savedSettings(s); !reflect.DeepEqual(saved, c.Saved) {
			t.Errorf("%s: saved %v, TypeScript %v", c.Params, saved, c.Saved)
		}
	}
}

func TestListingAProvidersModelsIsTypeScripts(t *testing.T) {
	for _, c := range loadProvidersFixture(t).ProviderModels {
		s := initialized(portServer(t, c.Env, nil, &portNet{}))
		s.opts.Net = func(ctx context.Context, url string, headers map[string]string) (int, []byte, error) {
			if strings.Contains(url, "down.example") {
				return 0, nil, errors.New("ECONNREFUSED")
			}
			if headers["authorization"] != "Bearer sk-good" {
				return 401, []byte(`{}`), nil
			}
			return 200, []byte(`{"data":[{"id":"gpt-z"},{"id":"text-embedding-3-small"}]}`), nil
		}
		got := call(t, s, "_archymedes/providers/models", json.RawMessage(`{"provider":"`+c.Provider+`"}`))
		if !reflect.DeepEqual(got, asJSON(t, c.Result)) {
			t.Errorf("%s %v: %v, TypeScript %v", c.Provider, c.Env, got, c.Result)
		}
	}
}
