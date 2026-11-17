"""
Генерує демонстраційне сховище для Bases Relations Graph: вигадане OSINT-розслідування
з тією ж структурою, що й робоче сховище (Reports, Info/Facts, Info/Entities/…).

    python3 scripts/make-demo-vault.py demo-vault

Перезаписує нотатки сховища; тека .obsidian не чіпається. Потрібен PyYAML.
"""
import json
import os
import shutil
import sys

import yaml

ROOT = sys.argv[1] if len(sys.argv) > 1 else "demo-vault"
C1, C2 = "Case 101 - Northwind", "Case 102 - Greenfield"


def q(s):
    """Рядок у лапках для YAML."""
    return json.dumps(s, ensure_ascii=False)


def link(name):
    return q(f"[[{name}]]")


def write(path, props, body=""):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
    lines = []
    if props:
        lines.append("---")
        for k, v in props.items():
            if isinstance(v, bool):
                lines.append(f"{k}: {'true' if v else 'false'}")
            elif isinstance(v, list):
                lines.append(f"{k}:")
                lines += [f"  - {x}" for x in v]
            else:
                lines.append(f"{k}: {v}")
        lines.append("---")
    text = "\n".join(lines)
    if body:
        text += ("\n" if text else "") + body.strip()
    with open(full, "w", encoding="utf8") as f:
        f.write(text + "\n")


# ---------- Очищення (крім .obsidian) ----------
os.makedirs(ROOT, exist_ok=True)
for entry in os.listdir(ROOT):
    if entry == ".obsidian":
        continue
    p = os.path.join(ROOT, entry)
    shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

# ---------- Люди ----------
people = {
    "Daniel Hartley": dict(cases=[C1], citizenship=["United Kingdom"], socials="https://social.example/@dhartley", last_seen="2026-09-14"),
    "Maria Kovacs": dict(cases=[C1], citizenship=["Hungary"], socials="https://social.example/@mkovacs", last_seen="2026-10-02"),
    "Viktor Hale": dict(cases=[C2], citizenship=["Cyprus", "Malta"], socials="https://social.example/@vhale", last_seen="2026-10-11"),
}
for name, p in people.items():
    write(f"Info/Entities/People/{name}.md", {
        "cases": [q(c) for c in p["cases"]],
        "last_seen": p["last_seen"],
        "citizenship": [q(c) for c in p["citizenship"]],
        "socials": q(p["socials"]),
    })

# ---------- Організації ----------
orgs = {
    "Northwind Holdings": dict(cases=[C1], number="NH-448120", country="Cyprus", city="Kestrel Bay", tags=["holding"]),
    "Northwind Timber Ltd": dict(cases=[C1], number="NT-102934", country="Valmaria", city="Lorne", tags=["timber"], phone="+00 555 0101"),
    "Greenfield Agro LLC": dict(cases=[C2], number="GA-219845", country="Valmaria", city="Eastbridge", tags=["agriculture"], phone="+00 555 0144"),
    "Greenfield Organic": dict(cases=[C2], number="GO-219846", country="Valmaria", city="Kestrel Bay", tags=["agriculture", "shell-candidate"]),
    "Bluewater Logistics": dict(cases=[C2], number="BL-390112", country="Valmaria", city="Kestrel Bay", tags=["logistics", "shell-candidate"]),
}
for name, o in orgs.items():
    props = {
        "tags": o["tags"],
        "cases": [q(c) for c in o["cases"]],
        "last_seen": "2026-10-01",
        "company_number": q(o["number"]),
        "country": q(o["country"]),
        "city": [q(o["city"])],
    }
    if "phone" in o:
        props["phone"] = [q(o["phone"])]
    write(f"Info/Entities/Organizations/{name}.md", props)

# ---------- Місце, група, список ----------
write("Info/Entities/Places/Kestrel Bay Office Center.md",
      {"place_type": q("office building"), "country": q("Cyprus"), "city": q("Kestrel Bay")})
write("Info/Entities/Groups/Crestview Investment Committee.md", {"group_type": q("board")})
write("Info/Entities/Lists/Shell company candidates.md", {"list_type": q("organizations")},
      "Same address, no staff, no website:\n\n- [[Greenfield Organic]]\n- [[Bluewater Logistics]]")

# ---------- Відомості (нотатки-з'єднувачі) ----------
REG = "[Company registry](https://registry.example/company/{})"
NEWS = "[Article](https://news.example/{})"
facts = [
    ("Hartley is beneficial owner of Northwind Holdings", [C1], ["Daniel Hartley"], ["beneficial owner"], ["Northwind Holdings"], REG.format("NH-448120"), True),
    ("Northwind Holdings owns Northwind Timber", [C1], ["Northwind Holdings"], ["parent company"], ["Northwind Timber Ltd"], REG.format("NT-102934"), True),
    ("Kovacs directs Northwind Timber and Greenfield Agro", [C1, C2], ["Maria Kovacs"], ["director"], ["Northwind Timber Ltd", "Greenfield Agro LLC"], REG.format("NT-102934"), True),
    ("Hale is nominee director of two companies", [C2], ["Viktor Hale"], ["nominee director"], ["Greenfield Organic", "Bluewater Logistics"], REG.format("GO-219846"), False),
    ("Two companies share one address", [C2], ["Greenfield Organic", "Bluewater Logistics"], ["registered at"], ["Kestrel Bay Office Center"], REG.format("BL-390112"), True),
    ("Greenfield Agro pays Bluewater Logistics", [C2], ["Greenfield Agro LLC"], ["payments to"], ["Bluewater Logistics"], NEWS.format("greenfield-payments"), False),
    ("Hartley and Hale sit on the investment committee", [C1, C2], ["Daniel Hartley", "Viktor Hale"], ["member of"], ["Crestview Investment Committee"], NEWS.format("crestview-committee"), False),
]
for title, cases, subj, rel, obj, source, confirmed in facts:
    write(f"Info/Facts/{title}.md", {
        "cases": [q(c) for c in cases],
        "first_seen": "2026-06-01",
        "last_seen": "2026-10-15",
        "subjects": [link(s) for s in subj],
        "relations": [q(r) for r in rel],
        "objects": [link(o) for o in obj],
        "source": [q(source)],
        "confirmed": confirmed,
    })

