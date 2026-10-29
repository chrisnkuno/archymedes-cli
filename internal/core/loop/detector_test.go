package loop

import "testing"

// TestDetectorTreatsProgressAsNews: polling a command that keeps printing never trips the
// detector, while polling one that has gone quiet trips it exactly as any repeated call does.
func TestDetectorTreatsProgressAsNews(t *testing.T) {
	args := map[string]any{"id": "cmd1"}
	moving := NewDetector()
	for i := range 20 {
		if v := moving.Observe("command_output", args, "running "+string(rune('a'+i))); v.Note != "" || v.Stop {
			t.Fatalf("poll %d saw new output, yet the detector judged it a repeat: %+v", i, v)
		}
	}
	quiet := NewDetector()
	var verdicts []Verdict
	for range 5 {
		verdicts = append(verdicts, quiet.Observe("command_output", args, "exited 0 120 120"))
	}
	if verdicts[1].Note != "" || verdicts[2].Note == "" || verdicts[2].Stop || !verdicts[4].Stop {
		t.Fatalf("a quiet poll repeated: note at the third, stop at the fifth; got %+v", verdicts)
	}
}

// TestDetectorWithoutProgressIsUnchanged: a tool that reports no progress is judged on its name and
// arguments alone, as before.
func TestDetectorWithoutProgressIsUnchanged(t *testing.T) {
	d := NewDetector()
	args := map[string]any{"path": "a.go"}
	for i := range 4 {
		d.Observe("read_file", args, "")
		if i == 1 {
			d.Changed() // an edit between: the reads after it are new
		}
	}
	if v := d.Observe("read_file", args, ""); v.Note == "" || v.Stop {
		t.Fatalf("three identical reads since the last change earn the note: %+v", v)
	}
}
