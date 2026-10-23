package conform

import (
	"strings"
	"testing"
)

func TestDocStructure(t *testing.T) {
	clean(t, DocStructure("# Title\n\nWhat it is for.\n\n## One\n\nText.\n\n| a | b |\n| --- | --- |\n| 1 | `x|y` |\n"))
	has(t, DocStructure("# A\n\nx\n\n# B\n"), "2 titles")
	has(t, DocStructure("# A\n\nx\n\n### Deep\n"), "skips from level 1 to 3")
	has(t, DocStructure("# A\n\n## B\n"), "no sentence under the title")
	has(t, DocStructure("# A\n\nx\n\n| a | b |\n| --- | --- |\n| 1 |\n"), "1 columns, its header 2")
	long := "# A\n\nx\n\n" + strings.Repeat("## S\n\ny\n\n", 6)
	has(t, DocStructure(long), "no list of them")
	listed := "# A\n\nx\n\n- [a](#a)\n- [b](#b)\n- [c](#c)\n\n" + strings.Repeat("## S\n\ny\n\n", 6)
	clean(t, DocStructure(listed))
	clean(t, DocStructure("# A\n\nx\n\n```\n# not a heading\n```\n"))
}

func TestDocProse(t *testing.T) {
	clean(t, DocProse("# A\n\nFriday reads the file. Then it edits it, e.g. the config.\n"))
	has(t, DocProse("# A\n\nIt simply works.\n"), "filler")
	has(t, DocProse("# A\n\nThe LLM answers.\n"), "vocabulary")
	has(t, DocProse("# A\n\nPress Esc to stop.\n"), "as pressed")
	clean(t, DocProse("# A\n\nPress esc to stop, or `Esc` in code.\n"))
	has(t, DocProse("# A\n\n"+strings.Repeat("word ", 40)+"end.\n"), "41 words")
	clean(t, DocProse("# A\n\n"+strings.Repeat("word ", 39)+"end.\n"))
	clean(t, DocProse("# A\n\n```\nsimply just very\n```\n"))
}

func TestGoErrorsAndToolText(t *testing.T) {
	clean(t, GoError("no session %s"))
	clean(t, GoError("ARCHYMEDES_AGENT is not a JSON array of strings: %s"))
	clean(t, GoError("Anthropic needs ANTHROPIC_API_KEY"))
	has(t, GoError("Command is empty"), "starts with a capital")
	has(t, GoError("bad thing."), "punctuation")
	clean(t, ToolText("`command` is required"))
	clean(t, ToolText("Refused: 'rm -rf /' can destroy work."))
	has(t, ToolText("command is required"), "lower case")
	has(t, ToolText("Error: x"), "already marked")
}
