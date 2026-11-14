"""Food groups for ingredients and the main kind of each dish, for the statistics page.

Claude Haiku suggests them for names it has not seen; the household can correct any of
them on the statistics page, and a correction is never overwritten.
"""

import json
import os
from typing import Literal

import anthropic
from pydantic import BaseModel

from . import db, web_recipes

MODEL = web_recipes.MODEL  # the same Claude Haiku the web recipes use

# Food groups an ingredient can belong to (several at once), in display order.
GROUPS = {
    "rodt_kjott": "Rødt kjøtt",
    "fugl": "Kylling og fugl",
    "fisk": "Fisk og sjømat",
    "gronnsaker": "Grønnsaker",
    "korn": "Korn og stivelse",
    "meieri": "Meieri",
    "egg": "Egg",
    "belgfrukter": "Belgfrukter",
    "frukt_baer": "Frukt og bær",
    "fiberrikt": "Fiberrikt",
    "ultraprosessert": "Ultraprosessert",
    "basis": "Krydder og basis",  # salt, oil, water, spices: left out of the statistics
}
# The main kind of a dish, one per dish.
KINDS = {
    "kjott": "Rødt kjøtt",
    "fisk": "Fisk",
    "fugl": "Kylling",
    "vegetar": "Vegetar",
    "annet": "Annet",
}

GroupKey = Literal[
    "rodt_kjott", "fugl", "fisk", "gronnsaker", "korn", "meieri", "egg",
    "belgfrukter", "frukt_baer", "fiberrikt", "ultraprosessert", "basis",
]
KindKey = Literal["kjott", "fisk", "fugl", "vegetar", "annet"]

BATCH = 120  # names per request


class CategorizeError(Exception):
    pass


def is_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


class _Ingredient(BaseModel):
    name: str
    groups: list[GroupKey]


class _Dish(BaseModel):
    name: str
    kind: KindKey


class _Result(BaseModel):
    ingredients: list[_Ingredient]
    dishes: list[_Dish]


SYSTEM = """You sort ingredients and dinners from a Norwegian family's dinner planner into groups for simple statistics about how varied and healthy their dinners are. Names are in Norwegian (bokmål).

For each ingredient, give every food group it belongs to:
- rodt_kjott: beef, pork, lamb, game, mince, and products made from them (bacon, sausages, ham).
- fugl: chicken, turkey, duck, and products made from them.
- fisk: fish and seafood, and products made from them (fish fingers, fish cakes, canned tuna).
- gronnsaker: vegetables, including potatoes, onions, garlic, herbs used as greens, and mushrooms.
- korn: grains and starch: rice, pasta, bread, flour, tortillas, noodles, couscous, oats.
- meieri: milk, cream, butter, cheese, yoghurt, sour cream.
- egg: eggs.
- belgfrukter: beans, lentils, chickpeas, peas, tofu and other soy products.
- frukt_baer: fruit and berries, including jam, juice and dried fruit.
- fiberrikt: notably high in fibre: wholegrain products, beans and lentils, root vegetables, cabbage, oats.
- ultraprosessert: ultra-processed (NOVA group 4): ready meals, fish fingers, sausages, nuggets, instant noodles, taco spice mixes, packet sauces and soups, soft drinks, most sweet spreads.
- basis: salt, pepper, spices, dried herbs, oil, vinegar, water, stock cubes, sugar, baking powder and other things used in small amounts that say little about the meal.

An ingredient can be in several groups (fish fingers: fisk, korn, ultraprosessert; whole-wheat pasta: korn, fiberrikt). Use an empty list only if nothing fits.

For each dinner, give its main kind from the name and its ingredients:
- kjott: the main protein is red meat (beef, pork, lamb, game) or products of it.
- fisk: the main protein is fish or seafood.
- fugl: the main protein is chicken or other poultry.
- vegetar: no meat, poultry or fish.
- annet: none of these fits (for example a dinner of only bread and spreads with ham and cheese mixed).

Return every name exactly as given."""


