/**
 * A deterministic calculator, so a quantitative claim is measured rather than guessed.
 *
 * A language model does arithmetic by pattern, and is wrong often enough — a carried digit, a
 * dropped zero, a percentage inverted — that "the cost fell 34%" in an answer is a number nobody
 * should trust without checking. This module is the check: a safe expression evaluator the agent
 * calls through the `compute` tool instead of working a sum in its head.
 *
 * It is a hand-written recursive-descent parser and a tree walk. There is no `eval`, no `Function`,
 * no property access on the input — the only things that reach JavaScript are `Math.*` calls with
 * numeric arguments. Everything is bounded: input length, expression depth, factorial size, and the
 * `2^53` boundary past which a double is no longer exact is reported rather than hidden.
 */

const MAX_INPUT = 2_000;
const MAX_DEPTH = 64;
const FACTORIAL_LIMIT = 170; // 171! overflows a double to Infinity.

export class ComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeError";
  }
}

type Value = number | number[];

export type ComputeResult = {
  /** The computed value. `NaN` only for an explicit `nan`; overflow is `Infinity`. */
  value: number;
  /** False when the magnitude passed 2^53 and the double can no longer represent every integer. */
  exact: boolean;
  /** The value rendered to the requested precision, trailing zeros trimmed. */
  rendered: string;
  /** Present when `radix` was asked for and the value is a finite integer. */
  radixRendered?: string;
  /** Non-fatal notes: precision loss, overflow, an empty statistic. */
  warnings: string[];
};

// ── Lexer ────────────────────────────────────────────────────────────────────

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string }
  | { kind: "punct"; value: "(" | ")" | "[" | "]" | "," };

