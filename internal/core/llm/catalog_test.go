package llm

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// The catalog, judged against what the TypeScript agent answered on the same inputs
// (testdata/catalog.json, written by tooling/port/providers-fixtures.ts).

type catalogFixture struct {
	AsOf   string              `json:"asOf"`
	Known  map[string][]string `json:"known"`
	Prices []struct {
		Provider, Model, AsOf, Price string
		Input, Output, Cached        *int64
	} `json:"prices"`
	Models []struct {
		ID             string   `json:"id"`
		Free           bool     `json:"free"`
		Size           *float64 `json:"size"`
		Small          bool     `json:"small"`
		Conversational bool     `json:"conversational"`
		Aliases        []string `json:"aliases"`
		Fit            string   `json:"fit"`
		Note           string   `json:"note"`
	} `json:"models"`
	Envs      map[string]map[string]string `json:"envs"`
	Endpoints []struct {
		Env, Provider, URL string
		Headers            map[string]string
	} `json:"endpoints"`
	Listings []struct {
		Body any      `json:"body"`
		IDs  []string `json:"ids"`
	} `json:"listings"`
	FreeCatalog struct {
		OpenRouterBody any         `json:"openRouterBody"`
		DiscoveryBody  any         `json:"discoveryBody"`
		Live           []FreeModel `json:"live"`
		Discovery      []FreeModel `json:"discovery"`
		Merged         FreeCatalog `json:"merged"`
	} `json:"freeCatalog"`
	KeyInfo []struct {
		Body any             `json:"body"`
		Info json.RawMessage `json:"info"`
	} `json:"keyInfo"`
	KeyFailures []struct {
		Reason string `json:"reason"`
		Status int    `json:"status"`
		Text   string `json:"text"`
	} `json:"keyFailures"`
}

func loadCatalog(t *testing.T) catalogFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var f catalogFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Prices) < 100 || len(f.Models) < 40 || len(f.Endpoints) < 40 {
		t.Fatalf("fixture too small: %d prices, %d ids, %d endpoints", len(f.Prices), len(f.Models), len(f.Endpoints))
	}
	return f
}

func TestModelsEndpointsAreTypeScripts(t *testing.T) {
	f := loadCatalog(t)
	for _, want := range f.Endpoints {
		got, ok := ModelsEndpoint(want.Provider, Env(f.Envs[want.Env]))
		if ok != (want.URL != "") || got.URL != want.URL || (ok && !reflect.DeepEqual(got.Headers, want.Headers)) {
			t.Errorf("%s on %s: %+v %v, TypeScript %s %v", want.Provider, want.Env, got, ok, want.URL, want.Headers)
		}
	}
	for _, want := range f.Listings {
		if got := ParseModelsResponse(want.Body); !slices.Equal(got, want.IDs) {
			t.Errorf("%v: %v, TypeScript %v", want.Body, got, want.IDs)
		}
	}
}

func TestFreeCatalogIsTypeScripts(t *testing.T) {
	f := loadCatalog(t).FreeCatalog
	live, err := ParseFreeOpenRouter(f.OpenRouterBody)
	if err != nil {
		t.Fatal(err)
	}
	discovery, err := ParseFreeDiscovery(f.DiscoveryBody)
	if err != nil {
		t.Fatal(err)
	}
	same := func(name string, got, want any) {
		t.Helper()
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		if string(g) != string(w) {
			t.Errorf("%s:\n go %s\n ts %s", name, g, w)
		}
	}
	same("live", live, f.Live)
	same("discovery", discovery, f.Discovery)
	merged := MergeFreeCatalog(live, discovery, f.Merged.FetchedAt, []string{"w"})
	var ids, wantIDs []string
	for i, m := range merged.Models {
		ids = append(ids, m.ID)
		wantIDs = append(wantIDs, f.Merged.Models[i].ID)
		if m.Eligible != f.Merged.Models[i].Eligible || (m.Discovery == nil) != (f.Merged.Models[i].Discovery == nil) {
			t.Errorf("%s: %+v, TypeScript %+v", m.ID, m, f.Merged.Models[i])
		}
	}
	if !slices.Equal(ids, wantIDs) {
		t.Errorf("merged order %v, TypeScript %v", ids, wantIDs)
	}
	if _, err := ParseFreeOpenRouter(map[string]any{"data": "nope"}); err == nil {
		t.Error("a listing without data was read")
	}
}

