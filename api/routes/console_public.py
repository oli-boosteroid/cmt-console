"""
Public (NO AUTH) surface for the Known Issues page at /knownissues.

Everything reachable without a login lives here, in one file, so the exposed surface is easy to audit.
It exposes ONLY:
  GET  /knownissues[/<game_id>]              -> the standalone public page (a single self-contained HTML
                                                file; it never loads the console SPA or any authed API).
  GET  /api/console/public/known-issues      -> the published Known Issues (sanitised to the 5 display
                                                fields) plus a title->ID map for games that have issues.
  GET  /api/console/public/game/<game_id>    -> resolve one Game-List ID to its title (for deep links).
  GET  /api/console/public/games?q=...        -> up to 8 Game-List titles matching q (id, title, launcher
                                                only), so a game with no issues can still be found and
                                                suggested; nothing else from the Game List leaves.
  POST /api/console/public/feedback          -> a rate-limited Suggestion/Bug about the page itself; it lands
                                                in the console Feedback list (admins are alerted).
  POST /api/console/public/known-issues-suggest -> a rate-limited, size-capped suggestion that lands in
                                                the SAME admin approval queue as in-console suggestions;
                                                it is NEVER published until an admin approves it.

Nothing here reads or returns anything else in the database. Pending suggestions are never served back to
the public - only admins (behind auth, in console_api) can read them.
"""
import time
from datetime import datetime, timedelta
from pathlib import Path

from flask import Blueprint, jsonify, request, send_from_directory

from api.routes.console_db import sync_db

WEB_DIR = Path(__file__).parent.parent.parent / "web"

console_public_bp = Blueprint("console_public", __name__)

_KI_CATS = ("games", "apps", "session", "account")

# --- suggestion limits (defence for a no-auth endpoint) --------------------------------------------
_MAX = {"entity": 120, "problem": 200, "solution": 4000, "canned": 4000, "link": 500, "name": 80}
_RATE_WINDOW_SEC = 3600          # per-IP window
_RATE_MAX = 6                    # max submissions per IP per window
_PENDING_CAP = 800               # global safety cap on the pending queue (stops a flood of the admin view)

try:  # auto-expire rate rows after the window so the collection self-prunes
    sync_db["public_suggest_rate"].create_index("at", expireAfterSeconds=_RATE_WINDOW_SEC + 120)
    sync_db["public_feedback_rate"].create_index("at", expireAfterSeconds=_RATE_WINDOW_SEC + 120)
except Exception:
    pass

_FEEDBACK_RATE_MAX = 5           # public feedback per IP per window
_FEEDBACK_MAX_LEN = 2000
_GAMES_TTL = 600                 # in-process cache of the Game List titles used by the public game search
_games_cache = {"at": 0.0, "rows": None}


_PUBLIC_BODY_MAX = 64 * 1024              # a suggestion / feedback is a few KB of text
_PUBLIC_UPLOAD_MAX = 1536 * 1024          # one screenshot (max 1 MB) + multipart overhead


def _str(data, key):
    """A text field from a JSON body; anything that is not a string (number, list, object) counts as empty."""
    v = data.get(key) if isinstance(data, dict) else None
    return v if isinstance(v, str) else ""


@console_public_bp.before_request
def _public_body_cap():
    """The app allows 55 MB bodies (Jira attachments). Public no-auth POSTs never need that: refuse big
    bodies before Flask reads them, so nobody can push large uploads at the server for free."""
    if request.method != "POST" or not (request.path or "").startswith("/api/console/public/"):
        return None
    cap = _PUBLIC_UPLOAD_MAX if request.path.endswith("/shots") else _PUBLIC_BODY_MAX
    if request.content_length is None or request.content_length > cap:
        return jsonify({"error": "Request too large."}), 413
    return None


def _client_ip():
    """Client IP behind Railway's proxy. The proxy APPENDS the address it saw to X-Forwarded-For, so the
    LAST hop is the real one; the first hop is whatever the client sent and could be faked to dodge
    the rate limit."""
    xff = (request.headers.get("X-Forwarded-For") or "").split(",")[-1].strip()
    return xff or (request.remote_addr or "")