const OPERATORS = ["**", "//", "+", "-", "*", "/", "%", "^", "!"];

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isNameStart = (c: string) => /[A-Za-zπφµ_]/.test(c);
  const isNamePart = (c: string) => /[A-Za-z0-9πφµ_.]/.test(c);

  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i += 1; continue; }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += 1;
      if (j >= source.length) throw new ComputeError("Unterminated string.");
      tokens.push({ kind: "string", value: source.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      let j = i;
      let radixMatch: RegExpExecArray | null = null;
      if (c === "0" && /[xXbBoO]/.test(source[i + 1] ?? "")) {
        radixMatch = /^0[xX][0-9a-fA-F_]+|^0[bB][01_]+|^0[oO][0-7_]+/.exec(source.slice(i));
      }
      if (radixMatch) {
        const raw = radixMatch[0].replace(/_/g, "");
        const base = raw[1].toLowerCase() === "x" ? 16 : raw[1].toLowerCase() === "b" ? 2 : 8;
        const parsed = Number.parseInt(raw.slice(2), base);
        if (Number.isNaN(parsed)) throw new ComputeError(`Not a base-${base} number: ${radixMatch[0]}`);
        tokens.push({ kind: "number", value: parsed });
        i += radixMatch[0].length;
        continue;
      }
      while (j < source.length && (isDigit(source[j]) || source[j] === "." || source[j] === "_")) j += 1;
      if (/[eE]/.test(source[j] ?? "")) {
        j += 1;
        if (source[j] === "+" || source[j] === "-") j += 1;
        while (j < source.length && isDigit(source[j])) j += 1;
      }
      const raw = source.slice(i, j).replace(/_/g, "");
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new ComputeError(`Not a number: ${raw}`);
      tokens.push({ kind: "number", value: parsed });
      i = j;
      continue;
    }

    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNamePart(source[j])) j += 1;
      tokens.push({ kind: "name", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (c === "(" || c === ")" || c === "[" || c === "]" || c === ",") {
      tokens.push({ kind: "punct", value: c });
      i += 1;
      continue;
    }

    const twoChar = source.slice(i, i + 2);
    if (OPERATORS.includes(twoChar)) { tokens.push({ kind: "op", value: twoChar }); i += 2; continue; }
    if (OPERATORS.includes(c)) { tokens.push({ kind: "op", value: c }); i += 1; continue; }

    throw new ComputeError(`Unexpected character "${c}" at position ${i}.`);
  }
  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────────────

type Node =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "const"; name: string }
  | { type: "list"; items: Node[] }
  | { type: "unary"; op: string; operand: Node }
  | { type: "postfix"; op: string; operand: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] };

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new ComputeError("Nothing to evaluate.");
    const node = this.expression();
    if (this.pos < this.tokens.length) throw new ComputeError(`Unexpected "${tokenText(this.tokens[this.pos])}" after a complete expression.`);
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token { const t = this.tokens[this.pos]; if (!t) throw new ComputeError("Expression ended early."); this.pos += 1; return t; }
  private eat(value: string): void {
    const t = this.peek();
    if (!t || tokenText(t) !== value) throw new ComputeError(`Expected "${value}".`);
    this.pos += 1;
  }

  /** Lowest precedence: `+` and `-`. */
  private expression(): Node { return this.addition(); }

  private addition(): Node {
    let left = this.multiplication();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { value: string }).value;
      left = { type: "binary", op, left, right: this.multiplication() };
    }
    return left;
  }

  private multiplication(): Node {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%") || this.isOp("//")) {
      const op = (this.next() as { value: string }).value;
      left = { type: "binary", op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp("-") || this.isOp("+")) {
      const op = (this.next() as { value: string }).value;
      return { type: "unary", op, operand: this.unary() };
    }
    return this.power();
  }

  /** `^` / `**`, right-associative, binding tighter than unary minus's operand chain. */
  private power(): Node {
    const base = this.postfix();
    if (this.isOp("^") || this.isOp("**")) {
      this.next();
      return { type: "binary", op: "^", left: base, right: this.unary() };
    }
    return base;
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.isOp("!")) { this.next(); node = { type: "postfix", op: "!", operand: node }; }
    return node;
  }

  private primary(): Node {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ComputeError("Expression nests too deeply.");
    try {
      const t = this.peek();
      if (!t) throw new ComputeError("Expression ended early.");

      if (t.kind === "number") { this.next(); return { type: "num", value: t.value }; }
      if (t.kind === "string") { this.next(); return { type: "str", value: t.value }; }

      if (t.kind === "punct" && t.value === "(") {
        this.next();
        const node = this.expression();
        this.eat(")");
        return node;
      }

      if (t.kind === "punct" && t.value === "[") {
        this.next();
        const items: Node[] = [];
        if (!(this.peek()?.kind === "punct" && (this.peek() as { value: string }).value === "]")) {
          items.push(this.expression());
          while (this.peek()?.kind === "punct" && (this.peek() as { value: string }).value === ",") { this.next(); items.push(this.expression()); }
        }
        this.eat("]");
        return { type: "list", items };
      }

      if (t.kind === "name") {
        this.next();
        if (this.peek()?.kind === "punct" && (this.peek() as { value: string }).value === "(") {
          this.next();
          const args: Node[] = [];
          if (!(this.peek()?.kind === "punct" && (this.peek() as { value: string }).value === ")")) {
            args.push(this.expression());
            while (this.peek()?.kind === "punct" && (this.peek() as { value: string }).value === ",") { this.next(); args.push(this.expression()); }
          }
          this.eat(")");
          return { type: "call", name: t.value.toLowerCase(), args };
        }
        return { type: "const", name: t.value.toLowerCase() };
      }

      throw new ComputeError(`Unexpected "${tokenText(t)}".`);
    } finally {
      this.depth -= 1;
    }
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return !!t && t.kind === "op" && t.value === value;
  }
}

function tokenText(t: Token): string {
  return t.kind === "number" ? String(t.value) : t.kind === "string" ? `"${t.value}"` : t.value;
}

// ── Evaluator ────────────────────────────────────────────────────────────────

const CONSTANTS: Record<string, number> = {
  pi: Math.PI, "π": Math.PI, tau: Math.PI * 2, e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2, "φ": (1 + Math.sqrt(5)) / 2,
  inf: Infinity, infinity: Infinity, nan: NaN,
};

const DATA_UNITS: Record<string, number> = {
  bit: 1 / 8, b: 1, byte: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
  kbit: 125, mbit: 125_000, gbit: 125_000_000,
};

