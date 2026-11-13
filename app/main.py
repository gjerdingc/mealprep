import hashlib
import hmac
import json
import os
import sqlite3
from datetime import date, datetime, timedelta

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, gcal, oda, web_recipes

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
COOKIE = "mealprep_session"
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

db.init()
app = FastAPI(title="Mealprep", docs_url=None, redoc_url=None, openapi_url=None)


today = db.today


def norm(s: str) -> str:
    return " ".join((s or "").lower().split())


DEFAULT_LISTS = {
    "units": ["g", "kg", "dl", "l", "ml", "ts", "ss", "stk", "pk", "boks", "fedd", "neve"],
    "categories": [
        "Krydder", "Bakevarer", "Kjøleskap", "Brød og korn", "Hermetikk og glass", "Fryser", "Annet",
    ],
}


def get_list(c, key):
    raw = db.get_setting(c, key)
    return json.loads(raw) if raw else list(DEFAULT_LISTS[key])


def clean_list(values):
    """Trims, drops blanks and removes duplicates (ignoring case), keeping the order."""
    out, seen = [], set()
    for v in values:
        v = " ".join(str(v).split())[:40]
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out


def remember(c, key, values):
    """Adds values the household has started using to the saved list."""
    current = get_list(c, key)
    merged = clean_list([*current, *values])
    if merged != current:
        db.set_setting(c, key, json.dumps(merged))


# --------------------------------------------------------------------------- auth


def _session_token() -> str:
    return hmac.new(APP_PASSWORD.encode(), b"mealprep-session", hashlib.sha256).hexdigest()


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if APP_PASSWORD and path.startswith("/api/") and path != "/api/login":
        if not hmac.compare_digest(request.cookies.get(COOKIE, ""), _session_token()):
            return JSONResponse({"detail": "Du må logge inn"}, status_code=401)
    return await call_next(request)


class LoginIn(BaseModel):
    password: str


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response):
    if not APP_PASSWORD or not hmac.compare_digest(body.password.encode(), APP_PASSWORD.encode()):
        raise HTTPException(401, "Feil passord")
    response.set_cookie(
        COOKIE,
        _session_token(),
        max_age=60 * 60 * 24 * 365,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
    )
    return {"ok": True}


# -------------------------------------------------------------------------- state


def load_recipes(c):
    recipes = [
        dict(r)
        for r in c.execute(
            "SELECT r.*, (SELECT MAX(date) FROM plan p WHERE p.recipe_id = r.id) AS last_planned "
            "FROM recipes r ORDER BY r.name COLLATE NOCASE"
        )
    ]
    by_id = {r["id"]: r for r in recipes}
    for r in recipes:
        r["ingredients"] = []
    for i in c.execute("SELECT * FROM recipe_ingredients ORDER BY recipe_id, position, id"):
        by_id[i["recipe_id"]]["ingredients"].append(
            {"name": i["name"], "quantity": i["quantity"], "unit": i["unit"], "side": bool(i["side"])}
        )
    return recipes


@app.get("/api/state")
def state():
    with db.conn() as c:
        return {
            "today": today().isoformat(),
            "members": [dict(r) for r in c.execute("SELECT * FROM members ORDER BY id")],
            "settings": {
                "dinner_time": db.get_setting(c, "dinner_time", "17:00"),
                "gcal_color": db.get_setting(c, "gcal_color", ""),
                "units": get_list(c, "units"),
                "categories": get_list(c, "categories"),
            },
            "recipes": load_recipes(c),
            "pantry": [
                dict(r)
                for r in c.execute("SELECT * FROM pantry ORDER BY category, name COLLATE NOCASE")
            ],
            "oda_connected": oda.is_connected(),
            "web_recipes": web_recipes.is_configured(),
            "gcal": gcal.status(c),
        }


# ------------------------------------------------------------- members & settings


class NameIn(BaseModel):
    name: str