func TestKeyInfoAndFailuresAreTypeScripts(t *testing.T) {
	f := loadCatalog(t)
	for _, want := range f.KeyInfo {
		got, _ := json.Marshal(ParseKeyInfo(want.Body))
		var a, b any
		_ = json.Unmarshal(got, &a)
		_ = json.Unmarshal(want.Info, &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%v: %s, TypeScript %s", want.Body, got, want.Info)
		}
	}
	for _, want := range f.KeyFailures {
		if got := DescribeKeyCheck(KeyCheck{Reason: want.Reason, Status: want.Status}); got != want.Text {
			t.Errorf("%s %d: %q, TypeScript %q", want.Reason, want.Status, got, want.Text)
		}
	}
}

// fakeNet answers by URL prefix; it records what was asked and with which headers.
type fakeNet struct {
	routes map[string]func(headers map[string]string) (int, string, error)
	mu     sync.Mutex // the free catalog asks two URLs at once
	asked  []string
}

func (n *fakeNet) get(_ context.Context, url string, headers map[string]string) (int, []byte, error) {
	n.mu.Lock()
	n.asked = append(n.asked, url)
	n.mu.Unlock()
	for prefix, answer := range n.routes {
		if strings.HasPrefix(url, prefix) {
			status, body, err := answer(headers)
			return status, []byte(body), err
		}
	}
	return 404, []byte(`{}`), nil
}

func TestCheckingAnOpenRouterKey(t *testing.T) {
	answer := func(status int, body string, err error) Getter {
		return func(_ context.Context, url string, headers map[string]string) (int, []byte, error) {
			if url != OpenRouterKeyURL || headers["authorization"] != "Bearer sk-or-1" {
				t.Fatalf("asked %s with %v", url, headers)
			}
			return status, []byte(body), err
		}
	}
	cases := []struct {
		get    Getter
		key    string
		ok     bool
		reason string
	}{
		{answer(200, `{"data":{"label":"k"}}`, nil), "sk-or-1", true, ""},
		{answer(401, ``, nil), "sk-or-1", false, "invalid"},
		{answer(403, ``, nil), " sk-or-1 ", false, "invalid"},
		{answer(500, ``, nil), "sk-or-1", false, "error"},
		{answer(200, `{"nope":1}`, nil), "sk-or-1", false, "error"},
		{answer(0, ``, errors.New("dial tcp: Bearer sk-or-1")), "sk-or-1", false, "network"},
		{nil, "has space", false, "invalid"},
		{nil, "", false, "invalid"},
	}
	for _, c := range cases {
		got := CheckOpenRouterKey(context.Background(), c.get, c.key)
		if got.OK != c.ok || got.Reason != c.reason {
			t.Errorf("%q: %+v, want ok %v reason %s", c.key, got, c.ok, c.reason)
		}
		if strings.Contains(DescribeKeyCheck(got), "sk-or-1") {
			t.Errorf("the key reached the message: %s", DescribeKeyCheck(got))
		}
	}
}