const TIME_UNITS: Record<string, number> = {
  ns: 1e-9, us: 1e-6, "µs": 1e-6, ms: 1e-3,
  s: 1, sec: 1, second: 1, seconds: 1,
  min: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hour: 3600, hours: 3600,
  d: 86_400, day: 86_400, days: 86_400,
  wk: 604_800, week: 604_800, weeks: 604_800,
};

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new ComputeError("Factorial needs a non-negative whole number.");
  if (n > FACTORIAL_LIMIT) return Infinity;
  let result = 1;
  for (let k = 2; k <= n; k += 1) result *= k;
  return result;
}

function asNumber(value: Value, context: string): number {
  if (typeof value !== "number") throw new ComputeError(`${context} needs a number, not a list.`);
  return value;
}

function asList(value: Value, context: string): number[] {
  if (!Array.isArray(value)) throw new ComputeError(`${context} needs a list, e.g. [1, 2, 3].`);
  return value;
}

/** A stats function's data: either one list argument, or several numeric arguments. */
function statSample(args: Value[], name: string): number[] {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args.map((arg, index) => asNumber(arg, `${name} argument ${index + 1}`));
}

function mean(xs: number[]): number { return xs.reduce((sum, x) => sum + x, 0) / xs.length; }

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) throw new ComputeError("percentile of an empty list.");
  if (p < 0 || p > 100) throw new ComputeError("percentile p must be between 0 and 100.");
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function variance(xs: number[], population: boolean): number {
  if (xs.length < (population ? 1 : 2)) throw new ComputeError(`${population ? "pvariance" : "variance"} needs at least ${population ? "one value" : "two values"}.`);
  const m = mean(xs);
  const ss = xs.reduce((sum, x) => sum + (x - m) ** 2, 0);
  return ss / (population ? xs.length : xs.length - 1);
}

function gcd2(a: number, b: number): number { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }

function convertUnit(value: number, from: string, to: string): number {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (Object.hasOwn(DATA_UNITS, f) && Object.hasOwn(DATA_UNITS, t)) return (value * DATA_UNITS[f]) / DATA_UNITS[t];
  if (Object.hasOwn(TIME_UNITS, f) && Object.hasOwn(TIME_UNITS, t)) return (value * TIME_UNITS[f]) / TIME_UNITS[t];
  throw new ComputeError(`Cannot convert "${from}" to "${to}" — units must both be data sizes or both durations.`);
}

