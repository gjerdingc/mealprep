"""Oda integration: OAuth sign-in plus a minimal MCP (streamable HTTP) client.

The app registers itself as a public OAuth client with Oda, the user signs in at
oda.com, and the resulting tokens are stored in the local database. Tool calls go
to Oda's MCP server. Oda's MCP has no checkout: the app can only fill the cart.
"""

import base64
import hashlib
import json
import secrets
import time
from urllib.parse import urlencode

import httpx

from . import db

MCP_URL = "https://oda.com/mcp"
METADATA_URL = "https://oda.com/.well-known/oauth-authorization-server"
PROTOCOL_VERSION = "2025-06-18"
CLIENT_NAME = "Middagsplanlegger"
HEADERS = {"User-Agent": "dinner-planner/1.0"}
TIMEOUT = httpx.Timeout(30.0)


class OdaError(Exception):
    pass


class NotConnected(OdaError):
    pass


def _load():
    with db.conn() as c:
        return json.loads(db.get_setting(c, "oda", "{}"))


def _save(state):
    with db.conn() as c:
        db.set_setting(c, "oda", json.dumps(state))


def is_connected():
    return bool(_load().get("refresh_token") or _load().get("access_token"))


_metadata_cache = None


async def _metadata(http):
    global _metadata_cache
    if _metadata_cache is None:
        res = await http.get(METADATA_URL)
        res.raise_for_status()
        _metadata_cache = res.json()
    return _metadata_cache


def _client():
    return httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT)


async def start_connect(redirect_uri):
    """Returns the URL at Oda where the user signs in and approves access."""
    state = _load()
    async with _client() as http:
        meta = await _metadata(http)
        if not state.get("client_id") or state.get("redirect_uri") != redirect_uri:
            res = await http.post(
                meta["registration_endpoint"],
                json={
                    "client_name": CLIENT_NAME,
                    "redirect_uris": [redirect_uri],
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                    "scope": "mcp",
                },
            )
            if res.status_code >= 400:
                raise OdaError(f"Oda ville ikke registrere appen: {res.text[:300]}")
            reg = res.json()
            state = {
                "client_id": reg["client_id"],
                "client_secret": reg.get("client_secret"),
                "redirect_uri": redirect_uri,
            }
    verifier = secrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    state["pending"] = {"state": secrets.token_urlsafe(24), "verifier": verifier}
    _save(state)
    query = urlencode(
        {
            "response_type": "code",
            "client_id": state["client_id"],
            "redirect_uri": redirect_uri,
            "scope": "mcp",
            "state": state["pending"]["state"],
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": MCP_URL,
        }
    )
    return f"{meta['authorization_endpoint']}?{query}"


def _store_tokens(state, tok):
    state["access_token"] = tok["access_token"]
    if tok.get("refresh_token"):
        state["refresh_token"] = tok["refresh_token"]
    state["expires_at"] = time.time() + int(tok.get("expires_in") or 3600)


async def _token_request(http, state, data):
    meta = await _metadata(http)
    data = {**data, "client_id": state["client_id"]}
    if state.get("client_secret"):
        data["client_secret"] = state["client_secret"]
    return await http.post(meta["token_endpoint"], data=data)


async def finish_connect(code, returned_state):
    state = _load()
    pending = state.get("pending")
    if not pending or not secrets.compare_digest(pending["state"], returned_state or ""):
        raise OdaError("Innloggingen stemte ikke med en forespørsel fra denne appen. Prøv å koble til på nytt.")
    async with _client() as http:
        res = await _token_request(
            http,
            state,
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": state["redirect_uri"],
                "code_verifier": pending["verifier"],
                "resource": MCP_URL,
            },
        )
    if res.status_code >= 400:
        raise OdaError(f"Oda godtok ikke innloggingen: {res.text[:300]}")
    _store_tokens(state, res.json())
    state.pop("pending", None)
    _save(state)


async def disconnect():
    state = _load()
    token = state.get("refresh_token") or state.get("access_token")
    if token and state.get("client_id"):
        try:
            async with _client() as http:
                meta = await _metadata(http)
                await http.post(
                    meta["revocation_endpoint"],
                    data={"token": token, "client_id": state["client_id"]},
                )
        except httpx.HTTPError:
            pass  # still forget the tokens locally
    for key in ("access_token", "refresh_token", "expires_at", "pending"):
        state.pop(key, None)
    _save(state)