def _http_url(v):
    """Return v if it is a plain http(s) URL, else ''. Blocks javascript:/data: and other schemes."""
    s = (v or "").strip()
    low = s.lower()
    if low.startswith("http://") or low.startswith("https://"):
        return s[:_MAX["link"]]
    return ""


def _row(r, shots=None):
    """Whitelist a stored known-issue row down to the five display fields (nothing else leaves), plus the
    public R2 URLs of its screenshots when it has any."""
    out = {
        "entity": str(r.get("entity") or ""),
        "problem": str(r.get("problem") or ""),
        "solution": str(r.get("solution") or ""),
        "link": _http_url(r.get("link")),
        "canned": str(r.get("canned") or ""),
    }
    urls = [_http_url(s.get("url")) for s in (shots or [])]
    urls = [u for u in urls if u]
    if urls:
        out["shots"] = urls
    return out


def _game_ids_by_title():
    """Known Issues entity -> [Game-List IDs], keyed by game_match_key ("base|launcher"). A "(Xbox)" entity
    resolves only to the Xbox row (Platform column); a plain entity resolves to all platforms. Indexed on
    `norm`, only for games that have an issue."""
    from services.game_title import norm_game_title, split_launcher, game_match_key
    doc = sync_db["known_issues"].find_one({"_id": "games"}) or {}
    entities, bases = [], set()
    for r in (doc.get("rows") or []):
        e = (r.get("entity") or "").strip()
        if not e:
            continue
        entities.append(e)
        bases.add(split_launcher(e)[0])
    if not bases:
        return {}
    gl = {}
    for g in sync_db["game_list"].find({"norm": {"$in": list(bases)}}, {"id": 1, "title": 1, "norm": 1, "platform": 1}):
        b = g.get("norm") or norm_game_title(g.get("title"))
        gl.setdefault(b, []).append((str(g.get("id")), str(g.get("platform") or "").strip().lower()))
    if not gl:
        for g in sync_db["game_list"].find({}, {"id": 1, "title": 1, "platform": 1}):
            b = norm_game_title(g.get("title"))
            if b in bases:
                gl.setdefault(b, []).append((str(g.get("id")), str(g.get("platform") or "").strip().lower()))
    out = {}
    for e in entities:
        b, launcher = split_launcher(e)
        cands = gl.get(b, [])
        if launcher:
            ids = [gid for (gid, plat) in cands if plat == launcher]
            if not ids and cands and all(not plat for (gid, plat) in cands):
                ids = [gid for (gid, plat) in cands]
        else:
            ids = [gid for (gid, plat) in cands]
        if ids:
            out[game_match_key(e)] = ids
    return out


# --- cmthelper (our Reddit Devvit app): public Terms / Privacy pages that Reddit's app review requires ---
@console_public_bp.route("/cmthelper/terms")
def cmthelper_terms():
    return send_from_directory(WEB_DIR, "cmthelper-terms.html")


@console_public_bp.route("/cmthelper/privacy")
def cmthelper_privacy():
    return send_from_directory(WEB_DIR, "cmthelper-privacy.html")


# --- page --------------------------------------------------------------------------------------------
@console_public_bp.route("/knownissues")
@console_public_bp.route("/knownissues/")
@console_public_bp.route("/knownissues/<path:game_id>")
def public_known_issues_page(game_id=None):
    # One static page for every variant; the client reads the optional game ID from the URL path itself,
    # so there is nothing per-request to inject (and nothing to leak). Minified so DevTools shows no comments.
    from api.routes.console import minify_asset
    resp = send_from_directory(WEB_DIR, "knownissues.html")
    resp.direct_passthrough = False
    resp.set_data(minify_asset("knownissues.html", resp.get_data()))
    return resp


