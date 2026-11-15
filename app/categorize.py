"""Food groups and weights for ingredients, for the statistics page.

Claude Haiku suggests the food groups of each ingredient name it has not seen, and the
weight in grams of one unit of it ("Mais", "boks" -> 160 g). The household can correct
any of them on the statistics page, and a correction is never overwritten.
"""

import json
import os
from typing import Literal

import anthropic
from pydantic import BaseModel

from . import db, web_recipes

MODEL = web_recipes.MODEL  # the same Claude Haiku that reads pasted recipes

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
GroupKey = Literal[
    "rodt_kjott", "fugl", "fisk", "gronnsaker", "korn", "meieri", "egg",
    "belgfrukter", "frukt_baer", "fiberrikt", "ultraprosessert", "basis",
]

# Units that are weights already; every other unit needs grams per unit.
GRAMS_PER = {"g": 1, "gram": 1, "kg": 1000}

BATCH = 100  # names (and name + unit pairs) per request


class CategorizeError(Exception):
    pass


def is_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


class _Ingredient(BaseModel):
    name: str
    groups: list[GroupKey]


class _Weight(BaseModel):
    name: str
    unit: str
    grams: float


class _Result(BaseModel):
    ingredients: list[_Ingredient]
    weights: list[_Weight]


SYSTEM = """You sort ingredients from a Norwegian family's dinner planner into food groups and estimate weights, for simple statistics about what their dinners are made of. Names and units are in Norwegian (bokmål).

ingredients: for each ingredient name, every food group it belongs to:
- rodt_kjott: beef, pork, lamb, game, mince, and products made from them (bacon, sausages, ham, pepperoni).
- fugl: chicken, turkey, duck, and products made from them.
- fisk: fish and seafood, and products made from them (fish fingers, fish cakes, canned tuna).
- gronnsaker: vegetables, including potatoes, onions, garlic, fresh herbs, mushrooms, and tomato products such as canned tomatoes and tomato sauce.
- korn: grains and starch: rice, pasta, bread, flour, tortillas, noodles, couscous, oats.
- meieri: milk, cream, butter, cheese, yoghurt, sour cream.
- egg: eggs.
- belgfrukter: beans, lentils, chickpeas, peas, tofu and other soy products.
- frukt_baer: fruit and berries, including jam, juice and dried fruit.
- fiberrikt: notably high in fibre as usually bought in Norway: wholegrain products, beans and lentils, root vegetables, cabbage, oats.
- ultraprosessert: usually ultra-processed (NOVA group 4) as bought in a Norwegian shop: ready meals, fish fingers, sausages, nuggets, instant noodles, taco spice mixes, packet sauces and soups, ready-made pizza sauce and pasta sauce in jars, soft drinks.
- basis: salt, pepper, spices, dried herbs, oil, vinegar, water, stock cubes, sugar, baking powder and other things used in small amounts that say little about the meal.
An ingredient can be in several groups (fish fingers: fisk, korn, ultraprosessert; pizza sauce: gronnsaker, ultraprosessert). Use an empty list only if nothing fits.

weights: for each name and unit pair, the weight in grams of ONE of that unit of that ingredient, as typically bought or measured in Norway. Use common Norwegian pack sizes for pk, boks, pose and the like (bacon strips 1 pk = 140, diced bacon 1 pk = 125, sweetcorn 1 boks = 160, chopped tomatoes 1 boks = 400). Use the typical weight of one piece for stk or an empty unit (1 onion = 100, 1 egg = 60, 1 garlic clove = 5). For volume units use the ingredient's density (1 dl milk = 100, 1 dl flour = 60, 1 ss butter = 15, 1 ts salt = 6). Give your best estimate; never leave one out.

Return every name and unit exactly as given."""


async def _ask(ingredients, pairs):
    lines = ["Ingredients:", *[f"- {n}" for n in ingredients], "", "Name and unit pairs (name | unit; an empty unit means pieces):"]
    lines += [f"- {n} | {u}" for n, u in pairs]
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
        raise CategorizeError(f"Sorteringen feilet: {getattr(e, 'message', e)}") from e
    if res.stop_reason == "refusal" or res.parsed_output is None:
        raise CategorizeError("Klarte ikke å sortere denne gangen. Prøv igjen senere.")
    return res.parsed_output


