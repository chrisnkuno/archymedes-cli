package tool

import (
	"context"
	"slices"
	"testing"
)

func fake(name, description string, deferred bool) *Tool {
	return &Tool{Name: name, Description: description, Deferred: deferred, Effect: EffectNone, Run: func(context.Context, Context, Args) Result { return Text(name) }}
}

func visibleNames(c *Catalog) []string {
	var out []string
	for _, t := range c.Visible() {
		out = append(out, t.Name)
	}
	return out
}

func TestDeferredToolsAreHiddenUntilSearchedAndSearchDisappearsWhenNoneRemain(t *testing.T) {
	c := NewCatalog(fake("read_file", "read a file", false), fake("jira_create_issue", "create an issue in Jira", true))
	if got := visibleNames(c); !slices.Equal(got, []string{"read_file", SearchToolName}) {
		t.Fatalf("visible = %v", got)
	}
	search, ok := c.Lookup(SearchToolName)
	if !ok {
		t.Fatal("tool_search not found while a tool is deferred")
	}
	result := search.Run(context.Background(), Context{}, Args{"query": "create jira issue"})
	if result.IsError || !slices.Contains(result.Data["loaded"].([]string), "jira_create_issue") {
		t.Fatalf("search result = %+v", result)
	}
	if got := visibleNames(c); !slices.Equal(got, []string{"read_file", "jira_create_issue"}) {
		t.Fatalf("after search, visible = %v", got)
	}
}

func TestNoSearchToolWithoutDeferredTools(t *testing.T) {
	c := NewCatalog(fake("read_file", "read", false))
	if _, ok := c.Lookup(SearchToolName); ok {
		t.Fatal("tool_search offered with nothing deferred")
	}
	if got := visibleNames(c); !slices.Equal(got, []string{"read_file"}) {
		t.Fatalf("visible = %v", got)
	}
}

func TestLoadByExactNameAndOnlyOnce(t *testing.T) {
	c := NewCatalog(fake("a", "x", true))
	if !c.Load("a") || c.Load("a") || c.Load("missing") {
		t.Fatal("Load should report true once, for a deferred tool only")
	}
}

func TestBM25RanksTheBetterMatchFirstAndDropsNonMatches(t *testing.T) {
	docs := []*Tool{
		fake("slack_send", "send a message to a Slack channel", true),
		fake("gh_pr", "open a pull request on GitHub", true),
		fake("calendar", "list events", true),
	}
	got := RankBM25("open a github pull request", docs, 5)
	if len(got) == 0 || got[0].Name != "gh_pr" {
		t.Fatalf("ranked = %v", names(got))
	}
	for _, tool := range got {
		if tool.Name == "calendar" {
			t.Fatal("a tool sharing no word with the query was returned")
		}
	}
	if got := RankBM25("", docs, 5); got != nil {
		t.Fatal("an empty query matched")
	}
}

func TestReplacingAToolKeepsItsPlace(t *testing.T) {
	c := NewCatalog(fake("a", "1", false), fake("b", "2", false))
	c.Add(fake("a", "3", false))
	all := c.All()
	if len(all) != 2 || all[0].Name != "a" || all[0].Description != "3" {
		t.Fatalf("all = %+v", all)
	}
}

func TestParseArgs(t *testing.T) {
	if args, err := ParseArgs(""); err != nil || len(args) != 0 {
		t.Fatal("empty arguments should be an empty object")
	}
	if _, err := ParseArgs("[1]"); err == nil {
		t.Fatal("an array is not arguments")
	}
	if args, _ := ParseArgs(`{"n": 3}`); func() int { n, _ := IntArg(args, "n"); return n }() != 3 {
		t.Fatal("IntArg")
	}
}

func TestConformToolSearch(t *testing.T) {
	c := NewCatalog(fake("a", "x", true))
	search, _ := c.Lookup(SearchToolName)
	if problems := Contract(search); len(problems) > 0 {
		t.Fatal(problems)
	}
}