const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
  abs: (a) => Math.abs(asNumber(a[0], "abs")),
  sign: (a) => Math.sign(asNumber(a[0], "sign")),
  sqrt: (a) => Math.sqrt(asNumber(a[0], "sqrt")),
  cbrt: (a) => Math.cbrt(asNumber(a[0], "cbrt")),
  isqrt: (a) => Math.floor(Math.sqrt(asNumber(a[0], "isqrt"))),
  exp: (a) => Math.exp(asNumber(a[0], "exp")),
  ln: (a) => Math.log(asNumber(a[0], "ln")),
  log2: (a) => Math.log2(asNumber(a[0], "log2")),
  log10: (a) => Math.log10(asNumber(a[0], "log10")),
  log: (a) => a.length > 1 ? Math.log(asNumber(a[0], "log")) / Math.log(asNumber(a[1], "log base")) : Math.log10(asNumber(a[0], "log")),
  floor: (a) => Math.floor(asNumber(a[0], "floor")),
  ceil: (a) => Math.ceil(asNumber(a[0], "ceil")),
  round: (a) => {
    const x = asNumber(a[0], "round");
    const digits = a.length > 1 ? asNumber(a[1], "round digits") : 0;
    const factor = 10 ** digits;
    return Math.round(x * factor) / factor;
  },
  trunc: (a) => Math.trunc(asNumber(a[0], "trunc")),
  sin: (a) => Math.sin(asNumber(a[0], "sin")),
  cos: (a) => Math.cos(asNumber(a[0], "cos")),
  tan: (a) => Math.tan(asNumber(a[0], "tan")),
  asin: (a) => Math.asin(asNumber(a[0], "asin")),
  acos: (a) => Math.acos(asNumber(a[0], "acos")),
  atan: (a) => Math.atan(asNumber(a[0], "atan")),
  atan2: (a) => Math.atan2(asNumber(a[0], "atan2 y"), asNumber(a[1], "atan2 x")),
  hypot: (a) => Math.hypot(...a.map((x, i) => asNumber(x, `hypot argument ${i + 1}`))),
  deg2rad: (a) => (asNumber(a[0], "deg2rad") * Math.PI) / 180,
  rad2deg: (a) => (asNumber(a[0], "rad2deg") * 180) / Math.PI,
  factorial: (a) => factorial(asNumber(a[0], "factorial")),
  pow: (a) => asNumber(a[0], "pow base") ** asNumber(a[1], "pow exponent"),
  root: (a) => asNumber(a[0], "root") ** (1 / asNumber(a[1], "root degree")),
  mod: (a) => {
    const n = asNumber(a[0], "mod"); const d = asNumber(a[1], "mod divisor");
    return ((n % d) + d) % d;
  },
  clamp: (a) => Math.min(Math.max(asNumber(a[0], "clamp x"), asNumber(a[1], "clamp lo")), asNumber(a[2], "clamp hi")),
  min: (a) => Math.min(...statSample(a, "min")),
  max: (a) => Math.max(...statSample(a, "max")),
  gcd: (a) => statSample(a, "gcd").reduce((g, x) => gcd2(g, x)),
  lcm: (a) => statSample(a, "lcm").reduce((l, x) => (l === 0 || x === 0 ? 0 : Math.abs(l * x) / gcd2(l, x))),

  // Deltas and ratios — the operations most often got wrong by hand.
  pct_change: (a) => {
    const from = asNumber(a[0], "pct_change from"); const to = asNumber(a[1], "pct_change to");
    if (from === 0) throw new ComputeError("pct_change from a base of zero is undefined.");
    return ((to - from) / Math.abs(from)) * 100;
  },
  pct: (a) => {
    const part = asNumber(a[0], "pct part"); const whole = asNumber(a[1], "pct whole");
    if (whole === 0) throw new ComputeError("pct of a whole of zero is undefined.");
    return (part / whole) * 100;
  },
  ratio: (a) => asNumber(a[0], "ratio a") / asNumber(a[1], "ratio b"),
  delta: (a) => asNumber(a[1], "delta b") - asNumber(a[0], "delta a"),

  // Statistics — accept one list or several numbers.
  sum: (a) => statSample(a, "sum").reduce((s, x) => s + x, 0),
  count: (a) => statSample(a, "count").length,
  mean: (a) => mean(nonEmpty(statSample(a, "mean"), "mean")),
  average: (a) => mean(nonEmpty(statSample(a, "average"), "average")),
  median: (a) => percentile(nonEmpty(statSample(a, "median"), "median"), 50),
  mode: (a) => {
    const xs = nonEmpty(statSample(a, "mode"), "mode");
    const counts = new Map<number, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    let best = xs[0]; let bestCount = 0;
    for (const [value, c] of counts) if (c > bestCount) { best = value; bestCount = c; }
    return best;
  },
  range: (a) => {
    const xs = nonEmpty(statSample(a, "range"), "range");
    return Math.max(...xs) - Math.min(...xs);
  },
  stdev: (a) => Math.sqrt(variance(statSample(a, "stdev"), false)),
  pstdev: (a) => Math.sqrt(variance(statSample(a, "pstdev"), true)),
  variance: (a) => variance(statSample(a, "variance"), false),
  pvariance: (a) => variance(statSample(a, "pvariance"), true),
  percentile: (a) => percentile(asList(a[0], "percentile"), asNumber(a[1], "percentile p")),
  p50: (a) => percentile(nonEmpty(statSample(a, "p50"), "p50"), 50),
  p90: (a) => percentile(nonEmpty(statSample(a, "p90"), "p90"), 90),
  p95: (a) => percentile(nonEmpty(statSample(a, "p95"), "p95"), 95),
  p99: (a) => percentile(nonEmpty(statSample(a, "p99"), "p99"), 99),

  convert: (a) => {
    if (typeof a[1] !== "string" || typeof a[2] !== "string") throw new ComputeError('convert(n, "from", "to") needs the units as quoted strings.');
    return convertUnit(asNumber(a[0], "convert value"), a[1] as unknown as string, a[2] as unknown as string);
  },
};

