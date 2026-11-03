package tui

import (
	"fmt"
	"strings"
	"testing"
)

// Streaming into a long reply: sixty paragraphs and a code block already on screen, and a few
// more words arriving, as they do per network chunk. What one chunk costs should not grow with
// what came before it.
func BenchmarkStreamedChunkLongReply(b *testing.B) {
	m := longSession(b, 3)
	a := &assistantItem{open: true}
	for i := range 60 {
		a.append(fmt.Sprintf("Paragraph %d explains one more part of the change, with **some** emphasis and `code`.\n\n", i))
		if i == 30 {
			a.append("```go\n" + strings.Repeat("x := compute(y)\n", 12) + "```\n\n")
		}
	}
	m.tr.items = append(m.tr.items, a)
	m.View()
	b.ResetTimer()
	for range b.N {
		a.append("more words ")
		m.View()
	}
}
