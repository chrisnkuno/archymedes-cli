import { ITALIC, RESET, paint, paintAll } from "../text/ansi";
import type { ColorDepth } from "../text/color-depth";
import { colorCode, parseColor, rgbTo256, type Palette } from "../theme/theme";

/**
 * Code coloured the way most people already read code: VS Code's Dark+ and Light+ colours.
 *
 * The older highlighter in `code-view.ts` paints four categories from the theme's own roles, which
 * keeps a transcript in one palette but makes code look like nothing anyone edits in. This one
 * paints the categories a reader's eye has been trained on — purple control flow, blue declarations,
 * orange strings, yellow calls, teal types — and picks the light or dark set from the theme's own
 * background, so `parchment` gets Light+ and every dark theme gets Dark+.
 *
 * Still a line lexer rather than a parser, and deliberately so: it colours a quotation, never a
 * decision, so being approximate is safe and a grammar engine would be a dependency for nothing.
 * The only state carried between lines is "inside a block comment" and "inside a triple-quoted
 * string", which is what keeps a multi-line doc comment from turning into code halfway down.
 *
 * Every colour goes through `colorCode`, so a 256-colour terminal gets the nearest swatch and a
 * terminal with no colour gets the line back untouched.
 */

export type SyntaxKind =
  | "plain"
  | "control"
  | "declaration"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "property"
  | "decorator"
  | "punctuation"
  | "variable"
  | "tag"
  | "attribute"
  | "inserted"
  | "deleted"
  | "meta";

export type SyntaxToken = { text: string; kind: SyntaxKind };

/** Carried between the lines of one block; a fresh one per block. */
export type SyntaxState = { blockEnd?: string; blockKind?: "comment" | "string" };

export function newSyntaxState(): SyntaxState {
  return {};
}

export type SyntaxScheme = "dark" | "light";

/** VS Code's own Dark+ and Light+ values, category by category. */
export const SYNTAX_COLORS: Record<SyntaxScheme, Record<Exclude<SyntaxKind, "plain">, string>> = {
  dark: {
    control: "#C586C0",
    declaration: "#569CD6",
    string: "#CE9178",
    number: "#B5CEA8",
    comment: "#6A9955",
    function: "#DCDCAA",
    type: "#4EC9B0",
    property: "#9CDCFE",
    decorator: "#DCDCAA",
    punctuation: "#808080",
    variable: "#9CDCFE",
    tag: "#569CD6",
    attribute: "#9CDCFE",
    inserted: "#81B88B",
    deleted: "#E06C75",
    meta: "#C586C0",
  },
  light: {
    control: "#AF00DB",
    declaration: "#0000FF",
    string: "#A31515",
    number: "#098658",
    comment: "#008000",
    function: "#795E26",
    type: "#267F99",
    property: "#001080",
    decorator: "#795E26",
    punctuation: "#6E6E6E",
    variable: "#001080",
    tag: "#800000",
    attribute: "#E50000",
    inserted: "#587C0C",
    deleted: "#AD0707",
    meta: "#AF00DB",
  },
};

/** Diff row backgrounds: the whole line, and the stronger run that actually changed inside it. */
const DIFF_BACKGROUNDS: Record<SyntaxScheme, { add: string; addStrong: string; remove: string; removeStrong: string }> = {
  dark: { add: "#1E3A26", addStrong: "#2E6B3E", remove: "#4B1D1D", removeStrong: "#7A2B2B" },
  light: { add: "#E6FFEC", addStrong: "#ABF2BC", remove: "#FFEBE9", removeStrong: "#FFC1BD" },
};

/** Whether a theme's background is light, read from its `--bg` token. Dark when nobody said. */
export function schemeFor(palette: Palette | undefined): SyntaxScheme {
  const background = palette?.tokens?.bg ?? palette?.bg;
  if (!background) return "dark";
  const parsed = parseColor(background);
  if (parsed === undefined) return "dark";
  if (typeof parsed === "number") return parsed === 7 || parsed === 15 ? "light" : "dark";
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(parsed.r) + 0.7152 * channel(parsed.g) + 0.0722 * channel(parsed.b);
  return luminance > 0.4 ? "light" : "dark";
}