@app.post("/api/members")
def add_member(body: NameIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Navn mangler")
    with db.conn() as c:
        c.execute("INSERT INTO members(name) VALUES(?)", (name,))
    return {"ok": True}


@app.delete("/api/members/{member_id}")
def delete_member(member_id: int):
    with db.conn() as c:
        days = gcal.upcoming_days(c, "cook_id=?", (member_id,))
        c.execute("DELETE FROM members WHERE id=?", (member_id,))
    gcal.sync_days(days)  # their dinners now have no cook, so the events go
    return {"ok": True}


class CalendarIn(BaseModel):
    calendar_id: str = ""


@app.put("/api/members/{member_id}/calendar")
def set_member_calendar(member_id: int, body: CalendarIn):
    calendar_id = body.calendar_id.strip() or None
    with db.conn() as c:
        cur = c.execute(
            "UPDATE members SET gcal_calendar_id=? WHERE id=?", (calendar_id, member_id)
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Fant ikke kokken")
    warning = None
    if calendar_id and gcal.is_configured():
        try:
            gcal.check_calendar(calendar_id)
        except gcal.NotFound:
            warning = (
                f"Lagret, men appen finner ikke {calendar_id}. Sjekk at kalenderen er delt "
                f"med {gcal.service_email()} med «Gjøre endringer i aktiviteter»."
            )
        except gcal.GcalError as e:
            warning = f"Lagret, men kalenderen kunne ikke sjekkes: {e}"
    error = gcal.sync_upcoming("cook_id=?", (member_id,))
    return {"ok": True, "warning": warning or error}


class GcalSettingsIn(BaseModel):
    enabled: bool


@app.put("/api/gcal")
def set_gcal(body: GcalSettingsIn):
    if body.enabled and not gcal.is_configured():
        raise HTTPException(409, "Google-nøkkelen mangler på serveren")
    with db.conn() as c:
        db.set_setting(c, "gcal_enabled", "1" if body.enabled else "0")
    # Turning it on brings the coming dinners into the calendars straight away.
    return {"ok": True, "error": gcal.sync_upcoming() if body.enabled else None}


@app.post("/api/gcal/sync")
def gcal_sync(day: str | None = None):
    """Retries one day, or with no day, every dinner from today on."""
    with db.conn() as c:
        if not gcal.is_enabled(c):
            raise HTTPException(409, "Synk med Google Kalender er slått av")
    if day:
        error = gcal.sync_days([_parse_date(day).isoformat()])
    else:
        error = gcal.sync_upcoming()
    if error:
        raise HTTPException(502, error)
    return {"ok": True}


class SettingsIn(BaseModel):
    dinner_time: str | None = None
    units: list[str] | None = None
    categories: list[str] | None = None
    # Google Calendar colorId "1"-"11", or "" for the calendar's own colour.
    gcal_color: str | None = None


@app.put("/api/settings")
def save_settings(body: SettingsIn):
    if body.dinner_time is not None:
        try:
            datetime.strptime(body.dinner_time, "%H:%M")
        except ValueError:
            raise HTTPException(400, "Middagstid må skrives som 17:00")
    if body.gcal_color not in (None, "") and body.gcal_color not in gcal.COLORS:
        raise HTTPException(400, "Ukjent farge")
    with db.conn() as c:
        old_time = db.get_setting(c, "dinner_time", "17:00")
        old_color = db.get_setting(c, "gcal_color", "")
        if body.dinner_time is not None:
            db.set_setting(c, "dinner_time", body.dinner_time)
        if body.units is not None:
            db.set_setting(c, "units", json.dumps(clean_list(body.units)))
        if body.categories is not None:
            db.set_setting(c, "categories", json.dumps(clean_list(body.categories)))
        if body.gcal_color is not None:
            db.set_setting(c, "gcal_color", body.gcal_color)
    if (body.dinner_time is not None and body.dinner_time != old_time) or (
        body.gcal_color is not None and body.gcal_color != old_color
    ):
        return {"ok": True, "gcal_error": gcal.sync_upcoming()}  # every coming event follows
    return {"ok": True}


# ------------------------------------------------------------------------ recipes


SIDES_CATEGORY = "Tilbehør"


class IngredientIn(BaseModel):
    name: str
    # A side put on the table (jam, flatbread): no amount, and kept as a pantry staple.
    side: bool = False
    quantity: float | None = None
    unit: str = ""


class RecipeIn(BaseModel):
    name: str
    prep_min: int = 0
    cook_min: int = 0
    servings: int = 4
    instructions: str = ""
    ingredients: list[IngredientIn] = []


def _write_ingredients(c, recipe_id, ingredients):
    c.execute("DELETE FROM recipe_ingredients WHERE recipe_id=?", (recipe_id,))
    rows = [
        (
            recipe_id,
            pos,
            i.name.strip(),
            None if i.side else i.quantity,
            "" if i.side else i.unit.strip(),
            int(i.side),
        )
        for pos, i in enumerate(ingredients)
        if i.name.strip()
    ]
    c.executemany(
        "INSERT INTO recipe_ingredients(recipe_id, position, name, quantity, unit, side) "
        "VALUES(?,?,?,?,?,?)",
        rows,
    )
    remember(c, "units", [r[4] for r in rows])
    # Sides become pantry staples, so they can be marked as empty when more is needed.
    sides = [(r[2], SIDES_CATEGORY) for r in rows if r[5]]
    if sides:
        c.executemany("INSERT OR IGNORE INTO pantry(name, category) VALUES(?, ?)", sides)
        remember(c, "categories", [SIDES_CATEGORY])


def _recipe_values(body: RecipeIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Oppskriften må ha et navn")
    return (
        name,
        max(0, body.prep_min),
        max(0, body.cook_min),
        max(1, body.servings),
        body.instructions.strip(),
    )


@app.post("/api/recipes")
def create_recipe(body: RecipeIn):
    values = _recipe_values(body)
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO recipes(name, prep_min, cook_min, servings, instructions) VALUES(?,?,?,?,?)",
            values,
        )
        _write_ingredients(c, cur.lastrowid, body.ingredients)
        return {"id": cur.lastrowid}


@app.put("/api/recipes/{recipe_id}")
def update_recipe(recipe_id: int, body: RecipeIn):
    values = _recipe_values(body)
    with db.conn() as c:
        cur = c.execute(
            "UPDATE recipes SET name=?, prep_min=?, cook_min=?, servings=?, instructions=? WHERE id=?",
            (*values, recipe_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Fant ikke oppskriften")
        _write_ingredients(c, recipe_id, body.ingredients)
        # Ingredients may have changed, so dinners already shopped for need a fresh look.
        c.execute(
            "UPDATE plan SET shopped=0 WHERE recipe_id=? AND date>=?",
            (recipe_id, today().isoformat()),
        )
    gcal.sync_upcoming("recipe_id=?", (recipe_id,))  # name or times may have changed
    return {"ok": True}


class WebSearchIn(BaseModel):
    query: str


class WebImportIn(BaseModel):
    id: int
    servings: int = 4


@app.post("/api/web-recipes/search")
async def web_recipe_search(body: WebSearchIn):
    try:
        return await web_recipes.search(body.query[:100])
    except web_recipes.WebRecipeError as e:
        raise HTTPException(502, str(e))


@app.post("/api/web-recipes/import")
async def web_recipe_import(body: WebImportIn):
    """Returns the recipe ready for the recipe form. Nothing is saved until the user saves it."""
    with db.conn() as c:
        units = get_list(c, "units")
        known = sorted(
            {r["name"] for r in c.execute("SELECT name FROM pantry")}
            | {r["name"] for r in c.execute("SELECT DISTINCT name FROM recipe_ingredients")},
            key=str.lower,
        )
    try:
        return await web_recipes.import_recipe(body.id, body.servings, units, known)
    except web_recipes.WebRecipeError as e:
        raise HTTPException(502, str(e))


@app.delete("/api/recipes/{recipe_id}")
def delete_recipe(recipe_id: int):
    with db.conn() as c:
        days = gcal.upcoming_days(c, "recipe_id=?", (recipe_id,))
        for day in days:
            if c.execute("SELECT 1 FROM plan WHERE date=? AND note=''", (day,)).fetchone():
                gcal.forget_event(c, day)
        c.execute("DELETE FROM plan WHERE recipe_id=? AND note=''", (recipe_id,))
        c.execute("DELETE FROM recipes WHERE id=?", (recipe_id,))
    gcal.sync_days(days)  # days with a note keep an event titled with the note
    return {"ok": True}


# ------------------------------------------------------------------------- pantry


class PantryIn(BaseModel):
    name: str
    category: str = "Annet"


class PantryBulkIn(BaseModel):
    items: list[PantryIn]


class PantryPatch(BaseModel):
    in_stock: bool | None = None


@app.post("/api/pantry")
def add_pantry(body: PantryIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Navn mangler")
    with db.conn() as c:
        try:
            c.execute(
                "INSERT INTO pantry(name, category) VALUES(?, ?)",
                (name, body.category.strip() or "Annet"),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"{name} finnes allerede i basisvarene")
        remember(c, "categories", [body.category])
    return {"ok": True}


@app.post("/api/pantry/bulk")
def add_pantry_bulk(body: PantryBulkIn):
    with db.conn() as c:
        c.executemany(
            "INSERT OR IGNORE INTO pantry(name, category) VALUES(?, ?)",
            [(i.name.strip(), i.category.strip() or "Annet") for i in body.items if i.name.strip()],
        )
        remember(c, "categories", [i.category for i in body.items])
    return {"ok": True}


@app.patch("/api/pantry/{item_id}")
def patch_pantry(item_id: int, body: PantryPatch):
    with db.conn() as c:
        if body.in_stock is not None:
            c.execute("UPDATE pantry SET in_stock=? WHERE id=?", (int(body.in_stock), item_id))
    return {"ok": True}


@app.delete("/api/pantry/{item_id}")
def delete_pantry(item_id: int):
    with db.conn() as c:
        c.execute("DELETE FROM pantry WHERE id=?", (item_id,))
    return {"ok": True}


# --------------------------------------------------------------------------- plan


class PlanIn(BaseModel):
    recipe_id: int | None = None
    note: str = ""
    cook_id: int | None = None


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, "Dato må skrives som 2026-01-31")


@app.get("/api/plan")
def get_plan(start: str, days: int = 7):
    first = _parse_date(start)
    last = first + timedelta(days=max(1, min(days, 62)) - 1)
    with db.conn() as c:
        return [
            dict(r)
            for r in c.execute(
                "SELECT p.*, r.name AS recipe_name, r.prep_min, r.cook_min "
                "FROM plan p LEFT JOIN recipes r ON r.id = p.recipe_id "
                "WHERE p.date BETWEEN ? AND ? ORDER BY p.date",
                (first.isoformat(), last.isoformat()),
            )
        ]


@app.put("/api/plan/{day}")
def set_plan(day: str, body: PlanIn):
    day = _parse_date(day).isoformat()
    note = body.note.strip()
    with db.conn() as c:
        if body.recipe_id is None and not note:
            if day >= today().isoformat():  # past days' events are left as history
                gcal.forget_event(c, day)
            c.execute("DELETE FROM plan WHERE date=?", (day,))
        else:
            old = c.execute("SELECT recipe_id, shopped FROM plan WHERE date=?", (day,)).fetchone()
            shopped = old["shopped"] if old and old["recipe_id"] == body.recipe_id else 0
            c.execute(
                "INSERT INTO plan(date, recipe_id, note, cook_id, shopped) VALUES(?,?,?,?,?) "
                "ON CONFLICT(date) DO UPDATE SET recipe_id=excluded.recipe_id, note=excluded.note, "
                "cook_id=excluded.cook_id, shopped=excluded.shopped",
                (day, body.recipe_id, note, body.cook_id, shopped),
            )
    # After the commit: a Google error is stored on the day and never undoes the save.
    return {"ok": True, "gcal_error": gcal.sync_days([day])}


# ----------------------------------------------------------------------- shopping


def _range(days: int):
    first = today()
    return first, first + timedelta(days=max(1, min(days, 31)) - 1)


def build_shopping(c, days: int):
    first, last = _range(days)
    dinners = [
        dict(r)
        for r in c.execute(
            "SELECT p.date, p.recipe_id, p.shopped, r.name FROM plan p "
            "JOIN recipes r ON r.id = p.recipe_id WHERE p.date BETWEEN ? AND ? ORDER BY p.date",
            (first.isoformat(), last.isoformat()),
        )
    ]
    pantry = {norm(r["name"]): dict(r) for r in c.execute("SELECT * FROM pantry")}
    checks = {r["key"] for r in c.execute("SELECT key FROM shopping_checks")}
    remembered = {r["key"]: dict(r) for r in c.execute("SELECT * FROM oda_products")}

    items = {}
    for d in dinners:
        if d["shopped"]:
            continue
        for ing in c.execute(
            "SELECT name, quantity, unit, side FROM recipe_ingredients WHERE recipe_id=? "
            "ORDER BY position",
            (d["recipe_id"],),
        ):
            key = f"{norm(ing['name'])}|{norm(ing['unit'])}"
            item = items.setdefault(
                key,
                {
                    "key": key,
                    "name": ing["name"],
                    "unit": ing["unit"],
                    "quantity": None,
                    "recipes": [],
                    "kind": "recipe",
                    "side": bool(ing["side"]),
                },
            )
            if ing["quantity"] is not None:
                item["quantity"] = round((item["quantity"] or 0) + ing["quantity"], 3)
            if d["name"] not in item["recipes"]:
                item["recipes"].append(d["name"])

    buy, have = [], []
    seen_names = set()
    for item in items.values():
        name_key = norm(item["name"])
        seen_names.add(name_key)
        staple = pantry.get(name_key)
        if staple:
            item["pantry_id"] = staple["id"]
        if staple and staple["in_stock"]:
            have.append(item)
        else:
            item["staple_out"] = bool(staple)
            buy.append(item)
    for name_key, staple in pantry.items():
        if not staple["in_stock"] and name_key not in seen_names:
            buy.append(
                {
                    "key": f"{name_key}|",
                    "name": staple["name"],
                    "unit": "",
                    "quantity": None,
                    "recipes": [],
                    "kind": "staple",
                    "staple_out": True,
                    "pantry_id": staple["id"],
                }
            )
    for row in c.execute("SELECT * FROM shopping_extra ORDER BY id"):
        buy.append(
            {
                "key": f"extra:{row['id']}",
                "name": row["name"],
                "unit": "",
                "quantity": None,
                "recipes": [],
                "kind": "extra",
                "extra_id": row["id"],
                "checked": bool(row["checked"]),
            }
        )
    for item in buy:
        item.setdefault("checked", item["key"] in checks)
        item["oda"] = remembered.get(norm(item["name"]))
    buy.sort(key=lambda i: (i["kind"] == "extra", norm(i["name"])))
    have.sort(key=lambda i: norm(i["name"]))
    return {
        "start": first.isoformat(),
        "end": last.isoformat(),
        "dinners": dinners,
        "buy": buy,
        "have": have,
    }


@app.get("/api/shopping")
def get_shopping(days: int = 7):
    with db.conn() as c:
        return build_shopping(c, days)


class CheckIn(BaseModel):
    key: str
    checked: bool


@app.post("/api/shopping/check")
def check_item(body: CheckIn):
    with db.conn() as c:
        if body.key.startswith("extra:"):
            c.execute(
                "UPDATE shopping_extra SET checked=? WHERE id=?",
                (int(body.checked), body.key.split(":", 1)[1]),
            )
        elif body.checked:
            c.execute("INSERT OR IGNORE INTO shopping_checks(key) VALUES(?)", (body.key,))
        else:
            c.execute("DELETE FROM shopping_checks WHERE key=?", (body.key,))
    return {"ok": True}


@app.post("/api/shopping/extra")
def add_extra(body: NameIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Skriv hva som skal legges til")
    with db.conn() as c:
        c.execute("INSERT INTO shopping_extra(name) VALUES(?)", (name,))
    return {"ok": True}


@app.delete("/api/shopping/extra/{extra_id}")
def delete_extra(extra_id: int):
    with db.conn() as c:
        c.execute("DELETE FROM shopping_extra WHERE id=?", (extra_id,))
    return {"ok": True}


@app.post("/api/shopping/finish")
def finish_shopping(days: int = 7):
    """Everything on the list is bought: restock staples and start a clean list."""
    first, last = _range(days)
    with db.conn() as c:
        c.execute(
            "UPDATE plan SET shopped=1 WHERE date BETWEEN ? AND ?",
            (first.isoformat(), last.isoformat()),
        )
        c.execute("UPDATE pantry SET in_stock=1")
        c.execute("DELETE FROM shopping_extra")
        c.execute("DELETE FROM shopping_checks")
    return {"ok": True}


# ---------------------------------------------------------------------------- Oda


def _oda_error(e: Exception):
    if isinstance(e, oda.NotConnected):
        return HTTPException(409, str(e))
    return HTTPException(502, str(e))


@app.get("/api/oda/connect")
async def oda_connect(request: Request):
    redirect_uri = str(request.base_url).rstrip("/") + "/api/oda/callback"
    try:
        url = await oda.start_connect(redirect_uri)
    except Exception as e:
        return RedirectResponse(f"/?oda=error#shopping", status_code=303, headers={"X-Oda-Error": str(e)[:200]})
    return RedirectResponse(url, status_code=303)


@app.get("/api/oda/callback")
async def oda_callback(code: str | None = None, state: str | None = None, error: str | None = None):
    if error or not code:
        return RedirectResponse("/?oda=denied#shopping", status_code=303)
    try:
        await oda.finish_connect(code, state)
    except Exception:
        return RedirectResponse("/?oda=error#shopping", status_code=303)
    return RedirectResponse("/?oda=connected#shopping", status_code=303)


@app.post("/api/oda/disconnect")
async def oda_disconnect():
    await oda.disconnect()
    return {"ok": True}


class SearchIn(BaseModel):
    queries: list[str]


@app.post("/api/oda/search")
async def oda_search(body: SearchIn):
    try:
        return await oda.search([q.strip() for q in body.queries][:60])
    except oda.OdaError as e:
        raise _oda_error(e)


class CartItem(BaseModel):
    name: str
    product_id: int
    product_name: str
    price: str | None = None
    url: str | None = None
    image: str | None = None
    quantity: int = 1


class CartIn(BaseModel):
    items: list[CartItem]


@app.post("/api/oda/cart")
async def oda_cart(body: CartIn):
    items = [i for i in body.items if i.quantity > 0]
    if not items:
        raise HTTPException(400, "Ingenting valgt")
    try:
        cart = await oda.add_to_cart(
            [{"productId": i.product_id, "quantity": i.quantity} for i in items]
        )
    except oda.OdaError as e:
        raise _oda_error(e)
    with db.conn() as c:
        for i in items:  # remember the choice for next time
            c.execute(
                "INSERT INTO oda_products(key, product_id, name, price, url, image) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET product_id=excluded.product_id, "
                "name=excluded.name, price=excluded.price, url=excluded.url, image=excluded.image",
                (norm(i.name), i.product_id, i.product_name, i.price, i.url, i.image),
            )
    return cart


# ------------------------------------------------------------------------- static


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"), headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=STATIC), name="static")