# ---------- Звіт ----------
write("Reports/Case 101 - Northwind summary.md", {"cases": [q(C1)], "status": q("in progress")}, """
# Northwind ownership

[[Daniel Hartley]] controls [[Northwind Holdings]], which owns [[Northwind Timber Ltd]].
[[Maria Kovacs]] also directs [[Greenfield Agro LLC]] — a link to Case 102, where
[[Viktor Hale]] fronts two companies registered at the same address.

Open question: what connects Hartley and Hale besides the investment committee?
See the graph in [[Graph.base]].

*All people, companies, places and links in this vault are fictional.*
""")
# ---------- Graph.base: таблиці в повному форматі рядків, як їх зберігає плагін ----------
NODE = ["id", "name", "enabled", "condition", "shape", "color", "strokeColor", "strokeWidth", "sizeProperty", "sizeValue",
        "label", "labelIndex", "labelSize", "labelColor", "labelBackground", "show"]
EDGE = ["id", "name", "enabled", "source", "sourceValue", "target", "targetValue", "arrowToSource", "arrowToTarget",
        "color", "widthProperty", "widthValue", "label", "labelMode", "labelPosition", "labelSize", "labelColor", "labelBackground"]
GROUP = ["id", "name", "enabled", "groupBy", "direction", "color", "label", "labelSize", "labelColor", "labelBackground"]


def row(keys, **kw):
    r = {k: None for k in keys}
    r["enabled"] = True
    r.update(kw)
    return r


def folder(f):
    return {"and": [f'file.inFolder("{f}")']}


nodes = [
    row(NODE, id="ndefault", name="Default", shape="circle", color="rgba(140, 140, 140, 1)",
        sizeProperty="@links", sizeValue=1, label={"type": "property", "property": "file.basename"}, labelSize=13, show="show"),
    row(NODE, id="nfacts", name="Facts are links", condition=folder("Info/Facts"), show="hide"),
    row(NODE, id="nlists", name="Lists", condition=folder("Info/Entities/Lists"), show="hide"),
    row(NODE, id="npeople", name="People", condition=folder("Info/Entities/People"), shape="circle", color="rgba(82, 172, 57, 1)"),
    row(NODE, id="norgs", name="Organizations", condition=folder("Info/Entities/Organizations"), shape="square", color="rgba(74, 144, 226, 1)"),
    row(NODE, id="nshells", name="Shell candidates", condition={"and": ['note.tags.contains("shell-candidate")']},
        strokeColor="rgba(229, 72, 77, 1)", strokeWidth=3, label={"type": "text", "text": "shell?"}, labelIndex=1,
        labelSize=10, labelColor="rgba(255, 255, 255, 1)", labelBackground="rgba(229, 72, 77, 0.9)"),
    row(NODE, id="nplaces", name="Places", condition=folder("Info/Entities/Places"), shape="triangle", color="rgba(240, 145, 81, 1)"),
    row(NODE, id="ngroups", name="Groups", condition=folder("Info/Entities/Groups"), shape="diamond", color="rgba(167, 139, 250, 1)"),
]
edges = [
    row(EDGE, id="elinks", name="Links", source="@note", target="@links", arrowToSource=False, arrowToTarget=True,
        color="rgba(160, 160, 160, 0.8)", widthProperty="@fixed", widthValue=1, label={"type": "none"}),
    row(EDGE, id="erelations", name="Connector notes", source="note.subjects", target="note.objects",
        arrowToSource=False, arrowToTarget=True, color="rgba(240, 145, 81, 0.9)", widthProperty="@fixed", widthValue=1.5,
        label={"type": "property", "property": "note.relations"}, labelMode="tilted", labelPosition=50,
        labelSize=11, labelColor="rgba(200, 110, 50, 1)"),
]
groups = [
    row(GROUP, id="gcases", name="Cases", groupBy="note.cases", direction="ASC", labelSize=14, labelColor="@group"),
    row(GROUP, id="gtypes", name="Entity types", enabled=False, groupBy="file.folder", direction="ASC", labelColor="@group"),
]


def view(name, layout, extra):
    return {"type": "bases-relations-graph", "name": name, "order": ["file.name"], "layout": layout, **extra,
            "showLegend": True, "nodes": nodes, "edges": edges, "groups": groups}


base = {
    "filters": folder("Info"),
    "views": [view("Relations", "force", {"linkDistance": 160}), view("Tree", "tree", {"treeLinkStyle": "curved"})],
}


class Dumper(yaml.SafeDumper):
    pass


Dumper.ignore_aliases = lambda self, data: True  # кожне подання — з власною копією таблиць
Dumper.add_representer(type(None), lambda d, _: d.represent_scalar("tag:yaml.org,2002:null", ""))

os.makedirs(os.path.join(ROOT, "Reports"), exist_ok=True)
with open(os.path.join(ROOT, "Reports", "Graph.base"), "w", encoding="utf8") as f:
    yaml.dump(base, f, Dumper=Dumper, sort_keys=False, allow_unicode=True, default_flow_style=False, indent=2, width=200)

print("demo vault written to", ROOT)
