import { afterEach, describe, expect, it } from "vitest";
import { buildPalette, colorCode, findBuiltinTheme } from "../theme/theme";
import {
  SYNTAX_COLORS,
  codeStyle,
  codeStyleFromEnvironment,
  grammarName,
  highlightSyntax,
  newSyntaxState,
  schemeFor,
  setCodeStyle,
  tokenizeLine,
  type SyntaxKind,
} from "./syntax";
import { renderMarkdown } from "./markdown";
import { highlightCode } from "./code-view";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const kindOf = (line: string, language: string, text: string): SyntaxKind | undefined =>
  tokenizeLine(line, language).find((token) => token.text === text)?.kind;

const dark = buildPalette(findBuiltinTheme("archymedes")!, "truecolor");
const light = buildPalette(findBuiltinTheme("parchment")!, "truecolor");

afterEach(() => setCodeStyle({ colors: "vscode", lineNumbers: true }));

describe("tokenizing", () => {
  it("separates control keywords from declaration keywords", () => {
    expect(kindOf("if (x) return y;", "ts", "if")).toBe("control");
    expect(kindOf("if (x) return y;", "ts", "return")).toBe("control");
    expect(kindOf("const value = 1;", "ts", "const")).toBe("declaration");
    expect(kindOf("def run(self):", "python", "def")).toBe("declaration");
    expect(kindOf("for item in items:", "py", "for")).toBe("control");
  });

  it("finds strings, numbers and comments", () => {
    expect(kindOf('const s = "hi"; // note', "ts", '"hi"')).toBe("string");
    expect(kindOf("const n = 42;", "ts", "42")).toBe("number");
    expect(kindOf("x = 1  # the answer", "python", "# the answer")).toBe("comment");
    expect(kindOf("SELECT 1 -- why", "sql", "-- why")).toBe("comment");
  });

  it("colours calls, types, properties and decorators", () => {
    expect(kindOf("console.log(value)", "js", "log")).toBe("function");
    expect(kindOf("const user: User = load();", "ts", "User")).toBe("type");
    expect(kindOf("const user: User = load();", "ts", "load")).toBe("function");
    expect(kindOf("return user.name;", "ts", "name")).toBe("property");
    expect(kindOf("@Component()", "ts", "@Component")).toBe("decorator");
  });

  it("keeps comment markers inside strings out of comments", () => {
    expect(tokenizeLine('const url = "https://x/#frag";', "ts").some((token) => token.kind === "comment")).toBe(false);
  });

  it("carries a block comment across lines", () => {
    const state = newSyntaxState();
    expect(tokenizeLine("/* start", "ts", state).at(-1)?.kind).toBe("comment");
    expect(tokenizeLine("still a comment", "ts", state)).toEqual([{ text: "still a comment", kind: "comment" }]);
    expect(kindOf("end */ const x = 1;", "ts", "const")).toBe("declaration");
  });

  it("knows enough of the other languages to be worth it", () => {
    expect(kindOf('{ "name": "x" }', "json", '"name"')).toBe("property");
    expect(kindOf('{ "name": "x" }', "json", '"x"')).toBe("string");
    expect(kindOf("name: archymedes", "yaml", "name")).toBe("property");
    expect(kindOf("echo $HOME", "bash", "$HOME")).toBe("variable");
    expect(kindOf("Get-ChildItem -Path .", "powershell", "Get-ChildItem")).toBe("function");
    expect(kindOf("fn main() -> Result<()> {", "rust", "fn")).toBe("declaration");
    expect(kindOf('<div class="x">', "html", "div")).toBe("tag");
    expect(kindOf('<div class="x">', "html", "class")).toBe("attribute");
    expect(kindOf("  color: red;", "css", "color")).toBe("property");
    expect(kindOf("+added", "diff", "+added")).toBe("inserted");
  });

  it("maps fence labels and file languages to a grammar", () => {
    expect(grammarName("tsx")).toBe("javascript");
    expect(grammarName("PowerShell")).toBe("powershell");
    expect(grammarName("whatever")).toBe("generic");
    expect(grammarName(undefined)).toBe("generic");
  });
});