@console_public_bp.route("/knownissues-fonts/<name>")
def public_known_issues_font(name):
    # The page's fonts are served from here (not Google Fonts), so a visitor's IP never goes to Google.
    if not (name.endswith(".woff2") or name == "knownissues-fonts.css") or "/" in name or "\\" in name:
        return "Not found", 404
    resp = send_from_directory(WEB_DIR / "fonts", name,
                               mimetype="font/woff2" if name.endswith(".woff2") else "text/css")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable" if name.endswith(".woff2") else "public, max-age=86400"
    return resp


@console_public_bp.route("/knownissues.js")
def public_known_issues_js():
    # The page's script lives in a same-origin external file, NOT inline, so the console's strict CSP
    # (script-src 'self') runs it without needing 'unsafe-inline'. Minified (no comments in DevTools).
    from api.routes.console import minify_asset
    resp = send_from_directory(WEB_DIR, "knownissues.js", mimetype="application/javascript")
    resp.direct_passthrough = False
    resp.set_data(minify_asset("knownissues.js", resp.get_data()))
    return resp


@console_public_bp.after_request
def _public_headers(resp):
    p = request.path or ""
    if p == "/knownissues" or p.startswith("/knownissues/") or p == "/knownissues.js":
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["X-Frame-Options"] = "DENY"
    return resp


# --- public read -------------------------------------------------------------------------------------
# The Known Issues data changes only on the (roughly daily) sync, but the page is hit constantly, so cache
# the whole computed payload in-process for a short TTL. This turns the ~2s Mongo read + intersection into
# a ~0ms dict return for almost every request, and a matching Cache-Control lets the browser/CDN skip the
# request entirely on a repeat visit within the window.
_KI_PUBLIC_TTL = 120
_ki_public_cache = {"at": 0.0, "payload": None}


def _public_known_issues_payload():
    now = time.time()
    c = _ki_public_cache
    if c["payload"] is not None and (now - c["at"]) < _KI_PUBLIC_TTL:
        return c["payload"]
    from services import ki_shots
    smap = ki_shots.shots_map(sync_db)
    out = {}
    for d in sync_db["known_issues"].find({}):
        cat = d.get("category") or d.get("_id")
        if cat not in _KI_CATS:
            continue
        out[cat] = {"has_entity": bool(d.get("has_entity")),
                    "rows": [_row(r, smap.get(ki_shots.issue_key(cat, r.get("entity"), r.get("problem"))))
                             for r in (d.get("rows") or [])]}
    meta = (sync_db["console_config"].find_one({"key": "known_issues_meta"}) or {}).get("value") or {}
    from services import r2_store
    payload = {"categories": out, "game_ids": _game_ids_by_title(), "updated_at": meta.get("updated_at", ""),
               "shots_enabled": r2_store.configured()}
    c["payload"] = payload
    c["at"] = now
    return payload


@console_public_bp.route("/api/console/public/known-issues", methods=["GET"])
def public_known_issues():
    resp = jsonify(_public_known_issues_payload())
    resp.headers["Cache-Control"] = "public, max-age=%d" % _KI_PUBLIC_TTL
    return resp, 200


@console_public_bp.route("/api/console/public/game/<path:game_id>", methods=["GET"])
def public_game_lookup(game_id):
    gid = (game_id or "").strip()
    g = sync_db["game_list"].find_one({"_id": gid}, {"_id": 0, "id": 1, "title": 1}) if gid else None
    if not g:
        return jsonify({"ok": False}), 404
    return jsonify({"ok": True, "id": str(g.get("id") or gid), "title": str(g.get("title") or "")}), 200


# --- public game search: lets the page find games that have NO issues yet ----------------------------
def _all_games():
    now = time.time()
    if _games_cache["rows"] is not None and (now - _games_cache["at"]) < _GAMES_TTL:
        return _games_cache["rows"]
    rows = []
    for g in sync_db["game_list"].find({}, {"_id": 1, "id": 1, "title": 1, "platform": 1}):
        t = str(g.get("title") or "").strip()
        if t:
            rows.append((t.lower(), str(g.get("id") or g.get("_id") or ""), t, str(g.get("platform") or "").strip()))
    rows.sort(key=lambda r: r[0])
    _games_cache["rows"], _games_cache["at"] = rows, now
    return rows


