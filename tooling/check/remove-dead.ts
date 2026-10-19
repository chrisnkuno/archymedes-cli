import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findUnwiredExports, readTree } from "./guards";
import { applyCuts, declaredNames, namedImports, removeUnused, shrinkImport, type Cut } from "./ts-edit";

/**
 * `bun run tooling/check/remove-dead.ts [--dry-run]` — deletes what nothing reaches, in waves,
 * until a wave finds nothing:
 *
 * 1. exports only tests reach (the `unwired` guard, minus `unwired-allow.json`): their top-level
 *    declarations, with leading comments;
 * 2. the tests of those exports: an `it`/`test` naming one is removed, a `describe` left empty
 *    goes with it, a test file left with no tests is deleted;
 * 3. what that leaves unused (`tsc --noUnusedLocals`): import specifiers, and private top-level
 *    declarations. Anything else unused is listed for a person to look at.
 *
 * Deleting one wave exposes the next (a helper only a deleted export used), hence the loop. Run
 * `bun run recheck --all` after it: the tool is syntax-aware, but only the tests prove behaviour.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SOURCE = path.join(REPO, (JSON.parse(readFileSync(path.join(HERE, "sections.json"), "utf8")) as { sourceRoot: string }).sourceRoot);
const dryRun = process.argv.includes("--dry-run");

/** Step 1: the unwired exports' declarations. Returns the names removed. */
function removeUnwired(): Set<string> {
  const allow = new Set(Object.keys(JSON.parse(readFileSync(path.join(HERE, "unwired-allow.json"), "utf8")) as Record<string, string>));
  const unwired = findUnwiredExports(readTree(SOURCE), [], allow);
  const removed = new Set<string>();
  for (const [relative, names] of Object.entries(unwired)) {
    const file = path.join(SOURCE, relative);
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const wanted = new Set(names);
    const cuts: Cut[] = [];
    for (const statement of source.statements) {
      const declared = declaredNames(statement);
      const hit = declared.filter((name) => wanted.has(name));
      if (hit.length === 0) continue;
      if (hit.length !== declared.length) { console.log(`  keep ${relative}: ${declared.join(", ")} share one statement`); continue; }
      cuts.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
      for (const name of hit) removed.add(name);
    }
    if (cuts.length > 0) console.log(`  ${relative}: ${names.filter((name) => removed.has(name)).join(", ")}`);
    if (!dryRun) writeFileSync(file, applyCuts(text, cuts));
  }
  return removed;
}

/** Step 2: tests of removed names. */
function pruneTests(removed: ReadonlySet<string>): void {
  const uses = (node: ts.Node): boolean => (ts.isIdentifier(node) && removed.has(node.text) && !ts.isImportSpecifier(node.parent)) || ts.forEachChild(node, uses) === true;
  const callee = (statement: ts.Statement) => (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression.expression.getText().split(".")[0] : undefined);
  for (const relative of Object.keys(readTree(SOURCE, (file) => /\.test\.tsx?$/.test(file)))) {
    const file = path.join(SOURCE, relative);
    const text = readFileSync(file, "utf8");
    if (![...removed].some((name) => text.includes(name))) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const cuts: Cut[] = [];
    let tests = 0;
    let cut = 0;
    const visit = (statements: readonly ts.Statement[]): number => {
      let kept = 0;
      for (const statement of statements) {
        const name = callee(statement);
        const whole = { start: statement.getFullStart(), end: statement.getEnd(), text: "" };
        if (name === "it" || name === "test") {
          tests += 1;
          if (uses(statement)) { cuts.push(whole); cut += 1; } else kept += 1;
        } else if (name === "describe") {
          const call = (statement as ts.ExpressionStatement).expression as ts.CallExpression;
          const body = call.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) as ts.ArrowFunction | undefined;
          if (!body || !ts.isBlock(body.body)) { kept += 1; continue; }
          const before = cuts.length;
          const inside = visit(body.body.statements);
          if (inside === 0) { cuts.splice(before); cuts.push(whole); } else kept += inside;
        } else if (!ts.isImportDeclaration(statement) && uses(statement)) cuts.push(whole);
      }
      return kept;
    };
    const kept = visit(source.statements);
    if (tests > 0 && kept === 0) {
      console.log(`  ${relative}: deleted (all ${tests} tests were of removed code)`);
      if (!dryRun) unlinkSync(file);
      continue;
    }
    for (const statement of source.statements) {
      const bindings = namedImports(statement);
      const shrink = bindings && shrinkImport(statement as ts.ImportDeclaration, bindings, (element) => removed.has(element.name.text));
      if (shrink) cuts.push(shrink);
    }
    if (cut > 0) console.log(`  ${relative}: ${cut} of ${tests} tests`);
    if (!dryRun) writeFileSync(file, applyCuts(text, cuts));
  }
}

for (let wave = 1; ; wave++) {
  console.log(`wave ${wave}`);
  const removed = removeUnwired();
  if (removed.size === 0) {
    const manual = removeUnused(REPO, `${path.relative(REPO, SOURCE)}/`, !dryRun);
    console.log(manual.length > 0 ? `nothing left to remove; unused, for a person to look at:\n  ${manual.join("\n  ")}` : "nothing left to remove");
    break;
  }
  pruneTests(removed);
  removeUnused(REPO, `${path.relative(REPO, SOURCE)}/`, !dryRun);
  if (dryRun) break;
}
