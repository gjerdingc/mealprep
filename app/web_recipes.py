"""Recipes from the web: Spoonacular finds them, Claude Haiku turns them into Norwegian.

Spoonacular's recipes are in English with US measures. The amounts are scaled here
(plain arithmetic, so it is exact), then Claude translates names and steps, converts
to the household's units and reuses ingredient names the household already has, so
the shopping list and the Oda search work as for a hand-written recipe.
"""

import html
import os
import re

import anthropic
import httpx
from pydantic import BaseModel

SPOONACULAR_URL = "https://api.spoonacular.com"
MODEL = "claude-haiku-5-5"
TIMEOUT = httpx.Timeout(20.0)


class WebRecipeError(Exception):
    pass


def _spoonacular_key():
    return os.environ.get("SPOONACULAR_API_KEY", "").strip()


def is_configured():
    return bool(_spoonacular_key() and os.environ.get("ANTHROPIC_API_KEY", "").strip())


def _check_configured():
    if not is_configured():
        raise WebRecipeError(
            "Nettsøk er ikke satt opp. Legg inn SPOONACULAR_API_KEY og ANTHROPIC_API_KEY på serveren."
        )


_claude = None


def _client():
    global _claude
    if _claude is None:
        _claude = anthropic.AsyncAnthropic()
    return _claude


# ------------------------------------------------------------------- Spoonacular


async def _spoonacular(path, params):
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as http:
            res = await http.get(
                SPOONACULAR_URL + path, params=params, headers={"x-api-key": _spoonacular_key()}
            )
    except httpx.HTTPError as e:
        raise WebRecipeError(f"Fikk ikke kontakt med oppskriftsdatabasen: {e}") from e
    if res.status_code in (401, 403):
        raise WebRecipeError("Oppskriftsdatabasen godtok ikke API-nøkkelen (SPOONACULAR_API_KEY).")
    if res.status_code == 402:
        raise WebRecipeError("Dagens gratiskvote hos oppskriftsdatabasen er brukt opp. Prøv igjen i morgen.")
    if res.status_code >= 400:
        raise WebRecipeError(f"Oppskriftsdatabasen svarte {res.status_code}.")
    return res.json()


# --------------------------------------------------------------------- Claude


class _Query(BaseModel):
    english: str


class Ingredient(BaseModel):
    name: str
    quantity: float | None
    unit: str
    side: bool


class _Recipe(BaseModel):
    name: str
    prep_min: int
    cook_min: int
    instructions: str
    ingredients: list[Ingredient]


async def _ask(system, prompt, output, effort):
    try:
        res = await _client().messages.parse(
            model=MODEL,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": effort},
            output_format=output,
        )
    except anthropic.APIError as e:
        raise WebRecipeError(f"Oversettelsen feilet: {getattr(e, 'message', e)}") from e
    if res.stop_reason == "refusal" or res.parsed_output is None:
        raise WebRecipeError("Klarte ikke å oversette oppskriften. Prøv en annen.")
    return res.parsed_output


async def _to_english(query):
    out = await _ask(
        "You turn a dish search typed by a Norwegian user into a short English search term "
        "for an English recipe database. Keep dish names that are already international "
        "as they are (adobo, lasagna, pad thai, tikka masala). For Norwegian dishes with no "
        "English name, describe the dish in two or three words the way an English recipe "
        "title would (lapskaus: beef potato stew; fiskesuppe: fish soup; kjøttkaker: "
        "meatballs gravy). Reply with the search term only.",
        query,
        _Query,
        "low",
    )
    return out.english.strip() or query


# ---------------------------------------------------------------------- public


async def search(query):
    """Finds recipes for a dish name in Norwegian or English.
    Returns {query: the English search term, results: [{id, title, image, minutes, servings}]}."""
    _check_configured()
    query = query.strip()
    if not query:
        return []
    english = await _to_english(query)
    base = {"number": 12, "addRecipeInformation": "true"}
    # The free-text search reads some words as ingredients ("adobo" becomes the adobo
    # seasoning) and then finds nothing, so fall back to searching the titles.
    attempts = [
        {"query": english, "instructionsRequired": "true"},
        {"titleMatch": english, "instructionsRequired": "true"},
        {"titleMatch": english},
    ]
    results = []
    for params in attempts:
        data = await _spoonacular("/recipes/complexSearch", {**base, **params})
        results = data.get("results") or []
        if results:
            break
    return {
        "query": english,
        "results": [
            {
                "id": r.get("id"),
                "title": r.get("title") or "",
                "image": r.get("image"),
                "minutes": r.get("readyInMinutes"),
                "servings": r.get("servings"),
            }
            for r in results
        ],
    }