@console_public_bp.route("/api/console/public/games", methods=["GET"])
def public_game_search():
    q = (request.args.get("q") or "").strip().lower()[:80]
    if len(q) < 2:
        return jsonify({"games": []}), 200
    starts, contains = [], []
    for low, gid, title, plat in _all_games():
        if low.startswith(q):
            starts.append({"id": gid, "title": title, "launcher": plat})
        elif q in low:
            contains.append({"id": gid, "title": title, "launcher": plat})
        if len(starts) >= 8:
            break
    resp = jsonify({"games": (starts + contains)[:8]})
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp, 200


# --- public feedback about the page (into the console Feedback list) ---------------------------------
@console_public_bp.route("/api/console/public/feedback", methods=["POST"])
def public_feedback():
    data = request.get_json(silent=True)
    data = data if isinstance(data, dict) else {}
    if _str(data, "website").strip():          # honeypot, same as the suggestion form
        return jsonify({"ok": True}), 200
    category = _str(data, "category").strip()
    if category not in ("Suggestion", "Bug", "Question"):
        return jsonify({"error": "Pick a category"}), 400
    message = _str(data, "message").strip()[:_FEEDBACK_MAX_LEN]
    if not message:
        return jsonify({"error": "Message is required"}), 400
    ip = _client_ip()
    now = datetime.utcnow()
    rate = sync_db["public_feedback_rate"]
    try:
        if ip and rate.count_documents({"ip": ip, "at": {"$gte": now - timedelta(seconds=_RATE_WINDOW_SEC)}}) >= _FEEDBACK_RATE_MAX:
            return jsonify({"error": "Too many messages. Please try again later."}), 429
    except Exception:
        pass
    name = _str(data, "name").strip()[:_MAX["name"]]
    by = (name + " (Known Issues page)") if name else "Known Issues page"
    from api.routes.console_state import feedback_col, _admin_notify
    feedback_col.insert_one({"category": category, "message": message, "status": "New", "created_at": now,
                             "author_name": by, "author_email": "", "source": "public"})
    try:
        rate.insert_one({"ip": ip, "at": now})
    except Exception:
        pass
    _admin_notify("feedback_new", "New feedback: " + category, by + ": " + message[:160], route="#/feedback")
    return jsonify({"ok": True}), 201


# --- public suggestion (into the existing admin approval queue) --------------------------------------
@console_public_bp.route("/api/console/public/known-issues-suggest", methods=["POST"])
def public_suggest():
    data = request.get_json(silent=True)
    data = data if isinstance(data, dict) else {}

    # Honeypot: real users never see or fill this field; bots that fill every input do. Accept silently
    # (so a bot cannot tell it was dropped) but store nothing.
    if _str(data, "website").strip():
        return jsonify({"ok": True}), 200

    category = _str(data, "category").strip().lower()
    if category not in _KI_CATS:
        return jsonify({"error": "invalid category"}), 400
    problem = _str(data, "problem").strip()[:_MAX["problem"]]
    if not problem:
        return jsonify({"error": "problem is required"}), 400

    ip = _client_ip()
    now = datetime.utcnow()
    rate = sync_db["public_suggest_rate"]
    try:
        window_start = now - timedelta(seconds=_RATE_WINDOW_SEC)
        if ip and rate.count_documents({"ip": ip, "at": {"$gte": window_start}}) >= _RATE_MAX:
            return jsonify({"error": "Too many submissions. Please try again later."}), 429
    except Exception:
        pass
    try:
        if sync_db["known_issues_suggestions"].estimated_document_count() >= _PENDING_CAP:
            return jsonify({"error": "The suggestion queue is full. Please try again later."}), 429
    except Exception:
        pass

    name = _str(data, "name").strip()[:_MAX["name"]]
    from api.routes.console_state import _ki_entities   # shared parsing of the games list (lazy: no import cycle)
    doc = {
        "category": category,
        "entity": "",
        "entities": _ki_entities(data, cap=_MAX["entity"])[:10],
        "problem": problem,
        "solution": _str(data, "solution").strip()[:_MAX["solution"]],
        "link": _http_url(data.get("link")),
        "canned": _str(data, "canned").strip()[:_MAX["canned"]],
        "by": (name + " (public)") if name else "Public page",
        "by_email": "",
        "source": "public",
        "created_at": now,
    }
    doc["entity"] = doc["entities"][0] if doc["entities"] else ""
    from services import ki_shots
    token = ki_shots.new_upload_token(doc, now)   # lets THIS browser attach up to 3 screenshots for 30 min
    sync_db["known_issues_suggestions"].insert_one(doc)
    try:
        rate.insert_one({"ip": ip, "at": now})
    except Exception:
        pass
    from api.routes.console_state import _ki_suggest_notify
    _ki_suggest_notify(doc)
    return jsonify({"ok": True, "id": str(doc["_id"]), "upload_token": token}), 201