/** A background escape code at the terminal's depth; empty where there is no colour. */
export function backgroundCode(value: string, depth: ColorDepth): string {
  if (depth === "none") return "";
  const parsed = parseColor(value);
  if (parsed === undefined) return "";
  if (typeof parsed === "number") return parsed < 8 ? `\x1b[${40 + parsed}m` : `\x1b[${100 + parsed - 8}m`;
  return depth === "truecolor"
    ? `\x1b[48;2;${parsed.r};${parsed.g};${parsed.b}m`
    : `\x1b[48;5;${rgbTo256(parsed)}m`;
}

// ---------------------------------------------------------------------------------------------
// Code style: which highlighter, and whether fenced code is numbered.
// ---------------------------------------------------------------------------------------------

export type CodeStyle = { colors: "vscode" | "theme"; lineNumbers: boolean };

export const DEFAULT_CODE_STYLE: CodeStyle = { colors: "vscode", lineNumbers: true };

let currentCodeStyle: CodeStyle = { ...DEFAULT_CODE_STYLE };

/** `ARCHYMEDES_CODE_COLORS` (vscode | theme) and `ARCHYMEDES_CODE_LINE_NUMBERS` (on | off). */
export function codeStyleFromEnvironment(environment: Record<string, string | undefined>): CodeStyle {
  const colors = environment.ARCHYMEDES_CODE_COLORS?.trim().toLowerCase();
  const numbers = environment.ARCHYMEDES_CODE_LINE_NUMBERS?.trim().toLowerCase();
  return {
    colors: colors === "theme" ? "theme" : "vscode",
    lineNumbers: !(numbers === "off" || numbers === "false" || numbers === "0" || numbers === "no"),
  };
}

/**
 * Sets the session's code style. Module state, like the palette in `transcript.ts`: every renderer
 * that draws code reads it, and threading one more option through each of them would change forty
 * call sites to say the same thing.
 */
export function setCodeStyle(style: Partial<CodeStyle>): void {
  currentCodeStyle = { ...currentCodeStyle, ...style };
}

export function codeStyle(): CodeStyle {
  return currentCodeStyle;
}

// ---------------------------------------------------------------------------------------------
// Grammars
// ---------------------------------------------------------------------------------------------

type Grammar = {
  lineComments: readonly string[];
  block?: readonly [string, string];
  quotes: string;
  triple?: boolean;
  control: ReadonlySet<string>;
  declaration: ReadonlySet<string>;
  types?: ReadonlySet<string>;
  decorators?: boolean;
  /** `$name` is a variable (shell, PowerShell, PHP). */
  dollarVariables?: boolean;
  caseInsensitive?: boolean;
  /** Identifier characters beyond `\w` — `$` in JavaScript, `-` in PowerShell cmdlets. */
  wordExtra?: string;
  /** The first word of a line is a command (shell). */
  commandFirst?: boolean;
  /** `'a` is a lifetime, not an unterminated character (Rust). */
  lifetimes?: boolean;
  /** `#` only starts a comment at the start of a word, so `$#` and `a#b` survive (shell). */
  hashNeedsSpace?: boolean;
};

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

const JS_CONTROL = words("if else for while do switch case default break continue return throw try catch finally await yield import export from as of with debugger");
const JS_DECLARATION = words("const let var function class interface type enum extends implements new this super true false null undefined async static public private protected readonly abstract declare namespace module typeof instanceof in void delete keyof get set is satisfies infer override accessor");
const JS_TYPES = words("string number boolean any unknown never object symbol bigint Array Promise Record Partial Readonly Map Set Date Error RegExp");

const PY_CONTROL = words("if elif else for while break continue return try except finally raise with import from pass yield await assert del match case");
const PY_DECLARATION = words("def class lambda global nonlocal async None True False self cls and or not in is as");
const PY_TYPES = words("int str float bool list dict tuple set frozenset bytes bytearray object type Exception ValueError TypeError KeyError Optional List Dict Any");

