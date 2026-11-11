import hashlib
import hmac
import os
import sqlite3
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, oda

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
COOKIE = "mealprep_session"
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

db.init()
app = FastAPI(title="Mealprep", docs_url=None, redoc_url=None, openapi_url=None)


def today() -> date:
    try:
        return datetime.now(ZoneInfo(os.environ.get("TZ", "Europe/Oslo"))).date()
    except Exception:
        return date.today()


def norm(s: str) -> str:
    return " ".join((s or "").lower().split())


# --------------------------------------------------------------------------- auth


def _session_token() -> str:
    return hmac.new(APP_PASSWORD.encode(), b"mealprep-session", hashlib.sha256).hexdigest()


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if APP_PASSWORD and path.startswith("/api/") and path != "/api/login":
        if not hmac.compare_digest(request.cookies.get(COOKIE, ""), _session_token()):
            return JSONResponse({"detail": "Login required"}, status_code=401)
    return await call_next(request)


class LoginIn(BaseModel):
    password: str


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response):
    if not APP_PASSWORD or not hmac.compare_digest(body.password.encode(), APP_PASSWORD.encode()):
        raise HTTPException(401, "Wrong password")
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
            {"name": i["name"], "quantity": i["quantity"], "unit": i["unit"]}
        )
    return recipes


@app.get("/api/state")
def state():
    with db.conn() as c:
        return {
            "today": today().isoformat(),
            "members": [dict(r) for r in c.execute("SELECT * FROM members ORDER BY id")],
            "settings": {"dinner_time": db.get_setting(c, "dinner_time", "17:00")},
            "recipes": load_recipes(c),
            "pantry": [
                dict(r)
                for r in c.execute("SELECT * FROM pantry ORDER BY category, name COLLATE NOCASE")
            ],
            "oda_connected": oda.is_connected(),
        }


# ------------------------------------------------------------- members & settings


class NameIn(BaseModel):
    name: str


@app.post("/api/members")
def add_member(body: NameIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required")
    with db.conn() as c:
        c.execute("INSERT INTO members(name) VALUES(?)", (name,))
    return {"ok": True}


@app.delete("/api/members/{member_id}")
def delete_member(member_id: int):
    with db.conn() as c:
        c.execute("DELETE FROM members WHERE id=?", (member_id,))
    return {"ok": True}


class SettingsIn(BaseModel):
    dinner_time: str


@app.put("/api/settings")
def save_settings(body: SettingsIn):
    try:
        datetime.strptime(body.dinner_time, "%H:%M")
    except ValueError:
        raise HTTPException(400, "Dinner time must look like 17:00")
    with db.conn() as c:
        db.set_setting(c, "dinner_time", body.dinner_time)
    return {"ok": True}


# ------------------------------------------------------------------------ recipes


class IngredientIn(BaseModel):
    name: str
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
        (recipe_id, pos, i.name.strip(), i.quantity, i.unit.strip())
        for pos, i in enumerate(ingredients)
        if i.name.strip()
    ]
    c.executemany(
        "INSERT INTO recipe_ingredients(recipe_id, position, name, quantity, unit) VALUES(?,?,?,?,?)",
        rows,
    )


def _recipe_values(body: RecipeIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "The recipe needs a name")
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
            raise HTTPException(404, "Recipe not found")
        _write_ingredients(c, recipe_id, body.ingredients)
        # Ingredients may have changed, so dinners already shopped for need a fresh look.
        c.execute(
            "UPDATE plan SET shopped=0 WHERE recipe_id=? AND date>=?",
            (recipe_id, today().isoformat()),
        )
    return {"ok": True}


@app.delete("/api/recipes/{recipe_id}")
def delete_recipe(recipe_id: int):
    with db.conn() as c:
        c.execute("DELETE FROM plan WHERE recipe_id=? AND note=''", (recipe_id,))
        c.execute("DELETE FROM recipes WHERE id=?", (recipe_id,))
    return {"ok": True}


# ------------------------------------------------------------------------- pantry


class PantryIn(BaseModel):
    name: str
    category: str = "Other"


class PantryBulkIn(BaseModel):
    items: list[PantryIn]


class PantryPatch(BaseModel):
    in_stock: bool | None = None


@app.post("/api/pantry")
def add_pantry(body: PantryIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required")
    with db.conn() as c:
        try:
            c.execute(
                "INSERT INTO pantry(name, category) VALUES(?, ?)",
                (name, body.category.strip() or "Other"),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"{name} is already in the pantry")
    return {"ok": True}


@app.post("/api/pantry/bulk")
def add_pantry_bulk(body: PantryBulkIn):
    with db.conn() as c:
        c.executemany(
            "INSERT OR IGNORE INTO pantry(name, category) VALUES(?, ?)",
            [(i.name.strip(), i.category.strip() or "Other") for i in body.items if i.name.strip()],
        )
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
        raise HTTPException(400, "Dates must look like 2026-01-31")


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
            c.execute("DELETE FROM plan WHERE date=?", (day,))
            return {"ok": True}
        old = c.execute("SELECT recipe_id, shopped FROM plan WHERE date=?", (day,)).fetchone()
        shopped = old["shopped"] if old and old["recipe_id"] == body.recipe_id else 0
        c.execute(
            "INSERT INTO plan(date, recipe_id, note, cook_id, shopped) VALUES(?,?,?,?,?) "
            "ON CONFLICT(date) DO UPDATE SET recipe_id=excluded.recipe_id, note=excluded.note, "
            "cook_id=excluded.cook_id, shopped=excluded.shopped",
            (day, body.recipe_id, note, body.cook_id, shopped),
        )
    return {"ok": True}


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
            "SELECT name, quantity, unit FROM recipe_ingredients WHERE recipe_id=? ORDER BY position",
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
        raise HTTPException(400, "Write what to add")
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
    quantity: int = 1


class CartIn(BaseModel):
    items: list[CartItem]


@app.post("/api/oda/cart")
async def oda_cart(body: CartIn):
    items = [i for i in body.items if i.quantity > 0]
    if not items:
        raise HTTPException(400, "Nothing selected")
    try:
        cart = await oda.add_to_cart(
            [{"productId": i.product_id, "quantity": i.quantity} for i in items]
        )
    except oda.OdaError as e:
        raise _oda_error(e)
    with db.conn() as c:
        for i in items:  # remember the choice for next time
            c.execute(
                "INSERT INTO oda_products(key, product_id, name, price, url) VALUES(?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET product_id=excluded.product_id, "
                "name=excluded.name, price=excluded.price, url=excluded.url",
                (norm(i.name), i.product_id, i.product_name, i.price, i.url),
            )
    return cart


# ------------------------------------------------------------------------- static


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"), headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=STATIC), name="static")