try:
    sync_db["public_shot_rate"].create_index("at", expireAfterSeconds=3600 + 120)
except Exception:
    pass


def _find_issue_row(category, entity, problem):
    """The published row a public addition points at (normalised match), or None."""
    from services.ki_shots import _norm
    doc = sync_db["known_issues"].find_one({"_id": category}) or sync_db["known_issues"].find_one({"category": category}) or {}
    ent_on = category in ("games", "apps")
    for r in doc.get("rows") or []:
        if _norm(r.get("problem")) == _norm(problem) and (not ent_on or _norm(r.get("entity")) == _norm(entity)):
            return r
    return None


@console_public_bp.route("/api/console/public/known-issues-suggest-addition", methods=["POST"])
def public_suggest_addition():
    """Suggest what an EXISTING issue is missing: its canned message and/or screenshots. Lands in the same
    admin queue (kind "addition"); on approve the canned message is written into that sheet row and the
    screenshots are attached to the issue. Same honeypot / rate limit / queue cap as a new suggestion."""
    data = request.get_json(silent=True)
    data = data if isinstance(data, dict) else {}
    if _str(data, "website").strip():
        return jsonify({"ok": True}), 200
    category = _str(data, "category").strip().lower()
    if category not in _KI_CATS:
        return jsonify({"error": "invalid category"}), 400
    entity = _str(data, "entity").strip()[:_MAX["entity"]]
    problem = _str(data, "problem").strip()[:_MAX["problem"]]
    row = _find_issue_row(category, entity, problem) if problem else None
    if not row:
        return jsonify({"error": "This issue was not found. Refresh the page and try again."}), 400
    canned = _str(data, "canned").strip()[:_MAX["canned"]]
    try:
        with_shots = max(0, min(3, int(data.get("with_shots") or 0)))
    except Exception:
        with_shots = 0
    if canned and (row.get("canned") or "").strip():
        canned = ""   # it got one in the meantime: keep only the screenshots part
    if not canned and not with_shots:
        return jsonify({"error": "Add a canned message or a screenshot."}), 400

    ip = _client_ip()
    now = datetime.utcnow()
    rate = sync_db["public_suggest_rate"]
    try:
        if ip and rate.count_documents({"ip": ip, "at": {"$gte": now - timedelta(seconds=_RATE_WINDOW_SEC)}}) >= _RATE_MAX:
            return jsonify({"error": "Too many submissions. Please try again later."}), 429
        if sync_db["known_issues_suggestions"].estimated_document_count() >= _PENDING_CAP:
            return jsonify({"error": "The suggestion queue is full. Please try again later."}), 429
    except Exception:
        pass
    name = _str(data, "name").strip()[:_MAX["name"]]
    ent = (row.get("entity") or "").strip() if category in ("games", "apps") else ""
    doc = {"kind": "addition", "category": category, "entity": ent, "entities": [ent] if ent else [],
           "problem": (row.get("problem") or problem).strip(), "canned": canned, "with_shots": with_shots,
           "solution": "", "link": "",
           "by": (name + " (public)") if name else "Public page", "by_email": "", "source": "public", "created_at": now}
    from services import ki_shots
    token = ki_shots.new_upload_token(doc, now)
    sync_db["known_issues_suggestions"].insert_one(doc)
    try:
        rate.insert_one({"ip": ip, "at": now})
    except Exception:
        pass
    from api.routes.console_state import _ki_suggest_notify
    _ki_suggest_notify(doc)
    return jsonify({"ok": True, "id": str(doc["_id"]), "upload_token": token}), 201


