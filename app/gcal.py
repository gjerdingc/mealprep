"""Puts planned dinners in the cooks' own Google Calendars.

The app signs in as a Google service account. Each cook shares their calendar with the
service account's email address ("Make changes to events"), and the calendar ID is saved
on the cook in Innstillinger. A dinner gets one event, on the calendar of whoever cooks it.

The app only ever touches events it created itself: their IDs are stored on the plan day
(gcal_event_id, gcal_calendar_id). Events that still have to be deleted from Google, because
the day was cleared or the cook changed while Google was unreachable, wait in gcal_deletes.

A Google error never stops the plan from being saved. It is stored on the day (gcal_error)
and shown in the app, which can try again.
"""

import json
import os
import threading
import time
from datetime import date, datetime, timedelta
from urllib.parse import quote

import httpx

from . import db

API = "https://www.googleapis.com/calendar/v3"
SCOPE = "https://www.googleapis.com/auth/calendar.events"
TIMEOUT = 10
# A dish with no times on the recipe still gets an event of this length before dinner.
DEFAULT_MINUTES = 30


class GcalError(Exception):
    pass


class NotFound(GcalError):
    pass


# ------------------------------------------------------------------ credential


def _key_info():
    """The service account key from GOOGLE_SERVICE_ACCOUNT_JSON (the JSON itself) or
    GOOGLE_SERVICE_ACCOUNT_FILE (a path to it). Never stored in the database or the repo."""
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()
    try:
        if raw:
            return json.loads(raw)
        if path:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    except (OSError, ValueError):
        return None
    return None


def service_email():
    info = _key_info()
    return info.get("client_email") if info else None


def is_configured():
    info = _key_info()
    return bool(info and info.get("client_email") and info.get("private_key"))


_token = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()


def _access_token():
    with _token_lock:
        if _token["value"] and _token["expires"] - 60 > time.time():
            return _token["value"]
        info = _key_info()
        if not info:
            raise GcalError("Google-nøkkelen mangler på serveren")
        from google.auth import crypt, jwt

        now = int(time.time())
        token_uri = info.get("token_uri", "https://oauth2.googleapis.com/token")
        assertion = jwt.encode(
            crypt.RSASigner.from_service_account_info(info),
            {
                "iss": info["client_email"],
                "scope": SCOPE,
                "aud": token_uri,
                "iat": now,
                "exp": now + 3600,
            },
        )
        try:
            res = httpx.post(
                token_uri,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": assertion,
                },
                timeout=TIMEOUT,
            )
        except httpx.HTTPError:
            raise GcalError("Fikk ikke kontakt med Google")
        if res.status_code != 200:
            try:
                err = res.json()
                reason = ": ".join(filter(None, [err.get("error"), err.get("error_description")]))
                reason = reason or res.text
            except ValueError:
                reason = res.text
            # A wrong server clock is a common cause: Google only accepts tokens issued "now".
            raise GcalError(
                f"Google godtok ikke nøkkelen til tjenestekontoen ({str(reason)[:200]}). "
                f"Serverens klokke: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}"
            )
        body = res.json()
        _token["value"] = body["access_token"]
        _token["expires"] = time.time() + int(body.get("expires_in", 3600))
        return _token["value"]


def _call(method, path, body=None):
    try:
        res = httpx.request(
            method,
            API + path,
            json=body,
            headers={"Authorization": f"Bearer {_access_token()}"},
            timeout=TIMEOUT,
        )
    except httpx.HTTPError:
        raise GcalError("Fikk ikke kontakt med Google Kalender")
    if res.status_code in (404, 410):
        raise NotFound("Fant ikke kalenderen eller hendelsen")
    if res.status_code == 403:
        raise GcalError("Appen har ikke lov til å endre kalenderen. Er den delt med «Gjøre endringer i aktiviteter»?")
    if res.status_code >= 400:
        raise GcalError(f"Google Kalender svarte med feil {res.status_code}")
    return res.json() if res.content else None


def _cal(calendar_id):
    return f"/calendars/{quote(calendar_id, safe='')}/events"


def check_calendar(calendar_id):
    """Raises GcalError if the app cannot see the calendar."""
    _call("GET", _cal(calendar_id) + "?maxResults=1")


# -------------------------------------------------------------------- settings


def is_enabled(c):
    return is_configured() and db.get_setting(c, "gcal_enabled", "0") == "1"


def status(c):
    return {
        "configured": is_configured(),
        "enabled": is_enabled(c),
        "service_email": service_email(),
        "pending_deletes": c.execute("SELECT COUNT(*) FROM gcal_deletes").fetchone()[0],
        "errors": c.execute(
            "SELECT COUNT(*) FROM plan WHERE gcal_error IS NOT NULL AND date>=?",
            (db.today().isoformat(),),
        ).fetchone()[0],
    }


# ------------------------------------------------------------------------ sync