async def _access_token(http, force_refresh=False):
    state = _load()
    if not state.get("access_token"):
        raise NotConnected("Oda er ikke koblet til.")
    if not force_refresh and state.get("expires_at", 0) - 60 > time.time():
        return state["access_token"]
    if not state.get("refresh_token"):
        if force_refresh:
            raise NotConnected("Innloggingen hos Oda har utløpt. Koble til på nytt.")
        return state["access_token"]
    res = await _token_request(
        http, state, {"grant_type": "refresh_token", "refresh_token": state["refresh_token"]}
    )
    if res.status_code >= 400:
        for key in ("access_token", "refresh_token", "expires_at"):
            state.pop(key, None)
        _save(state)
        raise NotConnected("Innloggingen hos Oda har utløpt. Koble til på nytt.")
    _store_tokens(state, res.json())
    _save(state)
    return state["access_token"]


def _parse_rpc(res, request_id):
    """A streamable-HTTP reply is either plain JSON or an SSE stream of JSON messages."""
    if "text/event-stream" in res.headers.get("content-type", ""):
        for event in res.text.replace("\r\n", "\n").split("\n\n"):
            data = "\n".join(
                line[5:].lstrip() for line in event.split("\n") if line.startswith("data:")
            )
            if not data:
                continue
            try:
                msg = json.loads(data)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") == request_id:
                return msg
        raise OdaError("Oda svarte ikke.")
    return res.json()


async def _rpc(http, token, session, method, params=None, request_id=None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if session.get("id"):
        headers["Mcp-Session-Id"] = session["id"]
    if session.get("version"):
        headers["MCP-Protocol-Version"] = session["version"]
    body = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    if request_id is not None:
        body["id"] = request_id
    res = await http.post(MCP_URL, headers=headers, json=body)
    if res.status_code == 401:
        raise PermissionError
    if res.status_code >= 400:
        raise OdaError(f"Oda svarte {res.status_code}: {res.text[:300]}")
    if res.headers.get("mcp-session-id"):
        session["id"] = res.headers["mcp-session-id"]
    if request_id is None:
        return None
    msg = _parse_rpc(res, request_id)
    if msg.get("error"):
        raise OdaError(msg["error"].get("message") or "Oda meldte om en feil.")
    return msg.get("result") or {}


async def _call_once(http, token, name, arguments):
    session = {}
    init = await _rpc(
        http,
        token,
        session,
        "initialize",
        {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "dinner-planner", "version": "1.0"},
        },
        request_id=1,
    )
    session["version"] = init.get("protocolVersion", PROTOCOL_VERSION)
    await _rpc(http, token, session, "notifications/initialized")
    result = await _rpc(
        http, token, session, "tools/call", {"name": name, "arguments": arguments}, request_id=2
    )
    text = "".join(c.get("text", "") for c in result.get("content") or [] if c.get("type") == "text")
    if result.get("isError"):
        raise OdaError(text or "Oda meldte om en feil.")
    if result.get("structuredContent") is not None:
        return result["structuredContent"]
    try:
        return json.loads(text)
    except ValueError:
        return {"text": text}


async def call_tool(name, arguments):
    try:
        async with _client() as http:
            token = await _access_token(http)
            try:
                return await _call_once(http, token, name, arguments)
            except PermissionError:
                token = await _access_token(http, force_refresh=True)
                try:
                    return await _call_once(http, token, name, arguments)
                except PermissionError:
                    raise NotConnected("Oda godtar ikke lenger innloggingen. Koble til på nytt.")
    except httpx.HTTPError as e:
        raise OdaError(f"Fikk ikke kontakt med Oda: {e}") from e


def _slim(p):
    availability = p.get("availability") or {}
    return {
        "id": p.get("id"),
        "name": p.get("name"),
        "description": p.get("description") or "",
        "brand": p.get("brand") or "",
        "price": p.get("price"),
        "unit_price": p.get("unitPrice"),
        "unit_name": p.get("unitName"),
        "url": p.get("url"),
        "available": availability.get("isAvailable", True),
    }


async def search(queries):
    """Returns {query: [products]} for each query."""
    out = {}
    queries = list(dict.fromkeys(q for q in queries if q))
    for i in range(0, len(queries), 10):
        chunk = queries[i : i + 10]
        res = await call_tool("product_search", {"queries": chunk, "size": 5})
        entries = res.get("result") if isinstance(res, dict) else res
        for entry in entries or []:
            out[entry.get("query")] = [_slim(p) for p in entry.get("products") or []]
    return out


async def add_to_cart(operations):
    """operations: [{"productId": int, "quantity": int}]. Returns a cart summary."""
    cart = await call_tool("manipulate_cart", {"operations": operations})
    return {
        "url": cart.get("url"),
        "total": cart.get("totalGrossAmount"),
        "count": cart.get("productQuantityCount"),
        "messages": cart.get("validationMessages") or [],
    }