def _number(x):
    return round(x, 2) if isinstance(x, (int, float)) else x


def _steps(info):
    steps = [s.get("step", "").strip() for block in info.get("analyzedInstructions") or [] for s in block.get("steps") or []]
    if any(steps):
        return "\n".join(f"{i}. {s}" for i, s in enumerate((s for s in steps if s), 1))
    text = re.sub(r"<[^>]+>", " ", info.get("instructions") or "")
    return " ".join(html.unescape(text).split())


def _minutes(value):
    return f"{value} min" if isinstance(value, int) and value > 0 else "unknown"


async def import_recipe(recipe_id, servings, units, known_names):
    """Fetches a recipe and returns it as a filled-in recipe form (not saved)."""
    _check_configured()
    servings = max(1, min(int(servings or 4), 50))
    info = await _spoonacular(f"/recipes/{int(recipe_id)}/information", {"includeNutrition": "false"})
    original = info.get("servings") or servings
    factor = servings / original

    lines = []
    for ing in info.get("extendedIngredients") or []:
        metric = (ing.get("measures") or {}).get("metric") or {}
        amount = metric.get("amount", ing.get("amount"))
        unit = metric.get("unitShort") or ing.get("unit") or ""
        scaled = _number(amount * factor) if isinstance(amount, (int, float)) and amount else None
        lines.append(f"- {scaled if scaled is not None else ''} {unit} | {ing.get('nameClean') or ing.get('name')} | original: {ing.get('original', '')}")

    prompt = f"""Recipe: {info.get('title', '')}
Servings: {servings} (the amounts below are already scaled to this; do not scale again)
Total time: {_minutes(info.get('readyInMinutes'))}; preparation: {_minutes(info.get('preparationMinutes'))}; cooking: {_minutes(info.get('cookingMinutes'))}

Ingredients (scaled amount and unit | ingredient | original line, which is for the original {original} servings):
{chr(10).join(lines)}

Steps:
{_steps(info)}

The household's units: {', '.join(units)}
Ingredient names the household already uses: {', '.join(known_names[:400]) or '(none yet)'}"""

    system = """You turn an English recipe into a Norwegian (bokmål) recipe for a family dinner planner.

- name: a natural Norwegian name for the dish. Keep the dish's own name where Norwegians use it too (Kylling adobo, Pad thai).
- ingredients: one entry per ingredient, in the recipe's order.
  - name: Norwegian, short and plain, the way it is written on a shopping list (Hvitløk, Soyasaus, Kyllinglår). If the household already uses a name for the same thing, use exactly that name.
  - quantity and unit: use the household's units where they fit. Convert ml to dl (1 dl = 100 ml) for amounts of 50 ml or more, Tbsp to ss and tsp to ts, cloves to fedd, pieces to stk, grams over 1000 to kg. Round to amounts a cook would measure: whole stk and fedd, g to the nearest 5 or 10, dl and ss to the nearest half. Use quantity null and unit "" for things measured to taste (salt, pepper) or with no amount.
  - side: true only for something served on the table that people help themselves to and has no amount in the cooking (steamed rice served on the side, bread, pickles). Ingredients cooked into the dish are false.
- prep_min and cook_min: whole minutes. Use the times given when they exist; otherwise split the total time sensibly. Use 0 when nothing is known.
- instructions: the steps translated into clear Norwegian, numbered "1. ", "2. " on separate lines. Use the household's units in the text and Celsius for oven temperatures. Do not add steps that are not in the recipe."""

    out = await _ask(system, prompt, _Recipe, "medium")
    instructions = out.instructions.strip()
    if info.get("sourceUrl"):
        instructions += f"\n\nKilde: {info['sourceUrl']}"
    return {
        "name": out.name.strip(),
        "prep_min": max(0, out.prep_min),
        "cook_min": max(0, out.cook_min),
        "servings": servings,
        "instructions": instructions,
        "ingredients": [
            {
                "name": i.name.strip(),
                "quantity": None if i.side or i.quantity is None else round(i.quantity, 2),
                "unit": "" if i.side else i.unit.strip(),
                "side": i.side,
            }
            for i in out.ingredients
            if i.name.strip()
        ],
        "image": info.get("image"),
    }