const RUST_CONTROL = words("if else match for while loop break continue return use mod in as await");
const RUST_DECLARATION = words("fn let mut const static struct enum trait impl pub crate self Self super where type ref move unsafe async dyn true false extern");
const RUST_TYPES = words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet");

const GO_CONTROL = words("if else for range switch case default break continue return go defer select fallthrough goto import package");
const GO_DECLARATION = words("func var const type struct interface map chan true false nil iota");
const GO_TYPES = words("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any");

const C_CONTROL = words("if else for foreach while do switch case default break continue return throw try catch finally goto using import package include when yield await");
const C_DECLARATION = words("class struct interface enum record public private protected internal static final const readonly virtual override abstract sealed new this base super true false null nullptr void var val fun func let typedef template typename auto extern inline volatile unsigned signed operator namespace sizeof async in out ref is as object companion data open lateinit suspend");
const C_TYPES = words("int long short char float double bool boolean byte string String Object decimal uint ulong size_t Integer Boolean List Map Set Task");

const SHELL_CONTROL = words("if then else elif fi for in do done while until case esac function return exit break continue select");
const SHELL_DECLARATION = words("export local readonly declare alias unset source set true false");

const PS_CONTROL = words("if elseif else foreach for while do until switch break continue return try catch finally throw trap exit param begin process end filter in");
const PS_DECLARATION = words("function class enum $true $false $null");

const SQL_DECLARATION = words("select from where insert into values update set delete create table alter drop index join inner left right outer full cross on group by order having limit offset as and or not null is in like between distinct union all primary key foreign references default case when then else end begin commit rollback with returning exists view if replace asc desc unique check constraint transaction");
const SQL_TYPES = words("int integer smallint bigint varchar char text boolean bool date time timestamp timestamptz serial bigserial numeric decimal real double float json jsonb uuid blob");

const YAML_DECLARATION = words("true false null yes no on off True False Null");

const EMPTY = new Set<string>();