def _event_body(row, dinner_time):
    """The event wanted for a plan day, or None if the day should have no event."""
    title = row["recipe_name"] or row["note"]
    if not title:
        return None
    day = date.fromisoformat(row["date"])
    hh, mm = (int(x) for x in dinner_time.split(":"))
    end = datetime(day.year, day.month, day.day, hh, mm)
    total = (row["prep_min"] or 0) + (row["cook_min"] or 0)
    start = end - timedelta(minutes=total or DEFAULT_MINUTES)
    tz = os.environ.get("TZ", "Europe/Oslo")
    description = []
    if row["recipe_name"] and row["note"]:
        description.append(row["note"])
    if row["cook_name"]:
        description.append(f"{row['cook_name']} lager mat. Middag kl. {dinner_time}.")
    description.append("Lagt inn av Middagsplan.")
    return {
        "summary": f"🍽 {title}",
        "description": "\n".join(description),
        "start": {"dateTime": start.strftime("%Y-%m-%dT%H:%M:00"), "timeZone": tz},
        "end": {"dateTime": end.strftime("%Y-%m-%dT%H:%M:00"), "timeZone": tz},
        "transparency": "transparent",
    }


def _flush_deletes(c):
    """Deletes events that are no longer wanted. Returns the first error, if any."""
    first_error = None
    for d in c.execute("SELECT * FROM gcal_deletes").fetchall():
        try:
            _call("DELETE", f"{_cal(d['calendar_id'])}/{quote(d['event_id'], safe='')}")
        except NotFound:
            pass  # already gone
        except GcalError as e:
            first_error = first_error or str(e)
            continue
        c.execute("DELETE FROM gcal_deletes WHERE id=?", (d["id"],))
        c.commit()
    return first_error


def forget_event(c, day):
    """Queues a day's event for deletion before the plan row is removed."""
    row = c.execute(
        "SELECT gcal_event_id, gcal_calendar_id FROM plan WHERE date=?", (day,)
    ).fetchone()
    if row and row["gcal_event_id"]:
        c.execute(
            "INSERT INTO gcal_deletes(calendar_id, event_id) VALUES(?, ?)",
            (row["gcal_calendar_id"], row["gcal_event_id"]),
        )


def sync_days(days):
    """Brings the Google events for these days in line with the plan.

    Runs after the plan is saved and committed; errors are stored, never raised.
    Days before today are left alone. Returns the first error message, or None.
    """
    with db.conn() as c:
        if not is_enabled(c):
            return None
        first_error = _flush_deletes(c)
        today = db.today().isoformat()
        dinner_time = db.get_setting(c, "dinner_time", "17:00")
        for day in sorted(set(days)):
            if day < today:
                continue
            row = c.execute(
                "SELECT p.*, r.name AS recipe_name, r.prep_min, r.cook_min, "
                "m.name AS cook_name, m.gcal_calendar_id AS cook_calendar "
                "FROM plan p LEFT JOIN recipes r ON r.id = p.recipe_id "
                "LEFT JOIN members m ON m.id = p.cook_id WHERE p.date=?",
                (day,),
            ).fetchone()
            if not row:
                continue
            error = _sync_row(c, row, dinner_time)
            c.execute("UPDATE plan SET gcal_error=? WHERE date=?", (error, day))
            c.commit()
            first_error = first_error or error
        return first_error


def _sync_row(c, row, dinner_time):
    day = row["date"]
    calendar = row["cook_calendar"] or None
    body = _event_body(row, dinner_time) if calendar else None
    event_id, event_calendar = row["gcal_event_id"], row["gcal_calendar_id"]
    try:
        # Wrong calendar (cook changed) or no event wanted: remove the old one first.
        if event_id and (body is None or event_calendar != calendar):
            try:
                _call("DELETE", f"{_cal(event_calendar)}/{quote(event_id, safe='')}")
            except NotFound:
                pass
            c.execute(
                "UPDATE plan SET gcal_event_id=NULL, gcal_calendar_id=NULL WHERE date=?", (day,)
            )
            c.commit()
            event_id = None
        if body is None:
            return None
        if event_id:
            try:
                _call("PUT", f"{_cal(calendar)}/{quote(event_id, safe='')}", body)
                return None
            except NotFound:
                pass  # deleted by hand in Google: make a new one
        created = _call("POST", _cal(calendar), body)
        c.execute(
            "UPDATE plan SET gcal_event_id=?, gcal_calendar_id=? WHERE date=?",
            (created["id"], calendar, day),
        )
        return None
    except GcalError as e:
        return str(e)


def upcoming_days(c, where="1=1", params=()):
    """Plan days from today on, optionally narrowed, for re-syncing after a wider change."""
    return [
        r["date"]
        for r in c.execute(
            f"SELECT date FROM plan WHERE date>=? AND ({where})",
            (db.today().isoformat(), *params),
        )
    ]


def sync_upcoming(where="1=1", params=()):
    with db.conn() as c:
        days = upcoming_days(c, where, params)
    return sync_days(days)
