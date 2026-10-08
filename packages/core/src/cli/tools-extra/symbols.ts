import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_WORKSPACE_LIMITS, looksBinary, walkWorkspace, type WalkEntry, type WorkspaceLimits } from "../workspace";

/**
 * Lightweight, regex-based symbol extraction for the repo map and find_symbol.
 *
 * Deliberately not a parser: a parser per language is a dependency per language, and what a model
 * needs from a repo map is "which file defines what", not an AST. Each language is a handful of
 * line rules plus one notion of a *container* (a class, interface, impl block, ...) whose direct
 * members — lines at the first indentation level inside it — are matched by the container's own
 * member rules. Bodies are deeper than that level, so `if (` inside a method is never mistaken for
 * a method.
 */

export type SymbolKind =
  | "function" | "class" | "interface" | "type" | "enum" | "variable" | "constant" | "namespace"
  | "method" | "property" | "struct" | "trait" | "module" | "macro" | "record";

export type CodeSymbol = {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the declaration. */
  line: number;
  /** The declaration line, trimmed and shortened — enough to recognise the symbol. */
  signature: string;
  /** Exported / public by the language's own convention. */
  exported: boolean;
  /** Enclosing class/impl/interface name for members. */
  parent?: string;
};

export type Language = "typescript" | "javascript" | "python" | "go" | "rust" | "java" | "csharp";

const EXTENSIONS: Record<string, Language> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
};

export function languageForPath(filePath: string): Language | undefined {
  if (filePath.endsWith(".d.ts")) return "typescript";
  return EXTENSIONS[path.extname(filePath).toLowerCase()];
}

type Rule = {
  kind: SymbolKind | ((match: RegExpExecArray) => SymbolKind);
  re: RegExp;
  /** Match at any indentation, not only column 0 (Java/C# types live inside namespaces/classes). */
  anyIndent?: boolean;
  /** Opens a container whose direct members are matched with `members`. */
  members?: Rule[];
  /** False for containers that are structure only (an `impl` block, a Go `const (` group). */
  emit?: boolean;
  exported?: (line: string, name: string) => boolean;
};

type LanguageSpec = { rules: Rule[]; commentPrefixes: string[]; exported: (line: string, name: string) => boolean };

const NOT_MEMBER_NAMES = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "throw", "else", "do", "try", "await", "yield",
  "typeof", "delete", "void", "super", "this", "case", "using", "lock", "foreach", "fixed", "checked", "unchecked", "sizeof", "synchronized",
]);

/** Words that, in a "return type" position, mean the line is a statement (`return foo(...)`). */
const NOT_RETURN_TYPES = new Set(["return", "new", "throw", "else", "await", "yield", "case", "typeof", "delete", "goto", "in", "is", "as", "await"]);

const JS_ID = "[A-Za-z_$][\\w$]*";
const TS_MODS = "(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?";
const TS_MEMBER: Rule[] = [
  {
    kind: "method",
    re: new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|abstract|override|async|declare|get|set)\\s+)*\\*?(?<name>#?${JS_ID})\\s*\\??\\s*(?:<[^>]*>)?\\s*\\(`),
    exported: (line) => !/^\s*(?:private|protected)\b/.test(line) && !/^\s*#/.test(line),
  },
  {
    // Arrow-function class fields: `handle = async (event) => { ... }`.
    kind: "method",
    re: new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|override)\\s+)*(?<name>#?${JS_ID})\\s*[?!]?\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${JS_ID})\\s*(?::[^=]+)?=>`),
    exported: (line) => !/^\s*(?:private|protected)\b/.test(line) && !/^\s*#/.test(line),
  },
];
const TS_RULES: Rule[] = [
  { kind: "function", re: new RegExp(`^${TS_MODS}(?:async\\s+)?function\\s*\\*?\\s*(?<name>${JS_ID})`) },
  { kind: "class", re: new RegExp(`^${TS_MODS}(?:abstract\\s+)?class\\s+(?<name>${JS_ID})`), members: TS_MEMBER },
  { kind: "interface", re: new RegExp(`^${TS_MODS}interface\\s+(?<name>${JS_ID})`), members: TS_MEMBER },
  { kind: "type", re: new RegExp(`^${TS_MODS}type\\s+(?<name>${JS_ID})\\s*(?:<|=)`) },
  { kind: "enum", re: new RegExp(`^${TS_MODS}(?:const\\s+)?enum\\s+(?<name>${JS_ID})`) },
  { kind: "namespace", re: new RegExp(`^${TS_MODS}(?:namespace|module)\\s+(?<name>${JS_ID}(?:\\.${JS_ID})*)`) },
  {
    kind: "function",
    re: new RegExp(`^${TS_MODS}(?:const|let|var)\\s+(?<name>${JS_ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${JS_ID}\\s*=>|\\([^)]*$)`),
  },
  { kind: "variable", re: new RegExp(`^${TS_MODS}(?:const|let|var)\\s+(?<name>${JS_ID})`) },
  { kind: "variable", re: new RegExp(`^(?:module\\.)?exports\\.(?<name>${JS_ID})\\s*=`), exported: () => true },
];

