import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from zoneinfo import ZoneInfo

DATA_DIR = os.environ.get(
    "DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
)
DB_PATH = os.path.join(DATA_DIR, "mealprep.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS members(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipes(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    prep_min INTEGER NOT NULL DEFAULT 0,
    cook_min INTEGER NOT NULL DEFAULT 0,
    servings INTEGER NOT NULL DEFAULT 4,
    instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS recipe_ingredients(
    id INTEGER PRIMARY KEY,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    quantity REAL,
    unit TEXT NOT NULL DEFAULT '',
    side INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pantry(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category TEXT NOT NULL DEFAULT 'Annet',
    in_stock INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS plan(
    date TEXT PRIMARY KEY,
    recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    cook_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    shopped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shopping_extra(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shopping_checks(
    key TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS oda_products(
    key TEXT PRIMARY KEY,
    product_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price TEXT,
    url TEXT
);
-- A fixed record of each dinner once its day has passed, for statistics. Names are copied
-- in, so deleting or editing a recipe or a cook later does not change history.
CREATE TABLE IF NOT EXISTS dinner_log(
    date TEXT PRIMARY KEY,
    recipe_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    cook_name TEXT NOT NULL DEFAULT '',
    ingredients TEXT NOT NULL DEFAULT '[]'
);
-- Food groups per ingredient name and the main kind of each dish, for statistics.
-- Suggested by Claude Haiku (manual=0) or set by hand (manual=1, never overwritten).
CREATE TABLE IF NOT EXISTS ingredient_groups(
    name TEXT PRIMARY KEY COLLATE NOCASE,
    groups TEXT NOT NULL DEFAULT '[]',
    manual INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recipe_kinds(
    name TEXT PRIMARY KEY COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT '',
    manual INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS gcal_deletes(
    id INTEGER PRIMARY KEY,
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL
);
"""


def today() -> date:
    try:
        return datetime.now(ZoneInfo(os.environ.get("TZ", "Europe/Oslo"))).date()
    except Exception:
        return date.today()


def capitalize_first(name: str) -> str:
    """Upper-cases only the first letter, so "hvitløk" becomes "Hvitløk" and "MSG" stays "MSG"."""
    return name[:1].upper() + name[1:]


def _add_columns(c, table, columns):
    existing = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
    for name, decl in columns:
        if name not in existing:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    try:
        yield c
        c.commit()
    except BaseException:
        c.rollback()
        raise
    finally:
        c.close()


def init():
    os.makedirs(DATA_DIR, exist_ok=True)
    with conn() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        columns = {r["name"] for r in c.execute("PRAGMA table_info(oda_products)")}
        if "image" not in columns:
            c.execute("ALTER TABLE oda_products ADD COLUMN image TEXT")
        columns = {r["name"] for r in c.execute("PRAGMA table_info(recipe_ingredients)")}
        if "side" not in columns:
            c.execute("ALTER TABLE recipe_ingredients ADD COLUMN side INTEGER NOT NULL DEFAULT 0")
        if get_setting(c, "ingredients_capitalized") != "1":
            # One time: ingredients saved before names were capitalized on save.
            rows = c.execute("SELECT id, name FROM recipe_ingredients").fetchall()
            c.executemany(
                "UPDATE recipe_ingredients SET name=? WHERE id=?",
                [(capitalize_first(r["name"]), r["id"]) for r in rows if capitalize_first(r["name"]) != r["name"]],
            )
            set_setting(c, "ingredients_capitalized", "1")
        # A note on an ingredient ("til steking"), and an optional small heading it sits under
        # ("Råkost"). Ingredients with the same section next to each other form one group.
        _add_columns(
            c,
            "recipe_ingredients",
            [("note", "TEXT NOT NULL DEFAULT ''"), ("section", "TEXT NOT NULL DEFAULT ''")],
        )
        _add_columns(c, "members", [("gcal_calendar_id", "TEXT"), ("gcal_color", "TEXT")])
        log_past_dinners(c)  # history from before the log existed, as the recipes are now
        _add_columns(
            c, "plan", [("gcal_event_id", "TEXT"), ("gcal_calendar_id", "TEXT"), ("gcal_error", "TEXT")]
        )


def get_setting(c, key, default=None):
    row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(c, key, value):
    c.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


# ------------------------------------------------------------------------- history


def log_day(c, day):
    """Writes (or removes) the history record for one day from the plan as it is now."""
    row = c.execute(
        "SELECT p.recipe_id, p.note, r.name AS recipe_name, m.name AS cook_name FROM plan p "
        "LEFT JOIN recipes r ON r.id = p.recipe_id LEFT JOIN members m ON m.id = p.cook_id "
        "WHERE p.date=?",
        (day,),
    ).fetchone()
    if not row or not (row["recipe_name"] or row["note"]):
        c.execute("DELETE FROM dinner_log WHERE date=?", (day,))
        return
    ingredients = [
        {"name": i["name"], "quantity": i["quantity"], "unit": i["unit"], "side": bool(i["side"])}
        for i in c.execute(
            "SELECT name, quantity, unit, side FROM recipe_ingredients WHERE recipe_id=? "
            "ORDER BY position, id",
            (row["recipe_id"],),
        )
    ] if row["recipe_id"] else []
    c.execute(
        "INSERT INTO dinner_log(date, recipe_name, note, cook_name, ingredients) VALUES(?,?,?,?,?) "
        "ON CONFLICT(date) DO UPDATE SET recipe_name=excluded.recipe_name, note=excluded.note, "
        "cook_name=excluded.cook_name, ingredients=excluded.ingredients",
        (day, row["recipe_name"] or "", row["note"] or "", row["cook_name"] or "", json.dumps(ingredients, ensure_ascii=False)),
    )


def log_past_dinners(c):
    """Records every past day that has no history record yet. Cheap when nothing is new."""
    for r in c.execute(
        "SELECT date FROM plan WHERE date < ? AND date NOT IN (SELECT date FROM dinner_log)",
        (today().isoformat(),),
    ).fetchall():
        log_day(c, r["date"])
