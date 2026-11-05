package llm

import (
	"math"
	"slices"
	"testing"
)

// Known models, prices and what a model id says (size, free, fit), against the TypeScript
// agent's answers (testdata/catalog.json; WS-50.4).

func TestKnownModelsAndPricesAreTypeScripts(t *testing.T) {
	f := loadCatalog(t)
	for _, p := range Providers {
		if got := KnownModels(p); !slices.Equal(got, f.Known[p.ID]) {
			t.Errorf("%s known models %v, TypeScript %v", p.ID, got, f.Known[p.ID])
		}
	}
	for _, want := range f.Prices {
		got, ok := CatalogPrices(want.Provider, want.Model, want.AsOf)
		if text := DescribePrice(got, ok); text != want.Price {
			t.Errorf("%s %s on %s: %q, TypeScript %q", want.Provider, want.Model, want.AsOf, text, want.Price)
		}
		if ok != (want.Input != nil) || (ok && (got.Input != *want.Input || got.Output != *want.Output)) {
			t.Errorf("%s %s on %s: %+v %v, TypeScript %v/%v", want.Provider, want.Model, want.AsOf, got, ok, want.Input, want.Output)
		}
		if ok && (want.Cached == nil) != (got.Cached < 0) {
			t.Errorf("%s %s: cached %d, TypeScript %v", want.Provider, want.Model, got.Cached, want.Cached)
		}
	}
}

func TestModelIDRulesAreTypeScripts(t *testing.T) {
	f := loadCatalog(t)
	for _, want := range f.Models {
		size, ok := ModelSizeBillions(want.ID)
		if ok != (want.Size != nil) || (ok && math.Abs(size-*want.Size) > 1e-9) {
			t.Errorf("%s: size %v %v, TypeScript %v", want.ID, size, ok, want.Size)
		}
		profile := FreeProfile(want.ID)
		if IsFreeModel(want.ID) != want.Free || IsSmallModel(want.ID) != want.Small || IsConversational(want.ID) != want.Conversational ||
			!slices.Equal(PriceAliases(want.ID), want.Aliases) || profile.Fit != want.Fit || profile.Note != want.Note {
			t.Errorf("%s: free %v small %v chat %v aliases %v fit %v; TypeScript %+v", want.ID, IsFreeModel(want.ID), IsSmallModel(want.ID),
				IsConversational(want.ID), PriceAliases(want.ID), profile, want)
		}
	}
	// Every measured row is reachable, with the fits the router and the picker know.
	for id, p := range freeProfiles {
		if !IsFreeModel(id) || !slices.Contains([]string{"agent", "busy", "slow", "apps-only", "small"}, p.Fit) {
			t.Errorf("%s: %+v", id, p)
		}
	}
}

func TestFormatMoney(t *testing.T) {
	for _, c := range []struct {
		micros   int64
		currency string
		want     string
	}{{3_000_000, "USD", "$3.00"}, {280_000, "USD", "$0.28"}, {28_000, "USD", "$0.03"}, {2_800, "USD", "$0.0028"}, {5_000, "USD", "$0.005"}, {1_234_567_000, "USD", "$1,234.57"}, {1_610_000_000, "RWF", "RWF 1,610"}, {0, "USD", "$0.00"}} {
		if got := FormatMoney(c.micros, c.currency); got != c.want {
			t.Errorf("%d %s: %q, want %q", c.micros, c.currency, got, c.want)
		}
	}
}
