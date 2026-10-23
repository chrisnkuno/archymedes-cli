package tool

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"unicode"
)

// SearchToolName is the tool that finds deferred tools.
const SearchToolName = "tool_search"

// Catalog is the tools one run may call, and which of them the model is sent.
//
// A tool is sent with every request unless it is deferred. Deferred tools cost nothing per request:
// the model finds them with tool_search, which loads the matches into the set sent from the next
// step on. Codex does this for MCP tools (BM25 over deferred tools), and Claude Code for its own;
// a session with a few dozen MCP tools would otherwise resend all their schemas on every call.
type Catalog struct {
	mu     sync.Mutex
	tools  []*Tool
	byName map[string]*Tool
	loaded map[string]bool
}

// NewCatalog holds tools in the order given; a later tool with the same name replaces an earlier one.
func NewCatalog(tools ...*Tool) *Catalog {
	c := &Catalog{byName: map[string]*Tool{}, loaded: map[string]bool{}}
	for _, t := range tools {
		c.add(t)
	}
	return c
}

func (c *Catalog) add(t *Tool) {
	if old, ok := c.byName[t.Name]; ok {
		for i, existing := range c.tools {
			if existing == old {
				c.tools[i] = t
			}
		}
	} else {
		c.tools = append(c.tools, t)
	}
	c.byName[t.Name] = t
}

// Add registers more tools (an MCP server that connected late).
func (c *Catalog) Add(tools ...*Tool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, t := range tools {
		c.add(t)
	}
}

// Lookup finds a tool by name, sent or deferred; tool_search itself is found too.
func (c *Catalog) Lookup(name string) (*Tool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if name == SearchToolName && c.hasDeferredLocked() {
		return c.searchTool(), true
	}
	t, ok := c.byName[name]
	return t, ok
}

// Load makes a deferred tool part of what is sent; it reports whether it was deferred and unloaded.
func (c *Catalog) Load(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, ok := c.byName[name]
	if !ok || !t.Deferred || c.loaded[name] {
		return false
	}
	c.loaded[name] = true
	return true
}

// All is every tool, sent or not, in order.
func (c *Catalog) All() []*Tool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*Tool(nil), c.tools...)
}

// Visible is what the model is sent this step: every tool that is not deferred, the deferred ones
// it has loaded, and tool_search while anything is still deferred and unloaded.
func (c *Catalog) Visible() []*Tool {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []*Tool
	pending := false
	for _, t := range c.tools {
		if !t.Deferred || c.loaded[t.Name] {
			out = append(out, t)
		} else {
			pending = true
		}
	}
	if pending {
		out = append(out, c.searchTool())
	}
	return out
}

// Deferred lists the names still waiting to be found.
func (c *Catalog) Deferred() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var names []string
	for _, t := range c.tools {
		if t.Deferred && !c.loaded[t.Name] {
			names = append(names, t.Name)
		}
	}
	return names
}

func (c *Catalog) hasDeferredLocked() bool {
	for _, t := range c.tools {
		if t.Deferred {
			return true
		}
	}
	return false
}

// Filter is a new catalog with the tools keep accepts, sharing nothing with this one.
func (c *Catalog) Filter(keep func(*Tool) bool) *Catalog {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := NewCatalog()
	for _, t := range c.tools {
		if keep(t) {
			out.add(t)
		}
	}
	return out
}

// searchTool is built per call so it closes over this catalog.
func (c *Catalog) searchTool() *Tool {
	return &Tool{
		Name:         SearchToolName,
		Description:  "Find more tools by what they do. Some tools are not listed until searched for; matches can be called from your next step.",
		Schema:       objectSchema(map[string]any{"query": map[string]any{"type": "string", "description": "What the tool should do, in a few words."}, "limit": map[string]any{"type": "integer"}}, "query"),
		Capability:   CapPlanning,
		Effect:       EffectNone,
		ParallelSafe: true,
		Run: func(_ context.Context, _ Context, args Args) Result {
			query := StringArg(args, "query")
			limit, ok := IntArg(args, "limit")
			if !ok || limit <= 0 {
				limit = 5
			}
			found := c.search(query, limit)
			if len(found) == 0 {
				return Text(fmt.Sprintf("No tool matches %q. Still unlisted: %s.", query, strings.Join(c.Deferred(), ", ")))
			}
			var lines []string
			for _, t := range found {
				c.Load(t.Name)
				lines = append(lines, fmt.Sprintf("- %s: %s", t.Name, t.Description))
			}
			return Result{Content: "Loaded; call them from your next step:\n" + strings.Join(lines, "\n"), Data: map[string]any{"loaded": names(found)}}
		},
	}
}

func names(tools []*Tool) []string {
	out := make([]string, len(tools))
	for i, t := range tools {
		out[i] = t.Name
	}
	return out
}

// search ranks deferred tools against query with BM25 over name and description words.
func (c *Catalog) search(query string, limit int) []*Tool {
	c.mu.Lock()
	var docs []*Tool
	for _, t := range c.tools {
		if t.Deferred {
			docs = append(docs, t)
		}
	}
	c.mu.Unlock()
	return RankBM25(query, docs, limit)
}

// RankBM25 orders tools by how well name and description answer query; tools that match no word
// are left out. An exact name in the query always ranks first.
func RankBM25(query string, docs []*Tool, limit int) []*Tool {
	terms := words(query)
	if len(terms) == 0 || len(docs) == 0 {
		return nil
	}
	const k1, b = 1.2, 0.75
	tokens := make([][]string, len(docs))
	total := 0
	df := map[string]int{}
	for i, t := range docs {
		tokens[i] = words(t.Name + " " + t.Description)
		total += len(tokens[i])
		seen := map[string]bool{}
		for _, w := range tokens[i] {
			if !seen[w] {
				seen[w] = true
				df[w]++
			}
		}
	}
	avg := float64(total) / float64(len(docs))
	type scored struct {
		t     *Tool
		score float64
	}
	var ranked []scored
	lowered := strings.ToLower(query)
	for i, t := range docs {
		tf := map[string]int{}
		for _, w := range tokens[i] {
			tf[w]++
		}
		score := 0.0
		for _, term := range terms {
			f := float64(tf[term])
			if f == 0 {
				continue
			}
			idf := math.Log(1 + (float64(len(docs))-float64(df[term])+0.5)/(float64(df[term])+0.5))
			score += idf * f * (k1 + 1) / (f + k1*(1-b+b*float64(len(tokens[i]))/avg))
		}
		if strings.Contains(lowered, strings.ToLower(t.Name)) {
			score += 100
		}
		if score > 0 {
			ranked = append(ranked, scored{t, score})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
	var out []*Tool
	for i := 0; i < len(ranked) && i < limit; i++ {
		out = append(out, ranked[i].t)
	}
	return out
}

// words splits on anything that is not a letter or digit, so `read_file` is "read" and "file".
func words(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

// ObjectSchema builds the schema of an arguments object: properties, then the required names.
func ObjectSchema(properties map[string]any, required ...string) map[string]any {
	return objectSchema(properties, required...)
}

func objectSchema(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}