def needs_weight(unit):
    return (unit or "").strip().lower() not in GRAMS_PER


def used(c):
    """Ingredient names, and name + unit pairs that need a weight, in the history and the recipes."""
    lines = []
    for r in c.execute("SELECT ingredients FROM dinner_log WHERE recipe_name != ''"):
        lines += [i for i in json.loads(r["ingredients"]) if not i.get("side")]
    lines += [dict(r) for r in c.execute("SELECT name, quantity, unit FROM recipe_ingredients WHERE side=0")]
    names, pairs = {}, {}
    for i in lines:
        names.setdefault(i["name"].lower(), i["name"])
        if i.get("quantity") is not None and needs_weight(i.get("unit")):
            unit = (i.get("unit") or "").strip()
            pairs.setdefault((i["name"].lower(), unit.lower()), (i["name"], unit))
    return names, pairs


def missing(c):
    names, pairs = used(c)
    known_names = {r["name"].lower() for r in c.execute("SELECT name FROM ingredient_groups")}
    known_pairs = {(r["name"].lower(), r["unit"].lower()) for r in c.execute("SELECT name, unit FROM ingredient_weights")}
    return (
        [n for k, n in names.items() if k not in known_names],
        [p for k, p in pairs.items() if k not in known_pairs],
    )


async def categorize_missing():
    """Asks Claude Haiku about every ingredient and weight not sorted yet. Returns how many."""
    if not is_configured():
        raise CategorizeError("Sortering er ikke satt opp. Legg inn ANTHROPIC_API_KEY på serveren.")
    with db.conn() as c:
        names, pairs = missing(c)
    done = 0
    for start in range(0, max(len(names), len(pairs)), BATCH):
        part_names = names[start : start + BATCH]
        part_pairs = pairs[start : start + BATCH]
        out = await _ask(part_names, part_pairs)
        asked_names = {n.lower(): n for n in part_names}
        asked_pairs = {(n.lower(), u.lower()): (n, u) for n, u in part_pairs}
        with db.conn() as c:
            for i in out.ingredients:
                name = asked_names.get(i.name.strip().lower())
                if name:
                    c.execute(
                        "INSERT OR IGNORE INTO ingredient_groups(name, groups, manual) VALUES(?,?,0)",
                        (name, json.dumps(sorted(set(i.groups), key=list(GROUPS).index))),
                    )
                    done += 1
            for w in out.weights:
                pair = asked_pairs.get((w.name.strip().lower(), w.unit.strip().lower()))
                if pair and 0 < w.grams < 100000:
                    c.execute(
                        "INSERT OR IGNORE INTO ingredient_weights(name, unit, grams, manual) VALUES(?,?,?,0)",
                        (pair[0], pair[1], round(w.grams, 1)),
                    )
                    done += 1
    return done


def set_groups(c, name, groups):
    groups = [g for g in GROUPS if g in set(groups)]
    c.execute(
        "INSERT INTO ingredient_groups(name, groups, manual) VALUES(?,?,1) "
        "ON CONFLICT(name) DO UPDATE SET groups=excluded.groups, manual=1",
        (name.strip(), json.dumps(groups)),
    )


def set_weight(c, name, unit, grams):
    c.execute(
        "INSERT INTO ingredient_weights(name, unit, grams, manual) VALUES(?,?,?,1) "
        "ON CONFLICT(name, unit) DO UPDATE SET grams=excluded.grams, manual=1",
        (name.strip(), unit.strip(), grams),
    )


def grams(line, weights):
    """Grams in one ingredient line, or None when the amount or the weight is not known."""
    q = line.get("quantity")
    if q is None:
        return None
    unit = (line.get("unit") or "").strip().lower()
    if unit in GRAMS_PER:
        return q * GRAMS_PER[unit]
    per = weights.get((line["name"].lower(), unit))
    return None if per is None else q * per