const PY_RULES: Rule[] = [
  { kind: "function", re: /^(?:async\s+)?def\s+(?<name>\w+)/ },
  { kind: "class", re: /^class\s+(?<name>\w+)/, members: [{ kind: "method", re: /^\s+(?:async\s+)?def\s+(?<name>\w+)/ }] },
  { kind: "constant", re: /^(?<name>[A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/ },
];

const GO_BLOCK_MEMBER: Rule[] = [{ kind: "variable", re: /^\s+(?<name>[A-Za-z_]\w*)\b(?!\s*\()/ }];
const GO_TYPE_MEMBER: Rule[] = [{ kind: (match) => goTypeKind(match.input), re: /^\s+(?<name>[A-Za-z_]\w*)\s+\S/ }];
function goTypeKind(line: string): SymbolKind {
  if (/\bstruct\b/.test(line)) return "struct";
  if (/\binterface\b/.test(line)) return "interface";
  return "type";
}
const GO_RULES: Rule[] = [
  { kind: "method", re: /^func\s+\((?<recv>[^)]*)\)\s*(?<name>\w+)/ },
  { kind: "function", re: /^func\s+(?<name>\w+)/ },
  { kind: "type", re: /^type\s*\(/, members: GO_TYPE_MEMBER, emit: false },
  { kind: (match) => goTypeKind(match.input), re: /^type\s+(?<name>\w+)/ },
  { kind: "variable", re: /^(?:var|const)\s*\(/, members: GO_BLOCK_MEMBER, emit: false },
  { kind: (match) => (match[0].startsWith("const") ? "constant" : "variable"), re: /^(?:var|const)\s+(?<name>\w+)/ },
];

const RS_VIS = "(?:pub(?:\\([^)]*\\))?\\s+)?";
const RS_FN = `${RS_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+(?<name>\\w+)`;
const RS_MEMBER: Rule[] = [
  { kind: "method", re: new RegExp(`^\\s+${RS_FN}`) },
  { kind: "constant", re: new RegExp(`^\\s+${RS_VIS}const\\s+(?<name>\\w+)`) },
  { kind: "type", re: new RegExp(`^\\s+${RS_VIS}type\\s+(?<name>\\w+)`) },
];
const RS_RULES: Rule[] = [
  { kind: "function", re: new RegExp(`^${RS_FN}`) },
  { kind: "struct", re: new RegExp(`^${RS_VIS}struct\\s+(?<name>\\w+)`) },
  { kind: "enum", re: new RegExp(`^${RS_VIS}enum\\s+(?<name>\\w+)`) },
  { kind: "type", re: new RegExp(`^${RS_VIS}union\\s+(?<name>\\w+)`) },
  { kind: "trait", re: new RegExp(`^${RS_VIS}(?:unsafe\\s+)?trait\\s+(?<name>\\w+)`), members: RS_MEMBER },
  { kind: "type", re: new RegExp(`^${RS_VIS}type\\s+(?<name>\\w+)`) },
  { kind: "module", re: new RegExp(`^${RS_VIS}mod\\s+(?<name>\\w+)`) },
  { kind: "constant", re: new RegExp(`^${RS_VIS}(?:const|static)\\s+(?:mut\\s+)?(?<name>\\w+)`) },
  { kind: "macro", re: /^(?:#\[macro_export\]\s*)?macro_rules!\s*(?<name>\w+)/, exported: () => true },
  {
    kind: "type",
    re: /^(?:unsafe\s+)?impl(?:\s*<[^{]*?>)?\s+(?:(?:[\w:]+)(?:<[^{]*?>)?\s+for\s+)?(?<name>[\w:]+)/,
    members: RS_MEMBER,
    emit: false,
  },
];

const JAVA_TYPE_MODS = "(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\\s+)*";
const JAVA_MEMBER: Rule[] = [
  {
    kind: "method",
    re: /^\s+(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:(?<ret>[\w$][\w$<>[\],.? ]*?)\s+)?(?<name>[A-Za-z_$][\w$]*)\s*\(/,
  },
];
const JAVA_RULES: Rule[] = [
  {
    kind: (match) => typeKindFromKeyword(match.groups?.keyword ?? "class"),
    re: new RegExp(`^\\s*${JAVA_TYPE_MODS}(?<keyword>class|interface|enum|record|@interface)\\s+(?<name>[A-Za-z_$][\\w$]*)`),
    anyIndent: true,
    members: JAVA_MEMBER,
  },
];

const CS_MODS = "(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|partial|extern|unsafe|new|readonly|ref|file|required)\\s+)*";
const CS_MEMBER: Rule[] = [
  {
    kind: "property",
    re: new RegExp(`^\\s+(?:\\[[^\\]]*\\]\\s*)*${CS_MODS}[\\w<>\\[\\],.?()]+\\s+(?<name>[A-Za-z_]\\w*)\\s*(?:\\{\\s*(?:get|set|init|private|protected|internal)\\b|=>)`),
  },
  {
    kind: "method",
    re: new RegExp(`^\\s+(?:\\[[^\\]]*\\]\\s*)*${CS_MODS}(?:(?<ret>[\\w<>\\[\\],.?()]+?)\\s+)?(?<name>[A-Za-z_]\\w*)\\s*(?:<[^>]*>)?\\s*\\(`),
  },
];
const CS_RULES: Rule[] = [
  { kind: "namespace", re: /^\s*namespace\s+(?<name>[\w.]+)/, anyIndent: true, members: [] },
  {
    kind: (match) => typeKindFromKeyword(match.groups?.keyword ?? "class"),
    re: new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${CS_MODS}(?<keyword>record\\s+struct|record\\s+class|class|interface|enum|struct|record)\\s+(?<name>[A-Za-z_]\\w*)`),
    anyIndent: true,
    members: CS_MEMBER,
  },
];

function typeKindFromKeyword(keyword: string): SymbolKind {
  if (keyword.startsWith("record")) return "record";
  if (keyword === "interface" || keyword === "@interface") return "interface";
  if (keyword === "enum") return "enum";
  if (keyword === "struct") return "struct";
  return "class";
}

const LANGUAGES: Record<Language, LanguageSpec> = {
  typescript: { rules: TS_RULES, commentPrefixes: ["//", "/*", "*"], exported: (line) => /^export\b/.test(line) },
  javascript: { rules: TS_RULES, commentPrefixes: ["//", "/*", "*"], exported: (line) => /^export\b/.test(line) },
  python: { rules: PY_RULES, commentPrefixes: ["#"], exported: (_line, name) => !name.startsWith("_") },
  go: { rules: GO_RULES, commentPrefixes: ["//", "/*", "*"], exported: (_line, name) => /^[A-Z]/.test(name) },
  rust: { rules: RS_RULES, commentPrefixes: ["//", "/*", "*"], exported: (line) => /^\s*pub\b/.test(line) },
  java: { rules: JAVA_RULES, commentPrefixes: ["//", "/*", "*"], exported: (line) => /\bpublic\b/.test(line) },
  csharp: { rules: CS_RULES, commentPrefixes: ["//", "/*", "*", "#"], exported: (line) => /\bpublic\b/.test(line) },
};

const MAX_SIGNATURE = 160;

function signatureOf(line: string): string {
  let text = line.trim().replace(/\s*\{\s*$/, "").replace(/\s+/g, " ");
  if (text.length > MAX_SIGNATURE) text = `${text.slice(0, MAX_SIGNATURE - 1)}…`;
  return text;
}

function indentOf(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === " ") width += 1;
    else if (character === "\t") width += 4;
    else break;
  }
  return width;
}

type Container = { indent: number; memberIndent?: number; members: Rule[]; name?: string };

function applyRule(rule: Rule, line: string, lineNumber: number, spec: LanguageSpec, parent?: string): { symbol?: CodeSymbol; name?: string } | null {
  const match = rule.re.exec(line);
  if (!match) return null;
  const name = match.groups?.name;
  if (!name) return rule.emit === false ? {} : null;
  if (NOT_MEMBER_NAMES.has(name) || (match.groups?.ret && NOT_RETURN_TYPES.has(match.groups.ret.trim()))) return null;
  const kind = typeof rule.kind === "function" ? rule.kind(match) : rule.kind;
  let resolvedParent = parent;
  if (match.groups?.recv) {
    // Go receiver `(s *Server)` → Server.
    resolvedParent = match.groups.recv.trim().split(/\s+/).pop()?.replace(/^\*/, "").replace(/\[.*$/, "");
  }
  if (rule.emit === false) return { name: name.split("::").pop() };
  const exported = (rule.exported ?? spec.exported)(line, name);
  return { symbol: { name, kind, line: lineNumber, signature: signatureOf(line), exported, ...(resolvedParent ? { parent: resolvedParent } : {}) }, name };
}

/** Top-level symbols (and direct members of containers) declared in `text`. */
export function extractSymbols(text: string, language: Language): CodeSymbol[] {
  const spec = LANGUAGES[language];
  const symbols: CodeSymbol[] = [];
  const stack: Container[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (spec.commentPrefixes.some((prefix) => trimmed.startsWith(prefix))) continue;
    // A lone opening brace (Allman style) belongs to the line above; it neither closes a container
    // nor sets the member indentation.
    if (trimmed === "{") continue;
    const indent = indentOf(line);
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.memberIndent === undefined) top.memberIndent = indent;

    let matched = false;
    for (const rule of spec.rules) {
      if (!rule.anyIndent && indent !== 0) continue;
      // A namespace is a container for scoping only; its types are not its "members".
      const parent = rule.anyIndent && top && top.members.length > 0 ? top.name : undefined;
      const result = applyRule(rule, line, index + 1, spec, parent);
      if (!result) continue;
      matched = true;
      if (result.symbol) symbols.push(result.symbol);
      if (rule.members && !/[;}]\s*$/.test(trimmed.replace(/\{\s*\}$/, "}"))) {
        stack.push({ indent, members: rule.members, name: result.name });
      }
      break;
    }
    if (matched || !top || indent !== top.memberIndent) continue;
    for (const rule of top.members) {
      const result = applyRule(rule, line, index + 1, spec, top.name);
      if (!result?.symbol) continue;
      symbols.push(result.symbol);
      break;
    }
  }
  return symbols;
}

export type FileSymbols = { path: string; language: Language; size: number; symbols: CodeSymbol[] };

/** Files at or above this size are listed but not parsed — generated bundles, minified code. */
export const MAX_SYMBOL_FILE_BYTES = 400_000;
const READ_CONCURRENCY = 32;

/**
 * Per-session symbol cache keyed by absolute path, invalidated by mtime and size.
 *
 * The repo map and find_symbol both index the whole tree on every call; with this cache, a second
 * call re-reads only files that changed since the first.
 */
export class SymbolIndex {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; symbols: CodeSymbol[] }>();
  /** Files actually read and parsed (cache misses) — a test hook and a cheap stat. */
  parsedCount = 0;

  constructor(private readonly root: string, private readonly limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS) {}

  /** Every file in the workspace (ignored dirs and the root .gitignore respected), optionally under `prefix`. */
  async files(prefix = ""): Promise<WalkEntry[]> {
    const entries: WalkEntry[] = [];
    const scope = prefix ? `${prefix}/` : "";
    for await (const entry of walkWorkspace(this.root, this.limits)) {
      if (entry.isDirectory) continue;
      if (scope && !entry.relative.startsWith(scope)) continue;
      entries.push(entry);
    }
    return entries.sort((left, right) => left.relative.localeCompare(right.relative));
  }

  async symbolsFor(entry: WalkEntry): Promise<FileSymbols | null> {
    const language = languageForPath(entry.relative);
    if (!language) return null;
    let stat;
    try {
      stat = await fs.stat(entry.absolute);
    } catch {
      return null;
    }
    if (stat.size > Math.min(MAX_SYMBOL_FILE_BYTES, this.limits.maxReadBytes)) return { path: entry.relative, language, size: stat.size, symbols: [] };
    const cached = this.cache.get(entry.absolute);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { path: entry.relative, language, size: stat.size, symbols: cached.symbols };
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(entry.absolute);
    } catch {
      return null;
    }
    this.parsedCount += 1;
    const symbols = looksBinary(buffer) ? [] : extractSymbols(buffer.toString("utf8"), language);
    this.cache.set(entry.absolute, { mtimeMs: stat.mtimeMs, size: stat.size, symbols });
    return { path: entry.relative, language, size: stat.size, symbols };
  }

  /** Symbols for many files, read concurrently, returned in input order. */
  async symbolsForAll(entries: readonly WalkEntry[]): Promise<FileSymbols[]> {
    const results: FileSymbols[] = [];
    for (let start = 0; start < entries.length; start += READ_CONCURRENCY) {
      const batch = await Promise.all(entries.slice(start, start + READ_CONCURRENCY).map((entry) => this.symbolsFor(entry)));
      for (const result of batch) if (result) results.push(result);
    }
    return results;
  }
}