@console_public_bp.route("/api/console/public/known-issues-suggest-edit", methods=["POST"])
def public_suggest_edit():
    """Suggest a change to an EXISTING issue's Problem / Solution / Canned message. Only fields that really
    differ are stored; an admin reviews them and Approve writes them into that sheet row."""
    data = request.get_json(silent=True)
    data = data if isinstance(data, dict) else {}
    if _str(data, "website").strip():
        return jsonify({"ok": True}), 200
    category = _str(data, "category").strip().lower()
    if category not in _KI_CATS:
        return jsonify({"error": "invalid category"}), 400
    row = _find_issue_row(category, _str(data, "entity").strip(), _str(data, "problem").strip())
    if not row:
        return jsonify({"error": "This issue was not found. Refresh the page and try again."}), 400
    new = {"problem": _str(data, "new_problem").strip()[:_MAX["problem"]],
           "solution": _str(data, "new_solution").strip()[:_MAX["solution"]],
           "canned": _str(data, "new_canned").strip()[:_MAX["canned"]]}
    if not new["problem"]:
        return jsonify({"error": "The problem can not be empty."}), 400
    changes = {k: v for k, v in new.items() if " ".join(v.split()) != " ".join(str(row.get(k) or "").split())}
    if not changes:
        return jsonify({"error": "Nothing was changed."}), 400
    ip = _client_ip()
    now = datetime.utcnow()
    rate = sync_db["public_suggest_rate"]
    try:
        if ip and rate.count_documents({"ip": ip, "at": {"$gte": now - timedelta(seconds=_RATE_WINDOW_SEC)}}) >= _RATE_MAX:
            return jsonify({"error": "Too many submissions. Please try again later."}), 429
        if sync_db["known_issues_suggestions"].estimated_document_count() >= _PENDING_CAP:
            return jsonify({"error": "The suggestion queue is full. Please try again later."}), 429
    except Exception:
        pass
    ent = (row.get("entity") or "").strip() if category in ("games", "apps") else ""
    doc = {"kind": "edit", "category": category, "entity": ent, "entities": [ent] if ent else [],
           "problem": (row.get("problem") or "").strip(), "changes": changes,
           "current": {k: str(row.get(k) or "") for k in ("problem", "solution", "canned")},
           "solution": "", "link": "", "canned": "",
           "by": "Public page", "by_email": "", "source": "public", "created_at": now}
    sync_db["known_issues_suggestions"].insert_one(doc)
    try:
        rate.insert_one({"ip": ip, "at": now})
    except Exception:
        pass
    from api.routes.console_state import _ki_suggest_notify
    _ki_suggest_notify(doc)
    return jsonify({"ok": True}), 201


@console_public_bp.route("/api/console/public/known-issues-suggest/<sid>/shots", methods=["POST"])
def public_suggest_shot(sid):
    """Attach one screenshot to a suggestion that was JUST created (from the public page or the console).
    Needs the one-time upload token returned by the suggest call; limits live in services/ki_shots.py.
    The image stays private (admins see it in the review queue) until the suggestion is approved."""
    from services import ki_shots
    status, body = ki_shots.store_suggestion_shot(sync_db, sid, request.form.get("token"),
                                                  request.files.get("file"), _client_ip())
    return jsonify(body), status
