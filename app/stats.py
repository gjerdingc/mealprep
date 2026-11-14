"""Statistics over past dinners, from the history in dinner_log."""

import json
from collections import Counter, defaultdict
from datetime import date, timedelta

from . import categorize, db

PERIODS = {"30": 30, "91": 91, "365": 365}


def _start(period, today):
    if period == "year":
        return date(today.year, 1, 1)
    if period in PERIODS:
        return today - timedelta(days=PERIODS[period])
    return date.min  # "all"


def build(c, period):
    today = db.today()
    start = _start(period, today)
    rows = [
        dict(r)
        for r in c.execute(
            "SELECT * FROM dinner_log WHERE date >= ? AND date < ? ORDER BY date",
            (start.isoformat() if start > date.min else "", today.isoformat()),
        )
    ]
    first_seen = {
        r["n"]: r["d"]
        for r in c.execute(
            "SELECT lower(recipe_name) AS n, MIN(date) AS d FROM dinner_log WHERE recipe_name != '' GROUP BY lower(recipe_name)"
        )
    }
    groups_of = {r["name"].lower(): json.loads(r["groups"]) for r in c.execute("SELECT * FROM ingredient_groups")}
    kind_of = {r["name"].lower(): r["kind"] for r in c.execute("SELECT * FROM recipe_kinds")}
    ings_missing, dishes_missing = categorize.missing(c)

    dinners = [r for r in rows if r["recipe_name"]]
    for d in dinners:
        d["kind"] = kind_of.get(d["recipe_name"].lower(), "ukjent")
        d["ings"] = list(dict.fromkeys(i["name"] for i in json.loads(d["ingredients"]) if not i.get("side")))
        d["groups"] = {g for n in d["ings"] for g in groups_of.get(n.lower(), [])}
    n = len(dinners)

    # Weeks covered: from the first dinner in the period (or the period's start) to yesterday.
    first = max(start, date.fromisoformat(rows[0]["date"])) if rows else today
    days_covered = max(1, (today - first).days)
    weeks_covered = max(1.0, days_covered / 7)

    by_kind = Counter(d["kind"] for d in dinners)

    # Dinner kinds over time: per week for up to half a year, per month beyond that.
    monthly = days_covered > 26 * 7
    buckets = {}
    for d in dinners:
        day = date.fromisoformat(d["date"])
        if monthly:
            key, label = day.strftime("%Y-%m"), MONTHS[day.month - 1] + (f" {day.year % 100:02d}" if day.month == 1 else "")
        else:
            iso = day.isocalendar()
            key, label = f"{iso[0]}-{iso[1]:02d}", str(iso[1])
        b = buckets.setdefault(key, {"label": label, "counts": Counter()})
        b["counts"][d["kind"]] += 1
    over_time = [
        {"label": b["label"], "counts": dict(b["counts"])} for _, b in sorted(buckets.items())
    ]

    cooks = defaultdict(lambda: {"total": 0, "kinds": Counter(), "weekdays": [0] * 7})
    for d in dinners:
        who = d["cook_name"] or ""
        cooks[who]["total"] += 1
        cooks[who]["kinds"][d["kind"]] += 1
        cooks[who]["weekdays"][date.fromisoformat(d["date"]).weekday()] += 1
    cook_list = sorted(
        ({"name": k, "total": v["total"], "kinds": dict(v["kinds"]), "weekdays": v["weekdays"]} for k, v in cooks.items()),
        key=lambda x: (x["name"] == "", -x["total"]),
    )

    group_counts = Counter(g for d in dinners for g in d["groups"] if g != "basis")
    groups = [
        {"key": g, "label": label, "share": group_counts[g] / n if n else 0}
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

    ing_counts = Counter()
    ing_names = {}
    for d in dinners:
        for name in d["ings"]:
            if "basis" in groups_of.get(name.lower(), []):
                continue
            ing_counts[name.lower()] += 1
            ing_names.setdefault(name.lower(), name)
    top_ings = [{"name": ing_names[k], "count": v} for k, v in ing_counts.most_common(12)]

    return {
        "period": period,
        "start": rows[0]["date"] if rows else None,
        "dinners": n,
        "without_recipe": len(rows) - n,
        "distinct": len(dish_rows),
        "new": sum(1 for k in dish_rows if first_seen.get(k.lower(), "") >= (start.isoformat() if start > date.min else "9999")),
        "weeks": round(weeks_covered, 1),
        "by_kind": dict(by_kind),
        "fish_per_week": by_kind["fisk"] / weeks_covered,
        "ultra": sum(1 for d in dinners if "ultraprosessert" in d["groups"]),
        "over_time": over_time,
        "monthly": monthly,
        "cooks": cook_list,
        "groups": groups,
        "top_dishes": top_dishes,
        "top_ingredients": top_ings,
        "kinds": categorize.KINDS,
        "missing": {"ingredients": len(ings_missing), "dishes": len(dishes_missing)},
        "ai": categorize.is_configured(),
    }


MONTHS = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"]


def categories(c):
    """Everything that can be sorted, with how it is sorted now, for the correction lists."""
    names, dishes = categorize._used(c)
    groups_of = {r["name"].lower(): (json.loads(r["groups"]), bool(r["manual"])) for r in c.execute("SELECT * FROM ingredient_groups")}
    kind_of = {r["name"].lower(): (r["kind"], bool(r["manual"])) for r in c.execute("SELECT * FROM recipe_kinds")}
    return {
        "groups": categorize.GROUPS,
        "kinds": categorize.KINDS,
        "ingredients": sorted(
            (
                {"name": n, "groups": groups_of.get(k, (None, False))[0], "manual": groups_of.get(k, (None, False))[1]}
                for k, n in names.items()
            ),
            key=lambda x: x["name"].lower(),
        ),
        "dishes": sorted(
            (
                {"name": d[0], "kind": kind_of.get(k, (None, False))[0], "manual": kind_of.get(k, (None, False))[1]}
                for k, d in dishes.items()
            ),
            key=lambda x: x["name"].lower(),
        ),
    }
