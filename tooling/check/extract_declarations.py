"""Moves named top-level declarations out of a module into another one, behaviour-free.

    python3 tooling/check/extract_declarations.py <from.ts> <to.ts> <Name> [<Name> ...] [--header "doc comment text"]

Paths are relative to packages/archymedes-cli/src. Each declaration moves with its leading comment.
The target receives the source's imports (re-rooted and pruned) and every moved name is exported;
the source imports back whatever it still uses, and other importers are repointed. Always follow
with `bun run typecheck` and the recheck the tracker names.
"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(REPO, "packages", "archymedes-cli", "src")
DECLARATION = re.compile(r"^(export\s+)?(async\s+)?(function|const|let|type|class|interface)\s+([A-Za-z_$][\w$]*)")
CLOSERS = {"}", "};", "});", "})", ")", ");", "]", "];"}


def declaration_spans(lines, names):
    spans = []
    for index, line in enumerate(lines):
        match = DECLARATION.match(line)
        if not match or match.group(4) not in names:
            continue
        start = index
        while start > 0 and re.match(r"^(/\*\*|\s\*|//)", lines[start - 1]):
            start -= 1
        end = index
        if not re.search(r";\s*$", line) or line.rstrip().endswith("{"):
            end = index + 1
            while end < len(lines) and lines[end].rstrip() not in CLOSERS:
                end += 1
        spans.append((start, end + 1, match.group(4)))
    missing = set(names) - {name for _, _, name in spans}
    if missing:
        sys.exit(f"not found at top level: {sorted(missing)}")
    return sorted(spans)


def main():
    args = sys.argv[1:]
    header = ""
    if "--header" in args:
        position = args.index("--header")
        header = args[position + 1]
        del args[position:position + 2]
    source_rel, target_rel, *names = args
    source, target = os.path.join(SRC, source_rel), os.path.join(SRC, target_rel)
    lines = open(source).read().split("\n")
    spans = declaration_spans(lines, set(names))

    moved, kept, cursor = [], [], 0
    for start, end, _ in spans:
        kept.extend(lines[cursor:start])
        block = lines[start:end]
        declaration = next(i for i, l in enumerate(block) if DECLARATION.match(l))
        if not block[declaration].startswith("export "):
            block[declaration] = "export " + block[declaration]
        moved.append("\n".join(block))
        cursor = end
        while cursor < len(lines) and lines[cursor] == "" and kept and kept[-1] == "":
            cursor += 1
    kept.extend(lines[cursor:])

    import_end = next(i for i, l in enumerate(kept) if l and not re.match(r"^(import\b|#!|\s|\}|  )", l))
    imports = [l for l in kept[:import_end] if not l.startswith("#!")]
    depth = target_rel.count("/") - source_rel.count("/")
    def reroot(line):
        def fix(match):
            resolved = os.path.normpath(os.path.join(os.path.dirname(source), match.group(2)))
            relative = os.path.relpath(resolved, os.path.dirname(target)).replace(os.sep, "/")
            return match.group(1) + (relative if relative.startswith("../") else "./" + relative) + match.group(3)
        return re.sub(r'''(from\s+["']|import\(["'])(\.{1,2}/[^"']+)(["'])''', fix, line)
    target_text = "\n".join(reroot(l) for l in imports).rstrip() + "\n\n"
    if header:
        target_text += "/**\n" + "\n".join(f" * {l}" if l else " *" for l in header.split("\n")) + "\n */\n\n"
    target_text += "\n\n".join(moved).rstrip() + "\n"
    if os.path.exists(target):
        sys.exit(f"{target_rel} already exists; extract into a new module")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    open(target, "w").write(target_text)

    source_text = "\n".join(kept)
    body = "\n".join(kept[import_end:])
    still_used = [n for n in names if re.search(rf"(?<![\w$]){re.escape(n)}(?![\w$])", body)]
    specifier = os.path.relpath(re.sub(r"\.tsx?$", "", target), os.path.dirname(source)).replace(os.sep, "/")
    specifier = specifier if specifier.startswith("../") else "./" + specifier
    if still_used:
        type_names = {name for _, _, name in spans if re.search(rf"^(export\s+)?(type|interface)\s+{re.escape(name)}\b", open(target).read(), re.M)}
        items = [f"type {n}" if n in type_names else n for n in sorted(still_used)]
        statement = f'import type {{ {", ".join(sorted(still_used))} }} from "{specifier}";' if all(n in type_names for n in still_used) else f'import {{ {", ".join(items)} }} from "{specifier}";'
        last_import = max(i for i, l in enumerate(kept[:import_end]) if l.startswith("import ") or l.rstrip().endswith(";"))
        kept.insert(last_import + 1, statement)
        source_text = "\n".join(kept)
    open(source, "w").write(source_text)

    run = lambda *cmd: subprocess.run(cmd, cwd=REPO, check=True)
    run("python3", os.path.join(HERE, "unused_imports.py"), target, "--fix")
    run("python3", os.path.join(HERE, "rewrite_imports.py"), "move-symbols", source_rel, target_rel, *names)
    run("python3", os.path.join(HERE, "unused_imports.py"), source, "--fix")
    print(f"moved {len(spans)} declarations ({sum(e - s for s, e, _ in spans)} lines) to {target_rel}; source imports back {still_used}")


if __name__ == "__main__":
    main()
