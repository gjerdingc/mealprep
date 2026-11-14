"""Statistics over past dinners, from the history in dinner_log.

Everything is worked out from the ingredients: a dinner counts as "with fish" when one of
its ingredients is fish, and weights are the ingredient amounts turned into grams.
"""

import json
from collections import Counter, defaultdict
from datetime import date, timedelta

from . import categorize, db

PERIODS = {"30": 30, "91": 91, "365": 365}
# Where the protein comes from: shown over time and per cook, in this order.
PROTEIN = ["rodt_kjott", "fugl", "fisk", "belgfrukter"]
MONTHS = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"]


def _start(period, today):
    if period == "year":
        return date(today.year, 1, 1)
    if period in PERIODS:
        return today - timedelta(days=PERIODS[period])
    return None  # all time


def build(c, period):
    today = db.today()
    start = _start(period, today)
    rows = [
        dict(r)
        for r in c.execute(
            "SELECT * FROM dinner_log WHERE date >= ? AND date < ? ORDER BY date",
            (start.isoformat() if start else "", today.isoformat()),
        )
    ]
    first_seen = {
        r["n"]: r["d"]
        for r in c.execute(
            "SELECT lower(recipe_name) AS n, MIN(date) AS d FROM dinner_log WHERE recipe_name != '' GROUP BY lower(recipe_name)"
        )
    }
    groups_of = {r["name"].lower(): json.loads(r["groups"]) for r in c.execute("SELECT * FROM ingredient_groups")}
    weights = {
        (r["name"].lower(), r["unit"].lower()): r["grams"]
        for r in c.execute("SELECT * FROM ingredient_weights WHERE grams IS NOT NULL")
    }
    names_missing, pairs_missing = categorize.missing(c)

    dinners = [r for r in rows if r["recipe_name"]]
    lines_total = lines_unweighed = 0
    for d in dinners:
        d["lines"] = []
        for line in json.loads(d["ingredients"]):
            gs = groups_of.get(line["name"].lower(), [])
            if line.get("side") or "basis" in gs:
                continue
            g = categorize.grams(line, weights)
            lines_total += 1
            lines_unweighed += g is None
            d["lines"].append({"name": line["name"], "groups": gs, "grams": g or 0})
        d["groups"] = {g for line in d["lines"] for g in line["groups"]}
    n = len(dinners)

    first = max(start or date.min, date.fromisoformat(rows[0]["date"])) if rows else today
    weeks = max(1.0, (today - first).days / 7)
    has = lambda g: sum(1 for d in dinners if g in d["groups"])  # noqa: E731
    vegetarian = sum(1 for d in dinners if not d["groups"] & {"rodt_kjott", "fugl", "fisk"})

    # Protein sources over time, in grams: per week for up to half a year, per month beyond.
    monthly = (today - first).days > 26 * 7
    buckets = {}
    for d in dinners:
        day = date.fromisoformat(d["date"])
        if monthly:
            key, label = day.strftime("%Y-%m"), MONTHS[day.month - 1] + (f" {day.year % 100:02d}" if day.month == 1 else "")
        else:
            iso = day.isocalendar()
            key, label = f"{iso[0]}-{iso[1]:02d}", str(iso[1])
        b = buckets.setdefault(key, {"label": label, "grams": Counter(), "dinners": 0})
        b["dinners"] += 1
        for line in d["lines"]:
            for g in PROTEIN:
                if g in line["groups"]:
                    b["grams"][g] += line["grams"]
    over_time = [{"label": b["label"], "grams": dict(b["grams"]), "dinners": b["dinners"]} for _, b in sorted(buckets.items())]

    cooks = defaultdict(lambda: {"total": 0, "grams": Counter(), "weekdays": [0] * 7})
    for d in dinners:
        x = cooks[d["cook_name"] or ""]
        x["total"] += 1
        x["weekdays"][date.fromisoformat(d["date"]).weekday()] += 1
        for line in d["lines"]:
            for g in PROTEIN:
                if g in line["groups"]:
                    x["grams"][g] += line["grams"]
    cook_list = sorted(
        ({"name": k, "total": v["total"], "grams": dict(v["grams"]), "weekdays": v["weekdays"]} for k, v in cooks.items()),
        key=lambda x: (x["name"] == "", -x["total"]),
    )

    group_grams = Counter()
    for d in dinners:
        for line in d["lines"]:
            for g in line["groups"]:
                group_grams[g] += line["grams"]
    groups = [
        {"key": g, "label": label, "share": has(g) / n if n else 0, "grams": group_grams[g]}
        for g, label in categorize.GROUPS.items()
        if g != "basis"
    ]

    dish_rows = defaultdict(lambda: {"count": 0, "cooks": Counter(), "last": ""})
    for d in dinners:
        x = dish_rows[d["recipe_name"]]
        x["count"] += 1
        if d["cook_name"]:
            x["cooks"][d["cook_name"]] += 1
        x["last"] = max(x["last"], d["date"])
    top_dishes = sorted(
        (
            {"name": k, "count": v["count"], "cook": v["cooks"].most_common(1)[0][0] if v["cooks"] else "", "last": v["last"]}
            for k, v in dish_rows.items()
        ),
        key=lambda x: (-x["count"], x["name"].lower()),
    )[:10]

    ing_count, ing_grams, ing_names = Counter(), Counter(), {}
    for d in dinners:
        seen = set()
        for line in d["lines"]:
            k = line["name"].lower()
            ing_names.setdefault(k, line["name"])
            ing_grams[k] += line["grams"]
            if k not in seen:
                ing_count[k] += 1
                seen.add(k)
    top_ings = [{"name": ing_names[k], "count": v, "grams": ing_grams[k]} for k, v in ing_count.most_common(12)]

    start_iso = start.isoformat() if start else None
    return {
        "period": period,
        "dinners": n,
        "without_recipe": len(rows) - n,
        "distinct": len(dish_rows),
        "new": sum(1 for k in dish_rows if start_iso and first_seen.get(k.lower(), "") >= start_iso),
        "weeks": round(weeks, 1),
        "fish": has("fisk"),
        "fish_per_week": has("fisk") / weeks,
        "vegetarian": vegetarian,
        "ultra": has("ultraprosessert"),
        "total_grams": sum(line["grams"] for d in dinners for line in d["lines"]),
        "lines": lines_total,
        "lines_unweighed": lines_unweighed,
        "protein": PROTEIN,
        "over_time": over_time,
        "monthly": monthly,
        "cooks": cook_list,
        "groups": groups,
        "top_dishes": top_dishes,
        "top_ingredients": top_ings,
        "labels": categorize.GROUPS,
        "missing": {"names": len(names_missing), "weights": len(pairs_missing)},
        "ai": categorize.is_configured(),
    }


def categories(c):
    """Every ingredient with its food groups and the weight of each unit it is used in."""
    names, pairs = categorize.used(c)
    groups_of = {r["name"].lower(): (json.loads(r["groups"]), bool(r["manual"])) for r in c.execute("SELECT * FROM ingredient_groups")}
    weights = {(r["name"].lower(), r["unit"].lower()): (r["grams"], bool(r["manual"])) for r in c.execute("SELECT * FROM ingredient_weights")}
    units = defaultdict(list)
    for (k, uk), (_, unit) in sorted(pairs.items()):
        grams, manual = weights.get((k, uk), (None, False))
        units[k].append({"unit": unit, "grams": grams, "manual": manual, "known": (k, uk) in weights})
    return {
        "groups": categorize.GROUPS,
        "ingredients": sorted(
            (
                {
                    "name": n,
                    "groups": groups_of.get(k, (None, False))[0],
                    "manual": groups_of.get(k, (None, False))[1],
                    "units": units.get(k, []),
                }
                for k, n in names.items()
            ),
            key=lambda x: x["name"].lower(),
        ),
    }
