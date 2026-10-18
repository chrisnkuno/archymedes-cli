package theme

import (
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestEveryBuiltinResolvesEveryRole(t *testing.T) {
	for _, name := range Names() {
		th, ok := Load(name)
		if !ok || th.Name != name {
			t.Fatalf("%s did not load", name)
		}
		for role, c := range map[string]any{"primary": th.Primary, "text": th.Text, "muted": th.Muted, "error": th.Error, "border": th.BorderColor} {
			if c == nil {
				t.Fatalf("%s: %s is nil", name, role)
			}
		}
	}
}

func TestUnknownThemeFallsBackToTheDefaultAndSaysSo(t *testing.T) {
	th, ok := Load("no-such-theme")
	if ok || th.Name != DefaultName {
		t.Fatalf("got %q ok=%v", th.Name, ok)
	}
	if th, ok := Load("  Archymedes-Blue "); !ok || th.Name != "archymedes-blue" {
		t.Fatal("names are matched case- and space-insensitively")
	}
}

func TestOnlyParchmentIsLight(t *testing.T) {
	for _, name := range Names() {
		th, _ := Load(name)
		if th.Light != (name == "parchment") {
			t.Fatalf("%s light=%v", name, th.Light)
		}
	}
}

func TestDesignPiecesKeepTheTextAndItsWidth(t *testing.T) {
	for _, name := range Names() {
		th, _ := Load(name)
		g := Gradient("Friday ◇", th.Primary, th.Secondary, true)
		if ansi.Strip(g) != "Friday ◇" {
			t.Fatalf("%s gradient changed the text: %q", name, ansi.Strip(g))
		}
		if w := ansi.StringWidth(th.Pill("build", th.ModeColor("build"))); w != len("build")+2 {
			t.Fatalf("%s pill is %d wide", name, w)
		}
		if th.Tint(th.Success, 0) == nil || th.Tint(th.Success, 2) == nil {
			t.Fatal("tint out of range")
		}
	}
}
