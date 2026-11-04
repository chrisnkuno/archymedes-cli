package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestSecureRegistryWantsHTTPSOrThisMachine(t *testing.T) {
	for base, want := range map[string]bool{
		"https://registry.npmjs.org": true,
		"http://127.0.0.1:4873":      true,
		"http://localhost:4873":      true,
		"http://registry.example":    false,
		"ftp://registry.example":     false,
		"registry.example":           false,
		"":                           false,
	} {
		if got := secureRegistry(base); got != want {
			t.Errorf("secureRegistry(%q) = %v, want %v", base, got, want)
		}
	}
}

func TestFetchLatestRefusesAPlainHTTPRegistry(t *testing.T) {
	_, err := FetchLatest(context.Background(), env(map[string]string{"ARCHYMEDES_UPDATE_REGISTRY": "http://registry.example"}), "@archymedes/friday")
	if err == nil {
		t.Fatal("a plain-http registry was trusted")
	}
}

func TestFetchLatestOnlyAcceptsAWholeVersion(t *testing.T) {
	for latest, ok := range map[string]bool{
		"3.12.7":           true,
		"3.13.0-beta.1":    true,
		"99.0.0-x; rm -rf": false,
		"1.2.3 --force":    false,
		"1.2":              false,
		"1.2.3-":           false,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = jsonEncode(w, latest)
		}))
		got, err := FetchLatest(context.Background(), env(map[string]string{"ARCHYMEDES_UPDATE_REGISTRY": srv.URL}), "@archymedes/friday")
		srv.Close()
		if ok && (err != nil || got != latest) {
			t.Errorf("%q: got %q, %v", latest, got, err)
		}
		if !ok && err == nil {
			t.Errorf("%q was accepted as %q", latest, got)
		}
	}
}

func jsonEncode(w http.ResponseWriter, latest string) error {
	_, err := w.Write([]byte(`{"latest":` + strconv.Quote(latest) + `}`))
	return err
}
