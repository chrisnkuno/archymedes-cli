"""Import rewriting for structural refactors in packages/archymedes-cli.

  move-symbols <from-module> <to-module> <Name> [<Name> ...]
      Repoint named imports of the given symbols from one module to another in every importer.
      (Moving the declarations themselves is done separately; this only fixes who imports what.)

  move-files <mapping.json>
      `git mv` each "old/path.ts": "new/path.ts" (paths relative to the source root, tests follow
      their module) and rewrite every relative import, dynamic import() and vi.mock() specifier
      in the source tree and tooling/dev so it still resolves.

Both are behaviour-free and idempotent enough to rerun after a partial failure.
"""
import json, os, re, subprocess, sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(REPO, "packages", "archymedes-cli", "src")
EXTRA_ROOTS = [os.path.join(REPO, "tooling", "dev")]
SPECIFIER = re.compile(r'''((?:from\s+|import\s*\(\s*|vi\.mock\(\s*|^import\s+)["'])(\.{1,2}/[^"']+)(["'])''', re.M)
NAMED_IMPORT = re.compile(r'''import\s+(type\s+)?\{([^}]*)\}\s+from\s+["'](\.{1,2}/[^"']+)["'];?[ \t]*\n?''')


def code_files():
    for root in [SRC, *EXTRA_ROOTS]:
        for directory, _, files in os.walk(root):
            if "node_modules" in directory:
                continue
            for name in files:
                if re.search(r"\.tsx?$", name):
                    yield os.path.join(directory, name)


def resolve(importer, specifier):
    base = os.path.normpath(os.path.join(os.path.dirname(importer), specifier))
    for candidate in (base, base + ".ts", base + ".tsx"):
        if os.path.isfile(candidate):
            return candidate
    return None


def specifier_for(importer, target):
    relative = os.path.relpath(re.sub(r"\.tsx?$", "", target), os.path.dirname(importer)).replace(os.sep, "/")
    return relative if relative.startswith("../") else "./" + relative


def move_symbols(from_module, to_module, names):
    source = os.path.join(SRC, from_module)
    target = os.path.join(SRC, to_module)
    wanted = set(names)
    changed = 0
    for path in code_files():
        text = open(path).read()
        out, last = [], 0
        for match in NAMED_IMPORT.finditer(text):
            if resolve(path, match.group(3)) != source or path == target:
                continue
            whole_type = bool(match.group(1))
            items = [item.strip() for item in match.group(2).split(",") if item.strip()]
            moving = [i for i in items if re.sub(r"^type\s+", "", i).split(" as ")[0].strip() in wanted]
            if not moving:
                continue
            staying = [i for i in items if i not in moving]
            prefix = "import type " if whole_type else "import "
            replacement = ""
            if staying:
                replacement += f'{prefix}{{ {", ".join(staying)} }} from "{match.group(3)}";\n'
            replacement += f'{prefix}{{ {", ".join(moving)} }} from "{specifier_for(path, target)}";\n'
            out.append(text[last:match.start()])
            out.append(replacement)
            last = match.end()
        if out:
            out.append(text[last:])
            open(path, "w").write("".join(out))
            changed += 1
    print(f"repointed {sorted(wanted)} in {changed} files")


def move_files(mapping_path):
    mapping = json.load(open(mapping_path))
    moves = {}
    for old, new in mapping.items():
        moves[os.path.join(SRC, old)] = os.path.join(SRC, new)
        stem_old, stem_new = re.sub(r"\.tsx?$", "", old), re.sub(r"\.tsx?$", "", new)
        for ext in (".test.ts", ".test.tsx"):
            if os.path.isfile(os.path.join(SRC, stem_old + ext)):
                moves[os.path.join(SRC, stem_old + ext)] = os.path.join(SRC, stem_new + ext)
    # Resolve every specifier against the tree as it is now, before anything moves.
    plans = {}
    for path in code_files():
        text = open(path).read()
        targets = {}
        for match in SPECIFIER.finditer(text):
            resolved = resolve(path, match.group(2))
            if resolved:
                targets[match.group(2)] = resolved
        plans[path] = targets
    for old, new in moves.items():
        os.makedirs(os.path.dirname(new), exist_ok=True)
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", old], cwd=REPO, capture_output=True).returncode == 0
        if tracked:
            subprocess.run(["git", "mv", old, new], cwd=REPO, check=True)
        else:
            os.rename(old, new)
    rewritten = 0
    for old_path, targets in plans.items():
        path = moves.get(old_path, old_path)
        text = open(path).read()
        def replace(match):
            target = targets.get(match.group(2))
            if not target:
                return match.group(0)
            return f"{match.group(1)}{specifier_for(path, moves.get(target, target))}{match.group(3)}"
        updated = SPECIFIER.sub(replace, text)
        if updated != text:
            open(path, "w").write(updated)
            rewritten += 1
    print(f"moved {len(moves)} files, rewrote imports in {rewritten} files")


def merge_duplicate_imports():
    """Joins `import { a } from "x"` statements that name the same module with the same type-ness."""
    merged_files = 0
    for path in code_files():
        text = open(path).read()
        seen = {}
        drop = []
        for match in NAMED_IMPORT.finditer(text):
            key = (bool(match.group(1)), match.group(3))
            items = [i.strip() for i in match.group(2).split(",") if i.strip()]
            if key in seen:
                seen[key][1].extend(i for i in items if i not in seen[key][1])
                drop.append(match)
            else:
                seen[key] = (match, items)
        if not drop:
            continue
        pieces, last = [], 0
        for match in sorted([m for m, _ in seen.values()] + drop, key=lambda m: m.start()):
            pieces.append(text[last:match.start()])
            if match not in drop:
                first, items = seen[(bool(match.group(1)), match.group(3))]
                prefix = "import type " if match.group(1) else "import "
                pieces.append(f'{prefix}{{ {", ".join(items)} }} from "{match.group(3)}";\n')
            last = match.end()
        pieces.append(text[last:])
        open(path, "w").write("".join(pieces))
        merged_files += 1
    print(f"merged duplicate imports in {merged_files} files")


if __name__ == "__main__":
    command, *rest = sys.argv[1:]
    if command == "move-symbols":
        move_symbols(rest[0], rest[1], rest[2:])
        merge_duplicate_imports()
    elif command == "move-files":
        move_files(rest[0])
        merge_duplicate_imports()
    elif command == "merge-imports":
        merge_duplicate_imports()
    else:
        sys.exit(__doc__)
