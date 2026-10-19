import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Syntax-aware edits shared by the refactoring tools (remove-dead.ts, move-declarations.ts). */

export type Cut = { start: number; end: number; text: string };

export function parse(file: string, text = readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** Applies non-overlapping cuts (one per start position), collapsing the blank lines they leave. */
export function applyCuts(text: string, cuts: readonly Cut[]): string {
  let out = text;
  const done = new Set<number>();
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) {
    if (done.has(cut.start)) continue;
    done.add(cut.start);
    out = out.slice(0, cut.start) + cut.text + out.slice(cut.end);
  }
  return out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : ""));
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) return statement.name ? [statement.name.text] : [];
  return [];
}

export function isExported(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

export function namedImports(statement: ts.Statement): ts.NamedImports | undefined {
  if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) return undefined;
  return ts.isNamedImports(statement.importClause.namedBindings) ? statement.importClause.namedBindings : undefined;
}

/** The cut that drops `drop` from an import's named list, or the whole import when nothing is left. */
export function shrinkImport(statement: ts.ImportDeclaration, bindings: ts.NamedImports, drop: (element: ts.ImportSpecifier) => boolean): Cut | undefined {
  const keep = bindings.elements.filter((element) => !drop(element));
  if (keep.length === bindings.elements.length) return undefined;
  if (keep.length > 0) return { start: bindings.getStart(), end: bindings.getEnd(), text: `{ ${keep.map((element) => element.getText()).join(", ")} }` };
  if (statement.importClause!.name) return { start: statement.importClause!.name.getEnd(), end: bindings.getEnd(), text: "" };
  return { start: statement.getFullStart(), end: statement.getEnd(), text: "" };
}

/** A relative specifier from one file to another, without the extension, as this repo writes them. */
export function specifier(fromFile: string, toFile: string): string {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/").replace(/\.tsx?$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** The file a relative specifier in `fromFile` names, if it is a TypeScript file. */
export function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (/\.tsx?$/.test(candidate)) {
      try { readFileSync(candidate); return candidate; } catch { /* next */ }
    }
  }
  return undefined;
}

/**
 * Removes what `tsc --noUnusedLocals` reports unused in files under `prefix` (repo-relative):
 * import specifiers, and private top-level declarations. Repeats until a round changes nothing;
 * returns the positions it left for a person (unused parameters, destructured names…).
 */
export function removeUnused(repo: string, prefix: string, write = true): string[] {
  for (;;) {
    const output = spawnSync("bunx", ["tsc", "--noEmit", "-p", "tsconfig.json", "--noUnusedLocals"], { cwd: repo, encoding: "utf8" }).stdout;
    const byFile = new Map<string, Array<[number, number]>>();
    for (const match of output.matchAll(/^([^(\n]+)\((\d+),(\d+)\): error TS(?:6133|6192|6196|6198)/gm)) {
      if (!match[1]!.startsWith(prefix)) continue;
      const list = byFile.get(match[1]!) ?? [];
      list.push([Number(match[2]), Number(match[3])]);
      byFile.set(match[1]!, list);
    }
    const manual: string[] = [];
    let changed = 0;
    for (const [relative, positions] of byFile) {
      const file = path.join(repo, relative);
      const text = readFileSync(file, "utf8");
      const source = parse(file, text);
      const cuts: Cut[] = [];
      const unusedSpecifiers = new Set<number>();
      for (const [line, column] of positions) {
        const at = source.getPositionOfLineAndCharacter(line - 1, column - 1);
        const statement = source.statements.find((candidate) => candidate.getStart() <= at && at < candidate.getEnd());
        if (!statement) continue;
        const bindings = namedImports(statement);
        const element = bindings?.elements.find((candidate) => candidate.getStart() <= at && at < candidate.getEnd());
        const names = declaredNames(statement);
        if (element) unusedSpecifiers.add(element.getStart());
        else if (ts.isImportDeclaration(statement)) cuts.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
        else if (!isExported(statement) && names.length === 1 && text.slice(at).startsWith(names[0]!)) cuts.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
        else manual.push(`${relative}:${line}:${column}`);
      }
      for (const statement of source.statements) {
        const bindings = namedImports(statement);
        const shrink = bindings && shrinkImport(statement as ts.ImportDeclaration, bindings, (candidate) => unusedSpecifiers.has(candidate.getStart()));
        if (shrink && !cuts.some((cut) => cut.start === statement.getFullStart())) cuts.push(shrink);
      }
      if (cuts.length === 0) continue;
      if (write) writeFileSync(file, applyCuts(text, cuts));
      changed += 1;
    }
    if (changed === 0 || !write) return manual;
  }
}