func TestListingsAreAskedCachedAndKeptWhenTheFreeOneFails(t *testing.T) {
	dir := t.TempDir()
	net := &fakeNet{routes: map[string]func(map[string]string) (int, string, error){
		"https://api.groq.com/": func(h map[string]string) (int, string, error) {
			if h["authorization"] != "Bearer q" {
				return 401, `{}`, nil
			}
			return 200, `{"data":[{"id":"z"},{"id":"whisper-large"},{"id":"a"}]}`, nil
		},
		"https://openrouter.ai/api/v1/models": func(map[string]string) (int, string, error) {
			return 200, `{"data":[{"id":"x/y:free","pricing":{"prompt":"0","completion":"0"},"architecture":{"output_modalities":["text"]},"supported_parameters":["tools"],"context_length":100}]}`, nil
		},
	}}
	now := time.Unix(1_800_000_000, 0)
	models, failed := LoadLiveModels(context.Background(), []string{"groq", "free"}, Env{"GROQ_API_KEY": "q"}, dir, net.get, now)
	if !slices.Equal(models["groq"], []string{"a", "z"}) || !slices.Equal(models["free"], []string{"x/y:free"}) {
		t.Fatalf("models %v", models)
	}
	if len(failed) != 1 || !strings.Contains(failed[0].Error, "discovery unavailable") {
		t.Fatalf("failed %+v: only discovery's warning", failed)
	}
	cache := ReadModelCache(dir)
	if !cache.Fresh(now) || cache.Fresh(now.Add(7*time.Hour)) || cache.Fresh(now.Add(-time.Minute)) || cache.FreeCatalog == nil {
		t.Fatalf("cache %+v", cache)
	}

	// The free listing fails: the last good one stays, and the cache keeps its date.
	net.routes["https://openrouter.ai/api/v1/models"] = func(map[string]string) (int, string, error) { return 503, ``, nil }
	models, _ = LoadLiveModels(context.Background(), []string{"groq", "free"}, Env{"GROQ_API_KEY": "q"}, dir, net.get, now.Add(time.Hour))
	if !slices.Equal(models["free"], []string{"x/y:free"}) || ReadModelCache(dir).FetchedAt != now.UnixMilli() {
		t.Fatalf("a failed free listing replaced the good one: %v %+v", models, ReadModelCache(dir))
	}

	RememberModels(dir, "openai", []string{"gpt-z"}, now)
	if c := ReadModelCache(dir); !slices.Equal(c.Models["openai"], []string{"gpt-z"}) || !slices.Equal(c.Models["groq"], []string{"a", "z"}) {
		t.Fatalf("remembering one provider lost another: %+v", c)
	}
	if err := os.WriteFile(ModelCacheFile(dir), []byte(`{"models":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if ReadModelCache(dir) != nil {
		t.Error("a cache without a date was trusted")
	}
}

func TestAProviderThatNeverAnswersTimesOut(t *testing.T) {
	hang := func(ctx context.Context, _ string, _ map[string]string) (int, []byte, error) {
		<-ctx.Done()
		return 0, nil, ctx.Err()
	}
	got := FetchProviderModels(context.Background(), "groq", Env{"GROQ_API_KEY": "q"}, hang, 20*time.Millisecond)
	if got.Error != "timed out" || len(got.Models) != 0 {
		t.Fatalf("%+v", got)
	}
	if got := FetchProviderModels(context.Background(), "openai", Env{}, hang, time.Second); got.Error != "no key configured" {
		t.Fatalf("%+v", got)
	}
}

func TestRequirementsCountAFreeGateway(t *testing.T) {
	free, _ := Lookup("free")
	if r := Requirements(free, Env{}); len(r) != 1 || !strings.Contains(r[0], "ARCHYMEDES_FREE_GATEWAY_URL") {
		t.Fatalf("%v", r)
	}
	for _, env := range []Env{{"OPENROUTER_API_KEY": "k"}, {"ARCHYMEDES_FREE_GATEWAY_URL": "https://gw.example/"}, {"ARCHYMEDES_FREE_GATEWAY_URL": "http://localhost:8787"}} {
		if r := Requirements(free, env); len(r) != 0 {
			t.Errorf("%v: %v", env, r)
		}
	}
	for _, bad := range []string{"http://gw.example", "https://u:p@gw.example", "not a url"} {
		if r := Requirements(free, Env{"ARCHYMEDES_FREE_GATEWAY_URL": bad}); len(r) == 0 {
			t.Errorf("gateway %q accepted", bad)
		}
	}
	if slices.Contains(Fetchable(Env{"ARCHYMEDES_CLOUD_TOKEN": "t", "ARCHYMEDES_CLOUD_BASE_URL": "https://c"}), "archymedes-cloud") {
		t.Error("Archymedes Cloud is asked for a listing")
	}
}
