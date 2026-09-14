"""Lists exported symbols of packages/archymedes-cli/src that no other source file uses.

    python3 tooling/check/unused_exports.py [--json]

"tests only" means only tests reach the export (its own module never uses it either): usually a
finished component that was never wired in. "unused" means nothing references it at all. Names used
inside their own file are reported separately, as exports that may only need `export` removed.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(REPO, json.load(open(os.path.join(HERE, "sections.json")))["sourceRoot"])
EXPORT = re.compile(r"^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)", re.M)


def files():
    for directory, _, names in os.walk(SRC):
        for name in names:
            if re.search(r"\.tsx?$", name):
                yield os.path.relpath(os.path.join(directory, name), SRC).replace(os.sep, "/")


all_files = sorted(files())
texts = {f: open(os.path.join(SRC, f)).read() for f in all_files}
is_test = lambda f: bool(re.search(r"\.test\.tsx?$", f)) or f.startswith("pty/")
report = {"tests only": [], "unused": [], "internal only": []}
for f in all_files:
    if is_test(f):
        continue
    for name in EXPORT.findall(texts[f]):
        word = re.compile(rf"(?<![\w$]){re.escape(name)}(?![\w$])")
        elsewhere = [g for g in all_files if g != f and word.search(texts[g])]
        product = [g for g in elsewhere if not is_test(g)]
        if product:
            continue
        own_uses = len(word.findall(texts[f])) - 1
        entry = {"file": f, "name": name, "tests": [g for g in elsewhere if is_test(g)]}
        if own_uses > 0:
            report["internal only"].append(entry)
        elif entry["tests"]:
            report["tests only"].append(entry)
        else:
            report["unused"].append(entry)

if "--json" in sys.argv:
    print(json.dumps(report, indent=1))
else:
    for kind, entries in report.items():
        print(f"\n{kind}: {len(entries)}")
        by_file = {}
        for e in entries:
            by_file.setdefault(e["file"], []).append(e["name"])
        for f, names in sorted(by_file.items()):
            print(f"  {f}: {', '.join(names)}")