function nonEmpty(xs: number[], name: string): number[] {
  if (xs.length === 0) throw new ComputeError(`${name} of an empty list.`);
  return xs;
}

// `convert` reads string arguments, which no other function does; the evaluator returns them as a
// tagged wrapper so the walker can hand a string through without treating it as a value.
type Evaluated = Value | { string: string };

function evaluate(node: Node): Evaluated {
  switch (node.type) {
    case "num": return node.value;
    case "str": return { string: node.value };
    case "const": {
      if (Object.hasOwn(CONSTANTS, node.name)) return CONSTANTS[node.name];
      throw new ComputeError(`Unknown name "${node.name}". Constants: pi, e, tau, phi, inf, nan.`);
    }
    case "list": return node.items.map((item) => asNumber(unwrap(evaluate(item)), "list element"));
    case "unary": {
      const operand = asNumber(unwrap(evaluate(node.operand)), "unary operand");
      return node.op === "-" ? -operand : operand;
    }
    case "postfix": return factorial(asNumber(unwrap(evaluate(node.operand)), "factorial"));
    case "binary": {
      const left = asNumber(unwrap(evaluate(node.left)), "left operand");
      const right = asNumber(unwrap(evaluate(node.right)), "right operand");
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
        case "//": return Math.floor(left / right);
        case "^": return left ** right;
        default: throw new ComputeError(`Unknown operator "${node.op}".`);
      }
    }
    case "call": {
      const fn = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : undefined;
      if (!fn) throw new ComputeError(`Unknown function "${node.name}".`);
      const values = node.args.map((arg) => {
        const v = evaluate(arg);
        return typeof v === "object" && v !== null && "string" in v ? (v.string as unknown as Value) : (v as Value);
      });
      return fn(values);
    }
  }
}

function unwrap(value: Evaluated): Value {
  if (typeof value === "object" && value !== null && "string" in value) {
    throw new ComputeError("A string is only valid as a unit argument to convert().");
  }
  return value;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderNumber(value: number, precision: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return value.toLocaleString("en-US", { useGrouping: false });
  // toPrecision may hand back exponential form or trailing zeros; re-parsing normalises both.
  return String(Number(value.toPrecision(Math.max(1, Math.min(15, precision)))));
}

/**
 * Evaluates one expression and reports the result with its exactness and any caveats.
 *
 * Throws `ComputeError` for anything malformed or out of bounds; the caller turns that into the
 * tool's error string. A successful result may still carry `warnings` — a division by zero, a
 * value past `2^53`, an empty statistic caught earlier.
 */
export function compute(expression: string, options: { precision?: number; radix?: 2 | 8 | 16 } = {}): ComputeResult {
  if (typeof expression !== "string") throw new ComputeError("An expression string is required.");
  const trimmed = expression.trim();
  if (!trimmed) throw new ComputeError("An expression is required, e.g. \"pct_change(120, 87)\".");
  if (trimmed.length > MAX_INPUT) throw new ComputeError(`Expression is longer than ${MAX_INPUT} characters.`);

  const ast = new Parser(lex(trimmed)).parse();
  const result = unwrap(evaluate(ast));
  if (Array.isArray(result)) throw new ComputeError("The expression evaluates to a list. Wrap it in a statistic, e.g. mean([...]).");

  const precision = options.precision ?? 12;
  const warnings: string[] = [];
  if (Number.isNaN(result)) warnings.push("Result is NaN — an undefined operation such as 0/0 or the square root of a negative.");
  else if (!Number.isFinite(result)) warnings.push("Result overflowed to Infinity — a division by zero or a value too large for a double.");
  else if (Math.abs(result) > Number.MAX_SAFE_INTEGER) warnings.push("Magnitude is past 2^53; an integer this large is not represented exactly by a double.");

  const exact = Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER;
  const rendered = renderNumber(result, precision);

  let radixRendered: string | undefined;
  if (options.radix && Number.isFinite(result) && Number.isInteger(result)) {
    const prefix = options.radix === 16 ? "0x" : options.radix === 8 ? "0o" : "0b";
    radixRendered = (result < 0 ? "-" : "") + prefix + Math.abs(result).toString(options.radix);
  }

  return { value: result, exact, rendered, radixRendered, warnings };
}