const GRAMMARS: Record<string, Grammar> = {
  javascript: { lineComments: ["//"], block: ["/*", "*/"], quotes: "\"'`", control: JS_CONTROL, declaration: JS_DECLARATION, types: JS_TYPES, decorators: true, wordExtra: "$" },
  python: { lineComments: ["#"], quotes: "\"'", triple: true, control: PY_CONTROL, declaration: PY_DECLARATION, types: PY_TYPES, decorators: true },
  rust: { lineComments: ["//"], block: ["/*", "*/"], quotes: "\"'", control: RUST_CONTROL, declaration: RUST_DECLARATION, types: RUST_TYPES, lifetimes: true, decorators: false },
  go: { lineComments: ["//"], block: ["/*", "*/"], quotes: "\"'`", control: GO_CONTROL, declaration: GO_DECLARATION, types: GO_TYPES },
  c: { lineComments: ["//"], block: ["/*", "*/"], quotes: "\"'", control: C_CONTROL, declaration: C_DECLARATION, types: C_TYPES, decorators: true },
  shell: { lineComments: ["#"], quotes: "\"'", control: SHELL_CONTROL, declaration: SHELL_DECLARATION, dollarVariables: true, commandFirst: true, hashNeedsSpace: true },
  powershell: { lineComments: ["#"], block: ["<#", "#>"], quotes: "\"'", control: PS_CONTROL, declaration: PS_DECLARATION, dollarVariables: true, caseInsensitive: true, wordExtra: "-" },
  sql: { lineComments: ["--"], block: ["/*", "*/"], quotes: "'\"", control: EMPTY, declaration: SQL_DECLARATION, types: SQL_TYPES, caseInsensitive: true },
  json: { lineComments: ["//"], block: ["/*", "*/"], quotes: "\"", control: EMPTY, declaration: words("true false null") },
  yaml: { lineComments: ["#"], quotes: "\"'", control: EMPTY, declaration: YAML_DECLARATION, hashNeedsSpace: true },
  toml: { lineComments: ["#", ";"], quotes: "\"'", control: EMPTY, declaration: words("true false"), hashNeedsSpace: true },
  ruby: { lineComments: ["#"], quotes: "\"'", control: words("if elsif else unless case when while until for in do end begin rescue ensure return break next redo retry yield then require require_relative"), declaration: words("def class module self nil true false and or not attr_accessor attr_reader private public protected"), dollarVariables: false },
  lua: { lineComments: ["--"], quotes: "\"'", control: words("if then else elseif end for while do repeat until return break goto in"), declaration: words("function local nil true false and or not self") },
  dockerfile: { lineComments: ["#"], quotes: "\"'", control: words("FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS"), declaration: EMPTY, dollarVariables: true },
  makefile: { lineComments: ["#"], quotes: "\"'", control: words("ifeq ifneq ifdef ifndef else endif include define endef export"), declaration: EMPTY, dollarVariables: true },
  generic: { lineComments: ["//", "#"], block: ["/*", "*/"], quotes: "\"'`", control: words("if else elif for while do switch case break continue return throw try catch finally import from export yield await match raise"), declaration: words("const let var function def fn func class struct enum interface type impl trait pub public private static new this self true false null nil None True False undefined async"), types: EMPTY },
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript", javascript: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "javascript", typescript: "javascript", tsx: "javascript", mts: "javascript", cts: "javascript", node: "javascript",
  py: "python", python: "python", python3: "python", py3: "python",
  rs: "rust", rust: "rust",
  go: "go", golang: "go",
  java: "c", kotlin: "c", kt: "c", kts: "c", c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", cxx: "c", hpp: "c",
  cs: "c", csharp: "c", "c#": "c", swift: "c", scala: "c", dart: "c", php: "c", groovy: "c", objc: "c", "objective-c": "c",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", shell: "shell", console: "shell", shellsession: "shell", terminal: "shell",
  ps: "powershell", ps1: "powershell", psm1: "powershell", powershell: "powershell", pwsh: "powershell",
  sql: "sql", psql: "sql", mysql: "sql", sqlite: "sql", postgres: "sql", postgresql: "sql",
  json: "json", jsonc: "json", json5: "json", jsonl: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "toml", cfg: "toml", conf: "toml", properties: "toml", env: "toml", dotenv: "toml",
  rb: "ruby", ruby: "ruby", lua: "lua",
  dockerfile: "dockerfile", docker: "dockerfile", makefile: "makefile", make: "makefile", mk: "makefile",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", xhtml: "markup", vue: "markup", svelte: "markup",
  css: "css", scss: "css", sass: "css", less: "css",
  diff: "diff", patch: "diff", udiff: "diff",
};

