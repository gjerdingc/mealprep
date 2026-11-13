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
        _add_columns(c, "members", [("gcal_calendar_id", "TEXT")])
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
