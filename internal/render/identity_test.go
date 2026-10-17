package render

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

// testdata/geometry.json is renderGeometry's output from the TypeScript front end; regenerate it
// from packages/friday-cli/src/render/identity.ts if the mark ever changes there.
func TestGeometryMatchesTheTypeScriptMark(t *testing.T) {
	data, err := os.ReadFile("testdata/geometry.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden map[string][]string
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	for key, want := range golden {
		ascii := strings.HasPrefix(key, "ascii")
		angle, _ := strconv.ParseFloat(strings.TrimPrefix(key, "ascii"), 64)
		got := Geometry(angle, ascii)
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Fatalf("angle %s:\ngot\n%s\nwant\n%s", key, strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
	}
}