/** The grammar family for a fence label or a `languageOf` name. Unknown names get the generic one. */
export function grammarName(language: string | undefined): string {
  const key = (language ?? "").trim().toLowerCase().split(/[\s{,]/)[0] ?? "";
  return LANGUAGE_ALIASES[key] ?? "generic";
}

// ---------------------------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------------------------

const PUNCTUATION = new Set([..."{}[]()<>;,.:=+-*/%!&|^~?\\"]);

function push(tokens: SyntaxToken[], text: string, kind: SyntaxKind): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

function nextNonSpace(line: string, from: number): string {
  for (let index = from; index < line.length; index += 1) if (line[index] !== " " && line[index] !== "\t") return line[index];
  return "";
}

function previousNonSpace(line: string, from: number): string {
  for (let index = from; index >= 0; index -= 1) if (line[index] !== " " && line[index] !== "\t") return line[index];
  return "";
}

/** Splits one line into coloured runs. `state` carries open block comments and triple strings. */
export function tokenizeLine(line: string, language?: string, state: SyntaxState = {}): SyntaxToken[] {
  const family = grammarName(language);
  if (family === "markup") return tokenizeMarkup(line, state);
  if (family === "css") return tokenizeCss(line, state);
  if (family === "diff") return tokenizeDiff(line);
  return tokenizeCode(line, GRAMMARS[family] ?? GRAMMARS.generic, family, state);
}

function tokenizeDiff(line: string): SyntaxToken[] {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return [{ text: line, kind: "meta" }];
  if (line.startsWith("@@")) return [{ text: line, kind: "type" }];
  if (line.startsWith("+")) return [{ text: line, kind: "inserted" }];
  if (line.startsWith("-")) return [{ text: line, kind: "deleted" }];
  return line ? [{ text: line, kind: "plain" }] : [];
}

function tokenizeCode(line: string, grammar: Grammar, family: string, state: SyntaxState): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let index = 0;

  // A block comment or triple string left open by an earlier line.
  if (state.blockEnd) {
    const end = line.indexOf(state.blockEnd);
    const kind = state.blockKind === "string" ? "string" : "comment";
    if (end === -1) { push(tokens, line, kind); return tokens; }
    push(tokens, line.slice(0, end + state.blockEnd.length), kind);
    index = end + state.blockEnd.length;
    state.blockEnd = undefined;
    state.blockKind = undefined;
  } else if (grammar.block?.[0] === "/*" && /^\s*\*(?:\s|\/|$)/.test(line)) {
    // The middle of a doc comment whose opening this renderer never saw — a fold, a snippet.
    push(tokens, line, "comment");
    return tokens;
  }

  const isWordStart = (character: string) => /[A-Za-z_]/.test(character) || (grammar.wordExtra?.includes("$") === true && character === "$");
  const isWordPart = (character: string) => /[\w]/.test(character) || (grammar.wordExtra !== undefined && grammar.wordExtra.includes(character));
  let firstWord = true;

  while (index < line.length) {
    const character = line[index];
    const rest = line.slice(index);

    if (character === " " || character === "\t") {
      let end = index;
      while (end < line.length && (line[end] === " " || line[end] === "\t")) end += 1;
      push(tokens, line.slice(index, end), "plain");
      index = end;
      continue;
    }

    // Block comments.
    if (grammar.block && rest.startsWith(grammar.block[0])) {
      const end = line.indexOf(grammar.block[1], index + grammar.block[0].length);
      if (end === -1) {
        push(tokens, rest, "comment");
        state.blockEnd = grammar.block[1];
        state.blockKind = "comment";
        return tokens;
      }
      push(tokens, line.slice(index, end + grammar.block[1].length), "comment");
      index = end + grammar.block[1].length;
      continue;
    }

    // Line comments.
    const lineComment = grammar.lineComments.find((marker) => rest.startsWith(marker));
    if (lineComment) {
      const atWordStart = index === 0 || /\s/.test(line[index - 1]);
      const shebang = family === "shell" && index === 0 && rest.startsWith("#!");
      if (shebang || !grammar.hashNeedsSpace || lineComment !== "#" || atWordStart) {
        push(tokens, rest, "comment");
        return tokens;
      }
    }

    // Triple-quoted strings (Python docstrings).
    if (grammar.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const fence = rest.slice(0, 3);
      const end = line.indexOf(fence, index + 3);
      if (end === -1) {
        push(tokens, rest, "string");
        state.blockEnd = fence;
        state.blockKind = "string";
        return tokens;
      }
      push(tokens, line.slice(index, end + 3), "string");
      index = end + 3;
      continue;
    }

    // Rust lifetimes and character literals share a quote.
    if (grammar.lifetimes && character === "'") {
      const charLiteral = /^'(?:\\.|[^\\'])'/.exec(rest);
      if (!charLiteral) {
        const lifetime = /^'[A-Za-z_]\w*/.exec(rest);
        if (lifetime) { push(tokens, lifetime[0], "declaration"); index += lifetime[0].length; continue; }
      }
    }

    // Strings.
    if (grammar.quotes.includes(character)) {
      let end = index + 1;
      while (end < line.length) {
        if (line[end] === "\\") { end += 2; continue; }
        if (line[end] === character) { end += 1; break; }
        end += 1;
      }
      const text = line.slice(index, Math.min(end, line.length));
      // A JSON or YAML key is the property it names, not a string value.
      const isKey = (family === "json" || family === "yaml") && nextNonSpace(line, index + text.length) === ":";
      push(tokens, text, isKey ? "property" : "string");
      index += text.length;
      firstWord = false;
      continue;
    }

    // Decorators and annotations.
    if (grammar.decorators && character === "@" && /[A-Za-z_]/.test(line[index + 1] ?? "")) {
      const match = /^@[\w.]+/.exec(rest)!;
      push(tokens, match[0], "decorator");
      index += match[0].length;
      continue;
    }

    // `$name`, `${name}`, `$(...)` openers in shells.
    if (grammar.dollarVariables && character === "$") {
      const match = /^\$(?:\{[^}]*\}|[A-Za-z_][\w:]*|[0-9#?@*!$-])/.exec(rest);
      if (match) {
        const text = match[0];
        const lowered = text.toLowerCase();
        push(tokens, text, grammar.declaration.has(lowered) ? "declaration" : "variable");
        index += text.length;
        firstWord = false;
        continue;
      }
    }

    // Numbers, only where a word could not have continued into them.
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(line[index + 1] ?? "") && !/[\w)]/.test(line[index - 1] ?? ""))) {
      const match = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)[a-zA-Z%]*/.exec(rest);
      if (match && match[0]) {
        push(tokens, match[0], "number");
        index += match[0].length;
        firstWord = false;
        continue;
      }
    }

    // Words.
    if (isWordStart(character) || (grammar.wordExtra?.includes("-") && character === "-" && /[A-Za-z]/.test(line[index + 1] ?? "") && !isWordPart(line[index - 1] ?? " "))) {
      let end = index + 1;
      while (end < line.length && isWordPart(line[end])) end += 1;
      const word = line.slice(index, end);
      push(tokens, word, classifyWord(word, line, index, end, grammar, family, firstWord));
      index = end;
      firstWord = false;
      continue;
    }

    if (PUNCTUATION.has(character)) {
      push(tokens, character, "punctuation");
      // A pipe or a separator starts a new command in a shell.
      if (character === "|" || character === ";" || character === "&" || character === "(") firstWord = true;
      index += 1;
      continue;
    }

    push(tokens, character, "plain");
    index += 1;
  }
  return tokens;
}

