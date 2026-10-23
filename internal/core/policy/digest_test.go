package policy

import (
	"context"
	"math"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// The expected digests were computed by the TypeScript actionDigest (permissions.ts) for the same
// calls, so a decision persisted by either engine is found by the other.
func TestActionDigestMatchesTypeScript(t *testing.T) {
	cases := []struct {
		call tool.Call
		tool *tool.Tool
		want string
	}{
		{
			newCall("run_command", tool.Args{"command": "npm test", "timeoutMs": float64(1000)}),
			newTool("run_command", withCapability(tool.CapTerminal)),
			"afdca1ea78e0aef649dcc9009f9d7e447831595053c19f0fded049b67e7941d4",
		},
		{
			newCall("edit_file", tool.Args{
				"path": "a.ts", "10": float64(1), "2": "x", "B": true, "a": nil,
				"_z":  []any{float64(1), 2.5, "é <>&\u0001"},
				"a-b": map[string]any{"y": 1e21, "x": 1e-7, "w": math.Copysign(0, -1), "v": 0.1},
			}),
			newTool("edit_file"),
			"2f6d7a40d77b81fd85781dd3ba1a597cf60fac39aa74f05d8d6743f078b8412e",
		},
		{
			newCall("search", nil),
			newTool("search", withEffect(tool.EffectExternal), withProvenance("mcp", "docs")),
			"8a36fa3b7e4ebf8e36d39cdf103867366c2221cc27863ad9260db1d9d864496f",
		},
		{
			tool.Call{ID: "1", Name: "run_command"},
			newTool("run_command"),
			"ac7938c890923d361d98e06fb9c10ceb571cc346e4fc4b76f41ed711774d1080",
		},
	}
	for i, c := range cases {
		if got := ActionDigest(c.call, c.tool); got != c.want {
			t.Errorf("case %d: digest %s, want %s", i, got, c.want)
		}
	}
}

func TestActionDigest(t *testing.T) {
	d := func(call tool.Call, tl *tool.Tool) string { return ActionDigest(call, tl) }
	run := newTool("run_command", withCapability(tool.CapTerminal))

	if d(newCall("run_command", nil), newTool("run_command")) == d(newCall("run_command", nil), newTool("run_command", withProvenance("skill", "local-skills"))) {
		t.Error("provenance does not change the digest")
	}
	if d(newCall("search", nil), newTool("search", withProvenance("mcp", "server-a"))) == d(newCall("search", nil), newTool("search", withProvenance("mcp", "server-b"))) {
		t.Error("provider id does not change the digest")
	}
	if d(newCall("run_command", nil), newTool("run_command")) != d(newCall("run_command", nil), newTool("run_command", withProvenance("built-in", ""))) {
		t.Error("absent and explicit built-in differ")
	}
	first := d(newCall("run_command", tool.Args{"command": "bun test", "timeoutMs": float64(1000)}), run)
	reordered := d(newCall("run_command", tool.Args{"timeoutMs": float64(1000), "command": "bun test"}), run)
	changed := d(newCall("run_command", tool.Args{"command": "bun run build", "timeoutMs": float64(1000)}), run)
	if first != reordered || changed == first {
		t.Error("key order or command change")
	}

	// From adversarial-policy.test.ts: digests resist tampering.
	edit := newTool("edit_file")
	base := d(newCall("edit_file", tool.Args{"path": "a.ts", "context": map[string]any{"line": 10.0, "hint": map[string]any{"column": 2.0}}}), edit)
	nested := d(newCall("edit_file", tool.Args{"path": "a.ts", "context": map[string]any{"line": 10.0, "hint": map[string]any{"column": 3.0}}}), edit)
	if base == nested {
		t.Error("nested change")
	}
	grep := newTool("grep_files", withCapability(tool.CapRead))
	g := d(newCall("grep_files", tool.Args{"include": []any{"a.ts", "b.ts"}}), grep)
	if g == d(newCall("grep_files", tool.Args{"include": []any{"b.ts", "a.ts"}}), grep) || g == d(newCall("grep_files", tool.Args{"include": []any{"a.ts", "c.ts"}}), grep) {
		t.Error("array order or contents")
	}
	args := tool.Args{"path": "a.ts"}
	if d(newCall("write_file", args), newTool("write_file")) == d(newCall("edit_file", args), newTool("edit_file")) {
		t.Error("tools collide")
	}
	cmd := tool.Args{"command": "npm test"}
	if d(newCall("run_command", cmd), newTool("run_command", withCapability(tool.CapTerminal))) == d(newCall("run_command", cmd), newTool("run_command", withCapability(tool.CapWrite))) {
		t.Error("capabilities collide")
	}
	if d(newCall("write_file", tool.Args{"path": "a.ts", "content": "x"}), newTool("write_file")) == d(newCall("write_file", tool.Args{"path": "a.ts", "content": "x", "encoding": "utf8"}), newTool("write_file")) {
		t.Error("added key")
	}
	// Typed Go values digest like their JSON form.
	if d(newCall("x", tool.Args{"n": 3, "l": []string{"a"}}), edit) != d(newCall("x", tool.Args{"n": 3.0, "l": []any{"a"}}), edit) {
		t.Error("typed values differ from decoded JSON")
	}
}

func TestActionDigestRefusesNonFinite(t *testing.T) {
	call := newCall("write_file", tool.Args{"n": math.Inf(1)})
	if ActionDigest(call, newTool("write_file")) != "" {
		t.Error("digested a non-finite number")
	}
	l := NewLedger(Build, answering(Allow).prompt)
	if ok, err := l.Decide(context.Background(), call, newTool("write_file")); ok || err == nil {
		t.Errorf("ok=%v err=%v", ok, err)
	}
}

func TestJSKeyOrder(t *testing.T) {
	// Pairs from localeCompare in Node 22 (ICU root collation): a sorts before b.
	for _, pair := range [][2]string{
		{"a", "A"}, {"a_b", "ab"}, {"a-b", "ab"}, {"aB", "Ab"}, {"a_", "a1"}, {"timeout_ms", "timeoutMs"},
		{"x", "x1"}, {"a b", "ab"}, {"a-c", "ab"}, {"co-op", "coop"}, {"co_op", "coop"}, {"Ab", "b"},
	} {
		if !jsKeyLess(pair[0], pair[1]) || jsKeyLess(pair[1], pair[0]) {
			t.Errorf("want %q before %q", pair[0], pair[1])
		}
	}
	for n, want := range map[float64]string{1e21: "1e+21", 1e-7: "1e-7", 0.1: "0.1", 1000: "1000", -0.0: "0", 123e-20: "1.23e-18", 1.5e300: "1.5e+300", 0.000001: "0.000001"} {
		if got := jsNumberString(n); got != want {
			t.Errorf("jsNumberString(%v) = %q, want %q", n, got, want)
		}
	}
}
