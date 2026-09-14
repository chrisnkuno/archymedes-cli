"""Lists (or with --fix removes) named imports a file no longer references.

    python3 tooling/check/unused_imports.py <file.ts> [--fix]
"""
import re, sys

path, fix = sys.argv[1], "--fix" in sys.argv
text = open(path).read()
IMPORT = re.compile(r'import\s+(type\s+)?\{([^}]*)\}\s+from\s+("[^"]+");[ \t]*\n')
body = IMPORT.sub("", text)
unused_total = []

def keep(item):
    local = re.sub(r"^type\s+", "", item).split(" as ")[-1].strip()
    # A preceding "." is a property access, except in a spread ("...name").
    used = any(
        m.start() < 1 or body[m.start() - 1] != "." or body[max(0, m.start() - 3):m.start()] == "..."
        for m in re.finditer(rf"(?<![\w$]){re.escape(local)}(?![\w$])", body)
    )
    if not used:
        unused_total.append(local)
    return used

def rewrite(match):
    items = [i.strip() for i in match.group(2).split(",") if i.strip()]
    kept = [i for i in items if keep(i)]
    if not kept:
        return ""
    return f'import {match.group(1) or ""}{{ {", ".join(kept)} }} from {match.group(3)};\n'

updated = IMPORT.sub(rewrite, text)
print(f"{path}: {len(unused_total)} unused import(s){' removed' if fix else ''}" if len(unused_total) > 12 else f"{path}: unused {unused_total}")
if fix and updated != text:
    open(path, "w").write(updated)