function classifyWord(word: string, line: string, start: number, end: number, grammar: Grammar, family: string, firstWord: boolean): SyntaxKind {
  const lookup = grammar.caseInsensitive ? word.toLowerCase() : word;
  const after = nextNonSpace(line, end);
  const before = previousNonSpace(line, start - 1);

  // Keys, before keywords: `default:` in YAML is a key, `type =` in TOML is a key.
  if ((family === "yaml" && after === ":" && /^\s*(?:-\s+)?$/.test(line.slice(0, start)))
    || (family === "toml" && after === "=" && /^\s*$/.test(line.slice(0, start)))) return "property";
  if (family === "toml" && /^\s*\[/.test(line)) return "type";

  if (family === "powershell") {
    if (word.startsWith("-")) return "declaration";
    if (/^[A-Za-z]+-[A-Za-z]+$/.test(word)) return "function";
  }
  if (grammar.control.has(lookup)) return "control";
  if (grammar.declaration.has(lookup)) return "declaration";
  if (grammar.types?.has(lookup)) return "type";
  if (family === "rust" && line[end] === "!") return "function";
  if (before === "." && after !== "(") return "property";
  if (after === "(") return "function";
  if (family === "shell" && firstWord) return "function";
  if (family === "makefile" && after === ":" && start === 0) return "function";
  // Capitalised and not shouting: a class, a type, a component.
  if (/^[A-Z][a-z0-9]/.test(word) && family !== "sql" && family !== "yaml") return "type";
  return "plain";
}

function tokenizeMarkup(line: string, state: SyntaxState): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let index = 0;
  if (state.blockEnd === "-->") {
    const end = line.indexOf("-->");
    if (end === -1) return [{ text: line, kind: "comment" }];
    push(tokens, line.slice(0, end + 3), "comment");
    index = end + 3;
    state.blockEnd = undefined;
  }
  while (index < line.length) {
    const rest = line.slice(index);
    if (rest.startsWith("<!--")) {
      const end = line.indexOf("-->", index + 4);
      if (end === -1) { push(tokens, rest, "comment"); state.blockEnd = "-->"; return tokens; }
      push(tokens, line.slice(index, end + 3), "comment");
      index = end + 3;
      continue;
    }
    const tag = /^(<\/?)([A-Za-z][\w:.-]*)/.exec(rest);
    if (tag) {
      push(tokens, tag[1], "punctuation");
      push(tokens, tag[2], /^[A-Z]/.test(tag[2]) ? "type" : "tag");
      index += tag[0].length;
      // Attributes until the tag closes or the line ends.
      while (index < line.length) {
        const inner = line.slice(index);
        const close = /^\s*\/?>/.exec(inner);
        if (close) { push(tokens, close[0], "punctuation"); index += close[0].length; break; }
        const attribute = /^(\s+)([^\s=>/]+)/.exec(inner);
        if (attribute) { push(tokens, attribute[1], "plain"); push(tokens, attribute[2], "attribute"); index += attribute[0].length; continue; }
        const value = /^(\s*=\s*)("[^"]*"?|'[^']*'?|[^\s>]+)/.exec(inner);
        if (value) { push(tokens, value[1], "punctuation"); push(tokens, value[2], "string"); index += value[0].length; continue; }
        push(tokens, inner[0], "plain");
        index += 1;
      }
      continue;
    }
    const entity = /^&[#\w]+;/.exec(rest);
    if (entity) { push(tokens, entity[0], "number"); index += entity[0].length; continue; }
    const text = /^[^<&]+/.exec(rest);
    if (text) { push(tokens, text[0], "plain"); index += text[0].length; continue; }
    push(tokens, rest[0], "punctuation");
    index += 1;
  }
  return tokens;
}

function tokenizeCss(line: string, state: SyntaxState): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let index = 0;
  if (state.blockEnd === "*/") {
    const end = line.indexOf("*/");
    if (end === -1) return [{ text: line, kind: "comment" }];
    push(tokens, line.slice(0, end + 2), "comment");
    index = end + 2;
    state.blockEnd = undefined;
  }
  // A declaration line (`color: red;`) versus a selector line (`.card > a:hover {`).
  const declaration = /^\s*[-\w]+\s*:(?!:)/.test(line.slice(index)) && !/\{\s*$/.test(line);
  let seenColon = false;
  while (index < line.length) {
    const rest = line.slice(index);
    const character = line[index];
    if (rest.startsWith("/*")) {
      const end = line.indexOf("*/", index + 2);
      if (end === -1) { push(tokens, rest, "comment"); state.blockEnd = "*/"; return tokens; }
      push(tokens, line.slice(index, end + 2), "comment");
      index = end + 2;
      continue;
    }
    if (rest.startsWith("//")) { push(tokens, rest, "comment"); return tokens; }
    if (character === "\"" || character === "'") {
      const end = line.indexOf(character, index + 1);
      const text = line.slice(index, end === -1 ? line.length : end + 1);
      push(tokens, text, "string");
      index += text.length;
      continue;
    }
    const at = /^@[\w-]+/.exec(rest);
    if (at) { push(tokens, at[0], "control"); index += at[0].length; continue; }
    const hex = /^#[\da-fA-F]{3,8}\b/.exec(rest);
    if (hex && (declaration && seenColon)) { push(tokens, hex[0], "number"); index += hex[0].length; continue; }
    const number = /^-?\d*\.?\d+(?:%|[a-zA-Z]+)?/.exec(rest);
    if (number && /[\d.]/.test(rest[0] === "-" ? rest[1] ?? "" : rest[0]) && !/[\w-]/.test(line[index - 1] ?? "")) {
      push(tokens, number[0], "number");
      index += number[0].length;
      continue;
    }
    const word = /^-?-?[A-Za-z_][\w-]*/.exec(rest);
    if (word) {
      let kind: SyntaxKind;
      if (declaration && !seenColon) kind = "property";
      else if (declaration) kind = nextNonSpace(line, index + word[0].length) === "(" ? "function" : "plain";
      else kind = "tag";
      push(tokens, word[0], kind);
      index += word[0].length;
      continue;
    }
    if (character === ":" && declaration) seenColon = true;
    push(tokens, character, PUNCTUATION.has(character) || character === "#" ? "punctuation" : "plain");
    index += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------------------------

export type HighlightOptions = {
  language?: string;
  depth: ColorDepth;
  palette?: Palette;
  state?: SyntaxState;
  /** A diff row: the whole line sits on a green or red band, VS Code's diff editor look. */
  band?: "add" | "remove";
  /** Changed runs inside a banded row, which get the stronger band. */
  segments?: readonly { text: string; changed: boolean }[];
  /** Pads a banded row with coloured spaces to this many columns, so the band reads as a row. */
  padTo?: number;
};

function foreground(kind: SyntaxKind, scheme: SyntaxScheme, depth: ColorDepth): string {
  if (kind === "plain") return "";
  return colorCode(SYNTAX_COLORS[scheme][kind], depth);
}

/**
 * One line, coloured. Returns the line untouched at depth none — escape codes in a pipe or a
 * `NO_COLOR` terminal are corruption, not decoration.
 */
export function highlightSyntax(line: string, options: HighlightOptions): string {
  const { depth } = options;
  const tokens = tokenizeLine(line, options.language, options.state ?? {});
  if (depth === "none") return line;
  const scheme = schemeFor(options.palette);

  if (!options.band) {
    return tokens.map((token) => {
      const code = foreground(token.kind, scheme, depth);
      if (token.kind === "comment") return paintAll(token.text, [code, ITALIC], depth);
      return paint(token.text, code, depth);
    }).join("");
  }

  // Banded: one background for the row and a stronger one under the changed runs. Foreground
  // resets use 39/23 rather than a full reset, which would drop the band mid-row.
  const backgrounds = DIFF_BACKGROUNDS[scheme];
  const lineBackground = backgroundCode(options.band === "add" ? backgrounds.add : backgrounds.remove, depth);
  const strongBackground = backgroundCode(options.band === "add" ? backgrounds.addStrong : backgrounds.removeStrong, depth);
  const changedAt: boolean[] = [];
  if (options.segments) for (const segment of options.segments) for (let count = 0; count < segment.text.length; count += 1) changedAt.push(segment.changed);

  let out = lineBackground;
  let offset = 0;
  let activeBackground = lineBackground;
  for (const token of tokens) {
    const code = foreground(token.kind, scheme, depth);
    const italic = token.kind === "comment";
    // Split the token wherever the changed/unchanged boundary falls inside it.
    let runStart = 0;
    while (runStart < token.text.length) {
      const strong = changedAt[offset + runStart] === true;
      let runEnd = runStart + 1;
      while (runEnd < token.text.length && (changedAt[offset + runEnd] === true) === strong) runEnd += 1;
      const background = strong ? strongBackground : lineBackground;
      if (background !== activeBackground) { out += background; activeBackground = background; }
      out += `${code}${italic ? ITALIC : ""}${token.text.slice(runStart, runEnd)}${code ? "\x1b[39m" : ""}${italic ? "\x1b[23m" : ""}`;
      runStart = runEnd;
    }
    offset += token.text.length;
  }
  if (activeBackground !== lineBackground) out += lineBackground;
  const width = [...line].length;
  if (options.padTo !== undefined && options.padTo > width) out += " ".repeat(options.padTo - width);
  return `${out}${RESET}`;
}
