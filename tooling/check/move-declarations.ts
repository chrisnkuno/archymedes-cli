import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { applyCuts, declaredNames, isExported, namedImports, parse, removeUnused, resolveSpecifier, specifier, type Cut } from "./ts-edit";

/**
 * `bun run tooling/check/move-declarations.ts <from.ts> <to.ts> <Name>...` — moves top-level
 * declarations to another module, behaviour-free (paths relative to the CLI's source root):
 *
 * - each declaration moves with its leading comment, exported;
 * - the target gets the source's imports, re-rooted, plus imports of the source's own names the
 *   moved code uses (those must already be exported), then loses whatever it does not use;
 * - every importer of a moved name — the source included — imports it from the target instead.
 *
 * Follow with `bun run recheck`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SOURCE_ROOT = (JSON.parse(readFileSync(path.join(HERE, "sections.json"), "utf8")) as { sourceRoot: string }).sourceRoot;
const SOURCE = path.join(REPO, SOURCE_ROOT);

const [fromArgument, toArgument, ...names] = process.argv.slice(2);
if (!fromArgument || !toArgument || names.length === 0) {
  console.error("usage: move-declarations.ts <from.ts> <to.ts> <Name>...");
  process.exit(2);
}
const from = path.join(SOURCE, fromArgument);
const to = path.join(SOURCE, toArgument);
const moving = new Set(names);

const fromText = readFileSync(from, "utf8");
const fromSource = parse(from, fromText);
const moved: string[] = [];
const cuts: Cut[] = [];
for (const statement of fromSource.statements) {
  const declared = declaredNames(statement);
  if (!declared.some((name) => moving.has(name))) continue;
  if (!declared.every((name) => moving.has(name))) throw new Error(`${declared.join(", ")} share one statement: move them together`);
  const text = fromText.slice(statement.getFullStart(), statement.getEnd()).replace(/^\n+/, "");
  moved.push(isExported(statement) ? text : text.replace(/^((?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\n)*\s*)/, "$1export "));
  cuts.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
  for (const name of declared) moving.delete(name);
}
if (moving.size > 0) throw new Error(`not found in ${fromArgument}: ${[...moving].join(", ")}`);

// The target's imports: the source's own, re-rooted, and the source itself for its names.
const reRooted = fromSource.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
  const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
  const target = resolveSpecifier(from, spec);
  if (target === to) return []; // what the source imports from the target is the target's own
  return [target ? statement.getText().replace(spec, specifier(to, target)) : statement.getText()];
});
const ownExports = fromSource.statements.filter(isExported).flatMap(declaredNames).filter((name) => !names.includes(name));
const used = new Set(moved.join("\n").match(/[A-Za-z_$][\w$]*/g) ?? []);
const fromOwn = ownExports.filter((name) => used.has(name));
const existing = existsSync(to) ? readFileSync(to, "utf8") : "";
const header = [...new Set([...reRooted, ...(fromOwn.length > 0 ? [`import { ${fromOwn.join(", ")} } from "${specifier(to, from)}";`] : [])])]
  .filter((line) => !existing.includes(line))
  .join("\n");
writeFileSync(to, existing ? `${header}\n${existing.trimEnd()}\n\n${moved.join("\n\n")}\n` : `${header}\n\n${moved.join("\n\n")}\n`);
writeFileSync(from, applyCuts(fromText, cuts));

// Repoint every importer of a moved name, the source included.
let repointed = 0;
for (const file of walk(SOURCE)) {
  const text = readFileSync(file, "utf8");
  const source = parse(file, text);
  const edits: Cut[] = [];
  const add: string[] = [];
  for (const statement of source.statements) {
    const bindings = namedImports(statement);
    if (!bindings || resolveSpecifier(file, ((statement as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text) !== from) continue;
    const declaration = statement as ts.ImportDeclaration;
    const typeOnly = declaration.importClause!.isTypeOnly;
    const take = bindings.elements.filter((element) => names.includes((element.propertyName ?? element.name).text));
    if (take.length === 0) continue;
    const keep = bindings.elements.filter((element) => !take.includes(element));
    edits.push(keep.length > 0 || declaration.importClause!.name
      ? { start: bindings.getStart(), end: bindings.getEnd(), text: keep.length > 0 ? `{ ${keep.map((element) => element.getText()).join(", ")} }` : "{}" }
      : { start: declaration.getStart(), end: declaration.getEnd(), text: "" });
    add.push(`import ${typeOnly ? "type " : ""}{ ${take.map((element) => element.getText()).join(", ")} } from "${specifier(file, to)}";`);
  }
  // The source still using a moved name imports it like anyone else.
  if (file === from) {
    const rest = readFileSync(from, "utf8");
    const stillUsed = names.filter((name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(rest));
    if (stillUsed.length > 0) add.push(`import { ${stillUsed.join(", ")} } from "${specifier(from, to)}";`);
  }
  if (edits.length === 0 && add.length === 0) continue;
  const updated = applyCuts(text, edits);
  const lastImport = parse(file, updated).statements.filter(ts.isImportDeclaration).at(-1);
  const at = lastImport ? lastImport.getEnd() : 0;
  writeFileSync(file, `${updated.slice(0, at)}${at > 0 ? "\n" : ""}${add.join("\n")}${at > 0 ? "" : "\n"}${updated.slice(at)}`);
  repointed += 1;
}

removeUnused(REPO, `${SOURCE_ROOT}/`);
console.log(`moved ${names.join(", ")} → ${toArgument}; ${repointed} files import them from there`);

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}