describe("painting", () => {
  it("uses Dark+ on a dark theme and Light+ on a light one", () => {
    expect(schemeFor(dark)).toBe("dark");
    expect(schemeFor(light)).toBe("light");
    expect(schemeFor(undefined)).toBe("dark");
    const line = "const s = 1;";
    expect(highlightSyntax(line, { language: "ts", depth: "truecolor", palette: dark })).toContain(colorCode(SYNTAX_COLORS.dark.declaration, "truecolor"));
    expect(highlightSyntax(line, { language: "ts", depth: "truecolor", palette: light })).toContain(colorCode(SYNTAX_COLORS.light.declaration, "truecolor"));
  });

  it("paints each category in its own colour", () => {
    const painted = highlightSyntax('if (ok) call("s", 2) // c', { language: "ts", depth: "truecolor", palette: dark });
    for (const kind of ["control", "function", "string", "number", "comment", "punctuation"] as const) {
      expect(painted, kind).toContain(colorCode(SYNTAX_COLORS.dark[kind], "truecolor"));
    }
    expect(plain(painted)).toBe('if (ok) call("s", 2) // c');
  });

  it("degrades to 256 colours and passes through untouched without colour", () => {
    const line = 'const s = "x";';
    expect(highlightSyntax(line, { language: "ts", depth: "ansi256", palette: dark })).toMatch(/\x1b\[38;5;\d+m/);
    expect(highlightSyntax(line, { language: "ts", depth: "none", palette: dark })).toBe(line);
    expect(highlightSyntax(line, { language: "ts", depth: "none", band: "add", padTo: 40 })).toBe(line);
  });

  it("draws a diff band across the row, with the changed run stronger", () => {
    const banded = highlightSyntax("let a = 1;", {
      language: "rs", depth: "truecolor", palette: dark, band: "add", padTo: 14,
      segments: [{ text: "let a = ", changed: false }, { text: "1", changed: true }, { text: ";", changed: false }],
    });
    expect(banded).toMatch(/\x1b\[48;2;/);
    expect(new Set(banded.match(/\x1b\[48;2;[0-9;]+m/g)).size).toBe(2);
    expect(plain(banded)).toBe("let a = 1;    ");
  });
});

describe("code style", () => {
  it("reads its settings from the environment, defaulting to VS Code colours with numbers", () => {
    expect(codeStyleFromEnvironment({})).toEqual({ colors: "vscode", lineNumbers: true });
    expect(codeStyleFromEnvironment({ ARCHYMEDES_CODE_COLORS: "theme", ARCHYMEDES_CODE_LINE_NUMBERS: "off" })).toEqual({ colors: "theme", lineNumbers: false });
  });

  it("numbers fenced code and colours it like an editor", () => {
    const rendered = renderMarkdown("```ts\nconst a = 1;\nconst b = 2;\n```", { width: 60, depth: "truecolor", palette: dark });
    expect(plain(rendered)).toContain("│   1  const a = 1;");
    expect(plain(rendered)).toContain("│   2  const b = 2;");
    expect(rendered).toContain(colorCode(SYNTAX_COLORS.dark.declaration, "truecolor"));
  });

  it("leaves the numbers out and the theme colours in when asked", () => {
    setCodeStyle({ colors: "theme", lineNumbers: false });
    expect(codeStyle()).toEqual({ colors: "theme", lineNumbers: false });
    const rendered = renderMarkdown("```ts\nconst a = 1;\n```", { width: 60, depth: "truecolor", palette: dark });
    expect(plain(rendered)).toContain("│ const a = 1;");
    expect(rendered).toContain(dark.success);
    expect(highlightCode("const a = 1;", "truecolor", dark)).toContain(dark.primary);
  });
});