async def _ask(ingredients, dishes):
    lines = ["Ingredients:", *[f"- {n}" for n in ingredients], "", "Dinners (name: ingredients):"]
    lines += [f"- {name}: {', '.join(ings) or '(no ingredients listed)'}" for name, ings in dishes]
    try:
        res = await web_recipes._client().messages.parse(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content": "\n".join(lines)}],
            output_config={"effort": "low"},
            output_format=_Result,
        )
    except anthropic.APIError as e:
        raise CategorizeError(f"Kategoriseringen feilet: {getattr(e, 'message', e)}") from e
    if res.stop_reason == "refusal" or res.parsed_output is None:
        raise CategorizeError("Klarte ikke å kategorisere denne gangen. Prøv igjen senere.")
    return res.parsed_output


def _used(c):
    """Ingredient names and dishes (with their ingredients) in the history and the recipes."""
    names = {}
    dishes = {}
    for r in c.execute("SELECT recipe_name, ingredients FROM dinner_log WHERE recipe_name != ''"):
        ings = [i["name"] for i in json.loads(r["ingredients"]) if not i.get("side")]
        dishes.setdefault(r["recipe_name"].lower(), (r["recipe_name"], ings))
        for n in ings:
            names.setdefault(n.lower(), n)
    for r in c.execute("SELECT id, name FROM recipes"):
        ings = [
            i["name"]
            for i in c.execute("SELECT name FROM recipe_ingredients WHERE recipe_id=? AND side=0 ORDER BY position", (r["id"],))
        ]
        dishes[r["name"].lower()] = (r["name"], ings)  # the recipe as it is now wins
        for n in ings:
            names.setdefault(n.lower(), n)
    return names, dishes


def missing(c):
    names, dishes = _used(c)
    known_ings = {r["name"].lower() for r in c.execute("SELECT name FROM ingredient_groups")}
    known_dishes = {r["name"].lower() for r in c.execute("SELECT name FROM recipe_kinds")}
    return (
        [n for k, n in names.items() if k not in known_ings],
        [d for k, d in dishes.items() if k not in known_dishes],
    )


async def categorize_missing():
    """Asks Claude Haiku about every ingredient and dish not sorted yet. Returns how many."""
    if not is_configured():
        raise CategorizeError("Kategorisering er ikke satt opp. Legg inn ANTHROPIC_API_KEY på serveren.")
    with db.conn() as c:
        ings, dishes = missing(c)
    done = 0
    for start in range(0, max(len(ings), len(dishes)), BATCH):
        part_ings = ings[start : start + BATCH]
        part_dishes = dishes[start : start + BATCH]
        out = await _ask(part_ings, part_dishes)
        asked_ings = {n.lower(): n for n in part_ings}
        asked_dishes = {d[0].lower(): d[0] for d in part_dishes}
        with db.conn() as c:
            for i in out.ingredients:
                name = asked_ings.get(i.name.strip().lower())
                if name:
                    c.execute(
                        "INSERT OR IGNORE INTO ingredient_groups(name, groups, manual) VALUES(?,?,0)",
                        (name, json.dumps(sorted(set(i.groups), key=list(GROUPS).index))),
                    )
                    done += 1
            for d in out.dishes:
                name = asked_dishes.get(d.name.strip().lower())
                if name:
                    c.execute("INSERT OR IGNORE INTO recipe_kinds(name, kind, manual) VALUES(?,?,0)", (name, d.kind))
                    done += 1
    return done


def set_groups(c, name, groups):
    groups = [g for g in GROUPS if g in set(groups)]
    c.execute(
        "INSERT INTO ingredient_groups(name, groups, manual) VALUES(?,?,1) "
        "ON CONFLICT(name) DO UPDATE SET groups=excluded.groups, manual=1",
        (name.strip(), json.dumps(groups)),
    )


def set_kind(c, name, kind):
    if kind not in KINDS:
        raise ValueError(kind)
    c.execute(
        "INSERT INTO recipe_kinds(name, kind, manual) VALUES(?,?,1) "
        "ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, manual=1",
        (name.strip(), kind),
    )


def renamed(c, old, new):
    """A recipe got a new name: it keeps its kind (history under the old name keeps it too)."""
    if old.lower() == new.lower():
        return
    row = c.execute("SELECT kind, manual FROM recipe_kinds WHERE name=?", (old,)).fetchone()
    if row:
        c.execute(
            "INSERT OR IGNORE INTO recipe_kinds(name, kind, manual) VALUES(?,?,?)",
            (new, row["kind"], row["manual"]),
        )
