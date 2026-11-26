"""
Console JSON API - read layer.

Serves the CMT Console real data from the bot's own MongoDB, so the web console
(served at /console/) can switch off mock data. This module is READ-ONLY: it
never mutates Mongo and never triggers any bot action. Write/action endpoints and
auth land in later slices.

Security: every endpoint requires auth via `login_required` (a valid console session,
nothing else: there is no service token).
This module is read-only - it never mutates Mongo and never triggers a bot action.
"""
import logging
import os
import re
import time
from base64 import b64encode
from datetime import datetime, date

# Jira calls go through services/jira_http: direct with the Jira key, or (on the VM) via the bot's gateway
# with no Jira key here at all. Same interface as `requests`; other hosts pass straight through.
from services import jira_http as requests
from urllib.parse import quote
from flask import Blueprint, jsonify, request, Response
from bson import ObjectId

_JIRA_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")
_JIRA_COMM_FIELD = os.getenv("JIRA_COMMUNICATION_LINK_FIELD", "communication_link")
_JIRA_PROJECT = os.getenv("JIRA_PROJECT_KEY", "SO")
_JIRA_URG_PROJECT = os.getenv("JIRA_URG_PROJECT_KEY", "URG")       # Urgent Request board
_JIRA_URG_ISSUETYPE = os.getenv("JIRA_URG_ISSUE_TYPE", "Task")
_JIRA_URG_REVIEW = os.getenv("JIRA_URG_REVIEW_STATUS", "Review")  # URG "Review" column (To-Do source)
_JIRA_URG_UPDATE_RESULT = os.getenv("JIRA_URG_UPDATE_RESULT_FIELD", "customfield_10478")  # URG resolution
_URG_UPDATE_RESULT_BY_ID = {"10300": "Fixed", "10335": "Disabled", "10301": "Started maintenance", "10302": "No replication"}
_TEAM_COMM_RE = re.compile(r"reddit|facebook|discord", re.I)  # matches select values AND urls
_JIRA_L1_FIELD = "customfield_10209"
_JIRA_L1_TAGS = {  # lowercase key -> option id (mirrors jira_service.JiraL1Tags)
    "native_desktop": "10111", "native_android": "10112", "webclient": "10113",
    "web_tv": "10114", "game": "10115", "launcher": "10120", "subscription": "10116",
    "stream": "10117", "web_backend": "10118", "tbd": "10119",
}
_JIRA_L1_ID_TO_KEY = {v: k for k, v in _JIRA_L1_TAGS.items()}  # option id -> lowercase key
_MAX_ATTACH = 50 * 1024 * 1024  # 50 MB cap for console-side attachment uploads

# accountId of the Jira account the console/bot authenticates as (JIRA_API_EMAIL). Fetched once
# and cached; used to mark which comments were "left through the bot" (and so are editable here).
_MY_ACCOUNT_ID = None
_MY_ACCOUNT_FETCHED = False


def _jira_env():
    return requests.credentials()


def _jira_headers(email, token):
    return {"Authorization": "Basic " + b64encode((email + ":" + token).encode()).decode(),
            "Accept": "application/json"}


def _comm_link_str(value):
    """Flatten the Communication Link custom field (select {value}, list, or plain text) to a string."""
    if not value:
        return ""
    if isinstance(value, dict):
        return str(value.get("value") or value.get("name") or "")
    if isinstance(value, list):
        return " ".join(_comm_link_str(v) for v in value)
    return str(value)


def _rewrite_jira_html(html, base):
    """Route <img src> that points at Jira (needs auth) through our /jira-attachment proxy so
    images actually load in the browser. Links (<a href>) are left as-is (already clickable)."""
    if not html:
        return html or ""

    def repl(m):
        src = m.group(1)
        full = src if src.startswith("http") else (base + src if src.startswith("/") else "")
        if not full or not full.startswith(base):
            return m.group(0)
        return 'src="/api/console/jira-attachment?url=' + quote(full, safe="") + '"'

    return re.sub(r'src="([^"]+)"', repl, html)


def _jira_err(r):
    """Human-readable Jira error (surfaces the exact field problem, e.g. wrong comm-link format)."""
    try:
        j = r.json()
        parts = list(j.get("errorMessages") or []) + ["%s: %s" % (k, v) for k, v in (j.get("errors") or {}).items()]
        if parts:
            return "jira %s - %s" % (r.status_code, "; ".join(parts))
    except Exception as _e:
        logger.warning("ignored: %s", _e)
    return "jira %s" % r.status_code


def _my_account_id(base, headers):
    """The authenticated account's accountId (cached). '' when it can't be resolved."""
    global _MY_ACCOUNT_ID, _MY_ACCOUNT_FETCHED
    if _MY_ACCOUNT_FETCHED:
        return _MY_ACCOUNT_ID or ""
    _MY_ACCOUNT_FETCHED = True
    try:
        r = requests.get(base + "/rest/api/2/myself", headers=headers, timeout=10)
        if r.status_code == 200:
            _MY_ACCOUNT_ID = (r.json() or {}).get("accountId") or ""
    except Exception as e:
        logger.error("[Console] jira myself failed: %s", e)
    return _MY_ACCOUNT_ID or ""


def _read_l1_tags(value):
    """Flatten the L1 Tags multi-select field value ([{id,value}, ...]) to our lowercase keys."""
    out = []
    if isinstance(value, list):
        for opt in value:
            oid = (opt or {}).get("id") if isinstance(opt, dict) else None
            key = _JIRA_L1_ID_TO_KEY.get(str(oid)) if oid is not None else None
            if key:
                out.append(key)
    return out


def _editmeta_fields(base, headers, key):
    """The issue's editable-field schemas ({fieldId: {schema, allowedValues, ...}}), or {}."""
    try:
        r = requests.get(base + "/rest/api/2/issue/" + key + "/editmeta", headers=headers, timeout=15)
        if r.status_code == 200:
            return (r.json() or {}).get("fields") or {}
    except Exception as e:
        logger.error("[Console] editmeta failed for %s: %s", key, e)
    return {}


def _commlink_payload(meta_field, value):
    """Shape the Communication Link value for the field's REAL schema (resolved at runtime via
    editmeta), so it works whether the field is a select option, a multi-select, or plain text."""
    schema = (meta_field or {}).get("schema") or {}
    t = schema.get("type")
    if t == "option":
        return {"value": value} if value else None
    if t == "array" and schema.get("items") == "option":
        return [{"value": value}] if value else []
    return value  # string / url / unknown -> plain text (matches jira_service.set_issue_communication_link)

# Light Mongo access (no bot deps) so this works in the standalone console service too.
from api.routes import console_db as M
from api.routes.console_auth import login_required, admin_required, perm_required
from api.routes import console_live
from api.routes.console_live import live

logger = logging.getLogger(__name__)

console_api_bp = Blueprint("console_api", __name__, url_prefix="/api/console")
console_api_bp.after_request(console_live.after_write)


@console_api_bp.after_request
def _api_headers(resp):
    """Security headers + conditional GET (ETag/304). The console re-polls these read lists every
    45s; when the data is unchanged the response is a bodiless 304, so per-user polling barely
    touches Railway egress. Big JSON lists (discord tickets, modmail, posts) benefit most."""
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    if request.method == "GET" and resp.status_code == 200 and resp.mimetype == "application/json":
        resp.headers["Cache-Control"] = "no-cache, private"
        resp.add_etag()
        return resp.make_conditional(request)
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _clean(value):
    """Make a Mongo document JSON-serializable (ObjectId -> str, datetimes -> iso)."""
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    # Discord snowflakes (channel_id/user_id/...) are 64-bit ints; JS JSON.parse loses precision
    # beyond 2**53, which corrupts the "Open in Discord" link and Discord identity matching. Emit
    # big ints as strings (bool is an int subclass but always small, so it stays a JSON boolean).
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 9007199254740991:
        return str(value)
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    return value


# --- tiny in-process response cache -----------------------------------------------------------------
# The main Atlas cluster (sync_db) is slow per-document, so a couple of heavy-but-slow-changing directory
# reads (the full email directory, the Jira mirror) dominate every hydrate and background refresh even
# though they return only a few hundred docs. Cache their built payload in-process for a short TTL. Only
# these directory-style reads are cached - the realtime surfaces (tickets, messages, statuses) are never
# cached, so live triage stays fresh. Waitress is single-process, so one dict is shared across threads;
# CPython dict get/set is atomic under the GIL, so no lock is needed.
_resp_cache = {}   # key -> (expires_at, value)


def _cache_get(key):
    hit = _resp_cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    return None


def _cache_put(key, value, ttl):
    _resp_cache[key] = (time.time() + ttl, value)
    return value


def _cache_bust(key):
    _resp_cache.pop(key, None)


def _find(collection, limit=500, sort=None, exclude=None, query=None, skip=0):
    # `exclude` is an all-exclusion projection like {"field": 0} to drop heavy fields.
    q = query or {}
    cur = collection.find(q, exclude) if exclude else collection.find(q)
    if sort:
        cur = cur.sort(sort[0], sort[1])
    if skip:
        cur = cur.skip(skip)
    return [_clean(doc) for doc in cur.limit(limit)]


@console_api_bp.route("/poll", methods=["GET"])
@login_required
def poll():
    """Version map for the lists the console keeps live: {key: etag}. The client calls this every few
    seconds and re-fetches only the lists whose etag changed (see console_live)."""
    from api.routes.console_auth import current_user, user_has_perm
    u = current_user()
    resp = jsonify({"v": console_live.versions(lambda perm: not perm or user_has_perm(u, perm))})
    resp.headers["Cache-Control"] = "no-store"
    return resp, 200


@console_api_bp.route("/poll-keys", methods=["GET"])
@login_required
def poll_keys():
    """{key: path} of the live lists (instant: nothing is built). The console seeds its version map from
    the ETags of the lists it just loaded, so the first load never waits for /poll."""
    from api.routes.console_auth import current_user, user_has_perm
    u = current_user()
    return jsonify({"p": console_live.paths(lambda perm: not perm or user_has_perm(u, perm))}), 200


@console_api_bp.route("/reddit-status", methods=["GET"])
@login_required
@live("rstatus", "/reddit-status", ttl=20)
def reddit_status():
    """Whether Reddit is currently refusing the bot (written by the bot, services/reddit_gate). While
    `down` is true the console shows its Reddit sections as on maintenance; it is part of /poll, so the
    sections come back by themselves once the bot's hourly check succeeds."""
    doc = (M.sync_db["console_config"].find_one({"key": "reddit_status"}) or {}).get("value") or {}
    return jsonify({"down": bool(doc.get("down")), "since": doc.get("since") or "",
                    "checked_at": doc.get("checked_at") or "", "next_check_at": doc.get("next_check_at") or ""}), 200


@console_api_bp.route("/app-config", methods=["GET"])
@login_required
def app_config():
    # Small client config. discord_guild_id lets the console build "Open in Discord" links
    # (https://discord.com/channels/<guild>/<channel_id>) from a ticket's channel_id.
    # facebook_group_url powers the "Open Facebook group" button on the Facebook Notes page (W7).
    return jsonify({
        "discord_guild_id": os.getenv("DISCORD_GUILD_ID", ""),
        "facebook_group_url": os.getenv("FACEBOOK_GROUP_URL", ""),
    }), 200


@console_api_bp.route("/discord-tickets", methods=["GET"])
@perm_required("discord")
@live("tickets", "/discord-tickets", perm="discord", query="status=active&limit=3000", ttl=6)
def discord_tickets():
    # Light list: drop the heavy conversation_html + messages_history. Fetch a single
    # ticket's full transcript via /discord-tickets/<mongo _id>.
    # ?status=active (open+in_progress) | closed | all(default); ?skip= & ?limit= for the
    # closed archive (paged on demand so the initial load stays bounded).
    status = request.args.get("status")
    try:
        skip = max(0, int(request.args.get("skip", 0)))
        limit = min(3000, max(1, int(request.args.get("limit", 3000))))
    except (TypeError, ValueError):
        skip, limit = 0, 3000
    query = None
    if status == "active":
        query = {"status": {"$in": ["open", "in_progress"]}}
    elif status == "closed":
        query = {"status": "closed"}
    # ?user_id= : the whole ticket history of one Discord user (open + closed), for Profile 360.
    uid = (request.args.get("user_id") or "").strip()
    if uid:
        if not uid.isdigit():
            return jsonify([]), 200
        ids = [uid]
        try:
            ids.append(int(uid))
        except ValueError:
            pass
        query = dict(query or {}, user_id={"$in": ids})
    # ?q= : Archive search across ALL tickets of that status (the archive itself is paged): user name,
    # "#123" ticket number or a numeric Discord user ID.
    qs = (request.args.get("q") or "").strip()[:80]
    if qs:
        ors = [{"user_name": {"$regex": re.escape(qs), "$options": "i"}},
               {"metadata.description": {"$regex": re.escape(qs), "$options": "i"}}]
        num = qs.lstrip("#")
        if num.isdigit():
            ors += [{"ticket_number": int(num)}, {"user_id": num}]
            try:
                ors.append({"user_id": int(num)})
            except ValueError:
                pass
        query = {"$and": [query or {}, {"$or": ors}]}
    return jsonify(_find(
        M.sync_discord_tickets_collection,
        query=query, limit=limit, skip=skip,
        sort=("created_at", -1),
        exclude={"conversation_html": 0, "messages_history": 0},
    )), 200


@console_api_bp.route("/discord-tickets/<ticket_id>", methods=["GET"])
@perm_required("discord")
def discord_ticket_detail(ticket_id):
    from bson.errors import InvalidId
    try:
        oid = ObjectId(ticket_id)
    except (InvalidId, Exception):
        return jsonify({"error": "Bad id"}), 400
    doc = M.sync_discord_tickets_collection.find_one({"_id": oid})
    if not doc:
        return jsonify({"error": "Not found"}), 404
    return jsonify(_clean(doc)), 200


@console_api_bp.route("/discord-forum", methods=["GET"])
@perm_required("discord")
@live("forum", "/discord-forum", perm="discord", ttl=6)
def discord_forum():
    # Discord forum posts (Forum tab), newest first.
    return jsonify(_find(M.sync_db["discord_forum_posts"], sort=("ts", -1), limit=1000)), 200


@console_api_bp.route("/forum-status", methods=["GET"])
@perm_required("discord")
@live("fstatus", "/forum-status", perm="discord", ttl=6)
def forum_status():
    # Console-side Replied/Ignored triage per forum post (merged onto the list on the frontend).
    out = {}
    for d in M.sync_db["console_forum_status"].find({}):
        out[d.get("forum_id", "")] = d.get("status", "")
    return jsonify(out), 200


@console_api_bp.route("/discord-mentions", methods=["GET"])
@perm_required("discord")
@live("mentions", "/discord-mentions", perm="discord", ttl=6)
def discord_mentions():
    # Moderator mentions (Mentions tab), newest first.
    return jsonify(_find(M.sync_db["discord_mentions"], sort=("ts", -1), limit=1000)), 200


@console_api_bp.route("/telegram-messages", methods=["GET"])
@perm_required("telegram")
@live("tg", "/telegram-messages", perm="telegram", ttl=6)
def telegram_messages():
    # Telegram user messages (Telegram tab), newest first.
    return jsonify(_find(M.sync_db["telegram_messages"], sort=("ts", -1), limit=1000)), 200


@console_api_bp.route("/forums-config", methods=["GET"])
@login_required
def forums_config_get():
    # Discord forum channel -> category map (Admin > Discord forums).
    doc = M.sync_db["console_config"].find_one({"key": "discord_forums"}) or {}
    return jsonify(doc.get("value") or {}), 200


@console_api_bp.route("/reminders-config", methods=["GET"])
@login_required
def reminders_config_get():
    # SLA reminders config (Admin > Reminders).
    doc = M.sync_db["console_config"].find_one({"key": "reminders"}) or {}
    return jsonify(doc.get("value") or {}), 200


@console_api_bp.route("/known-issues", methods=["GET"])
@login_required
@live("known", "/known-issues", ttl=20)
def known_issues_get():
    # The Google-Sheet mirror (Admin > Known issues), one doc per category (games/apps/session/account).
    from services import ki_shots, r2_store
    out = {}
    synced = ""
    smap = ki_shots.shots_map(M.sync_db)   # screenshots (R2 URLs) bound to rows by category+entity+problem
    for d in M.sync_db["known_issues"].find({}):
        cat = d.get("category") or d.get("_id")
        out[cat] = {"has_entity": bool(d.get("has_entity")), "rows": ki_shots.attach(cat, d.get("rows") or [], smap)}
        if d.get("synced_at"):
            synced = d["synced_at"]
    return jsonify({"categories": out, "synced_at": synced, "shots_enabled": r2_store.configured()}), 200


@console_api_bp.route("/known-issues-config", methods=["GET"])
@login_required
def known_issues_config_get():
    doc = M.sync_db["console_config"].find_one({"key": "known_issues"}) or {}
    return jsonify(doc.get("value") or {}), 200


def _game_ids_by_title(db):
    """Map a Known Issues game entity -> [Game-List IDs], keyed by game_match_key ("base|launcher"). A
    launcher-tagged entity ("Foo (Xbox)") resolves ONLY to the Xbox row of that game (Platform column);
    a plain entity ("Foo") resolves to every platform's ID. Limited to games that have an issue and
    indexed on `norm`, so no full-catalog scan. The frontend looks up with the same gameMatchKey()."""
    from services.game_title import norm_game_title, split_launcher, game_match_key
    doc = db["known_issues"].find_one({"_id": "games"}) or {}
    entities, bases = [], set()
    for r in (doc.get("rows") or []):
        e = (r.get("entity") or "").strip()
        if not e:
            continue
        entities.append(e)
        bases.add(split_launcher(e)[0])
    if not bases:
        return {}
    # base title -> [(id, platform)]
    gl = {}
    for g in db["game_list"].find({"norm": {"$in": list(bases)}}, {"id": 1, "title": 1, "norm": 1, "platform": 1}):
        b = g.get("norm") or norm_game_title(g.get("title"))
        gl.setdefault(b, []).append((str(g.get("id")), str(g.get("platform") or "").strip().lower()))
    if not gl:   # transition: collection not yet re-synced with `norm`/`platform` -> one-time scan fallback
        for g in db["game_list"].find({}, {"id": 1, "title": 1, "platform": 1}):
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
                ids = [gid for (gid, plat) in cands]   # platform column not synced yet -> title-only
        else:
            ids = [gid for (gid, plat) in cands]
        if ids:
            out[game_match_key(e)] = ids
    return out


def _game_ids_for_names(db, names):
    """Game-List ID for each Related Apps name, {name: id or ""}. "Foo (Xbox)" -> the Xbox row; a plain
    "Foo" -> the Steam row (or a row without platform), else the first row of that title."""
    from services.game_title import split_launcher
    want = {}
    for n in names:
        n = str(n or "").strip()
        if n:
            want[n] = split_launcher(n)
    out = {n: "" for n in want}
    if not want:
        return out
    gl = {}
    for g in db["game_list"].find({"norm": {"$in": list({b for b, _l in want.values()})}},
                                  {"id": 1, "norm": 1, "platform": 1}):
        gl.setdefault(g.get("norm") or "", []).append((str(g.get("id") or ""), str(g.get("platform") or "").strip().lower()))
    for n, (b, launcher) in want.items():
        cands = [c for c in gl.get(b, []) if c[0]]
        if not cands:
            continue
        if launcher:
            hit = [gid for gid, plat in cands if plat == launcher]
        else:
            hit = [gid for gid, plat in cands if plat == "steam"] or [gid for gid, plat in cands if not plat]
        out[n] = (hit or [cands[0][0]])[0] if (hit or not launcher) else ""
    return out


@console_api_bp.route("/game-cards-related-ids", methods=["POST"])
@perm_required("gamecards")
def game_cards_related_ids():
    """IDs under a card's Related Apps field: {names: [...]} -> {ids: {name: id or ""}}."""
    names = (request.get_json(silent=True) or {}).get("names") or []
    if not isinstance(names, list):
        return jsonify({"error": "names must be a list"}), 400
    return jsonify({"ids": _game_ids_for_names(M.sync_db, names[:40])}), 200   # the console sends 40 per request


@console_api_bp.route("/game-list", methods=["GET"])
@login_required
def game_list_get():
    # Title -> Game-List ID(s), only for games that have a known issue (used to badge game tiles).
    return jsonify({"by_title": _game_ids_by_title(M.sync_db)}), 200


@console_api_bp.route("/game-list-config", methods=["GET"])
@admin_required
def game_list_config_get():
    doc = M.sync_db["console_config"].find_one({"key": "game_list"}) or {}
    return jsonify(doc.get("value") or {}), 200


@console_api_bp.route("/known-issues-suggestions", methods=["GET"])
@admin_required
def known_issues_suggestions_get():
    # Pending user suggestions awaiting admin approval (Admin > Known issues).
    docs = list(M.sync_db["known_issues_suggestions"].find({}, {"upload_token": 0, "upload_until": 0}).sort("created_at", 1))
    for d in docs:
        d["shots"] = [{"id": x.get("id"), "url": "/api/console/known-issues-suggestions/shot/" + str(x.get("id"))}
                      for x in (d.get("shots") or []) if x.get("id")]
    return jsonify(_clean(docs)), 200


@console_api_bp.route("/schedule", methods=["GET"])
@perm_required("schedule")
@live("schedule", "/schedule", perm="schedule", ttl=20)
def schedule_get():
    # The team schedule mirror (one doc per month), ordered as in the sheet.
    docs = list(M.sync_db["team_schedule"].find({}).sort("order_index", 1))
    synced = docs[-1].get("synced_at", "") if docs else ""
    months = [{"month": d.get("month") or d.get("_id"), "members": d.get("members") or [], "days": d.get("days") or []}
              for d in docs]
    return jsonify({"months": months, "synced_at": synced}), 200


@console_api_bp.route("/schedule-config", methods=["GET"])
@perm_required("schedule")
def schedule_config_get():
    doc = M.sync_db["console_config"].find_one({"key": "schedule"}) or {}
    return jsonify(doc.get("value") or {}), 200


@console_api_bp.route("/game-cards", methods=["GET"])
@perm_required("gamecards")
@live("gamecards", "/game-cards", perm="gamecards", ttl=20)
def game_cards_get():
    docs = list(M.sync_db["game_cards"].find({}).sort("order_index", 1))
    synced = docs[-1].get("synced_at", "") if docs else ""
    weeks = [{"week": d.get("week") or d.get("_id"), "rows": d.get("rows") or []} for d in docs]
    from services import blob_store
    img_keys = blob_store.list_blob_ids("game_card_images")   # blobs live on the separate blob store now
    meta = {m["key"]: {"section": m.get("section") or "", "platform": m.get("platform") or ""}
            for m in M.sync_db["game_card_meta"].find({}, {"_id": 0, "key": 1, "section": 1, "platform": 1})}
    return jsonify({"weeks": weeks, "synced_at": synced, "image_keys": img_keys, "meta": meta,
                    "suggestions": _gc_suggestions(weeks)}), 200


def _gc_norm(name):
    """Comparable title: no (Xbox)/(Epic) suffixes, no trademark signs, lowercase alphanumerics only."""
    name = re.sub(r"\([^)]*\)", " ", name or "")
    name = re.sub("[\u2122\u00ae\u00a9]", "", name)
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


_GC_SUFFIX_PLATFORM = {"xbox": "Xbox", "epic": "Epic", "ubisoft": "Ubisoft", "ea": "EA",
                       "battle.net": "Battle.net", "rockstar": "Rockstar", "steam": "Steam"}


def _gc_plat(p):
    """Comparable platform: "Epic Games" == "Epic", "EA app" == "EA"."""
    p = str(p or "").strip().lower()
    return {"epic games": "epic", "ea app": "ea", "battlenet": "battle.net"}.get(p, p)


def _gc_suggestions(weeks):
    """New game cards that went live this week (Mattermost "NEW! Game ... becoming alive" events, Monday
    00:00 Kyiv onwards) that do not have a card yet. Platform is guessed from the "(Xbox)" style suffix."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo
    kyiv = ZoneInfo("Europe/Kyiv")
    now = datetime.now(kyiv)
    monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    since = monday.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
    # A card counts per platform: last week's "Football Manager 27" Xbox card must not hide this week's
    # Steam one. A card without a platform still blocks the title on every platform (old behaviour).
    have, have_any = set(), set()
    for w in weeks:
        for r in (w.get("rows") or []):
            t = _gc_norm(r.get("title"))
            p = _gc_plat(r.get("platform"))
            if t:
                (have.add((t, p)) if p else have_any.add(t))
    used = {m.get("source") for m in M.sync_db["game_card_meta"].find({"source": {"$nin": [None, ""]}}, {"source": 1})}
    out, seen = [], set()
    for ev in M.sync_db["mm_events"].find({"category": "game_card", "created_at": {"$gte": since}},
                                          {"_id": 0, "post_id": 1, "game": 1, "created_at": 1}).sort("created_at", -1):
        game = ev.get("game") or ""
        key = _gc_norm(game)
        m = re.search(r"\(([^)]*)\)\s*$", game)
        platform = _GC_SUFFIX_PLATFORM.get((m.group(1) if m else "").strip().lower(), "Steam")
        pkey = (key, _gc_plat(platform))
        if not key or key in have_any or pkey in have or pkey in seen or ev.get("post_id") in used:
            continue
        seen.add(pkey)
        out.append({"source": ev.get("post_id"), "game": game, "search": re.sub(r"\s*\([^)]*\)\s*", " ", game).strip(),
                    "platform": platform, "created_at": ev.get("created_at")})
    return _clean(out)


@console_api_bp.route("/game-cards-steam-search", methods=["GET"])
@perm_required("gamecards")
def game_cards_steam_search():
    """Steam store search for one game title. `exact` = same title after normalising; the console takes
    a single exact hit automatically and otherwise lets the operator pick from the list."""
    term = (request.args.get("q") or "").strip()
    if not term:
        return jsonify([]), 200
    want = _gc_norm(term)
    # Search Steam with the title as written: the normalised form breaks names with an apostrophe
    # ("John Carpenter's" -> "john carpenter s"), and Steam then returns only the DLC / soundtrack.
    # The normalised form is a second try only when the plain title does not find the game itself.
    raw = re.sub("[™®©]", "", re.sub(r"\s*\([^)]*\)\s*$", "", term)).strip()
    out, ids, err = [], set(), None
    for q in [x for x in dict.fromkeys([raw, want]) if x]:
        try:
            r = requests.get("https://store.steampowered.com/api/storesearch/",
                             params={"term": q, "cc": "US", "l": "en"},
                             headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
            items = r.json().get("items", []) if r.status_code == 200 else []
        except Exception as e:
            err, items = e, []
        for it in items[:8]:
            if it.get("type", "app") != "app" or str(it.get("id")) in ids:
                continue
            ids.add(str(it["id"]))
            out.append({"app_id": str(it["id"]), "name": it.get("name", ""),
                        "url": "https://store.steampowered.com/app/%s/" % it["id"],
                        "exact": _gc_norm(it.get("name", "")) == want,
                        "img": it.get("tiny_image") or ""})
        if any(x["exact"] for x in out):
            break
    if not out and err is not None:
        return jsonify({"error": "Steam search failed: %s" % err}), 502
    out.sort(key=lambda x: not x["exact"])   # the game itself before its DLC / soundtrack (stable sort)
    return jsonify(out[:8]), 200


@console_api_bp.route("/game-cards-config", methods=["GET"])
@perm_required("gamecards")
def game_cards_config_get():
    doc = M.sync_db["console_config"].find_one({"key": "game_cards"}) or {}
    return jsonify(doc.get("value") or {}), 200


@console_api_bp.route("/game-testing", methods=["GET"])
@perm_required("gamecards")
def game_testing_get():
    docs = list(M.sync_db["game_testing"].find({}).sort("order_index", 1))
    synced = max([d.get("synced_at", "") for d in docs] or [""])
    tabs = [{"week": d.get("week") or d.get("_id"), "week_label": d.get("week_label") or d.get("week") or d.get("_id"),
             "columns": d.get("columns") or [], "rows": d.get("rows") or []} for d in docs]
    return jsonify({"tabs": tabs, "synced_at": synced}), 200


@console_api_bp.route("/game-testing-config", methods=["GET"])
@perm_required("gamecards")
def game_testing_config_get():
    doc = M.sync_db["console_config"].find_one({"key": "game_testing"}) or {}
    return jsonify(doc.get("value") or {}), 200


@console_api_bp.route("/maintenance-sheet-config", methods=["GET"])
@login_required
def maintenance_sheet_config_get():
    doc = M.sync_db["console_config"].find_one({"key": "maintenance_sheet"}) or {}
    return jsonify(doc.get("value") or {}), 200


@console_api_bp.route("/game-cards-image", methods=["GET"])
@perm_required("gamecards")
def game_cards_image():
    # Serve the screenshots ZIP the bot stashed for a generated card (Download images button).
    import base64
    from services import blob_store
    week = (request.args.get("week") or "").strip()
    title = (request.args.get("title") or "").strip()
    doc = blob_store.read_blob("game_card_images", "%s||%s" % (week, title.lower()))
    if not doc or not doc.get("zip_b64"):
        return jsonify({"error": "no images for this card"}), 404
    try:
        data = base64.b64decode(doc["zip_b64"])
    except Exception:
        return jsonify({"error": "bad image data"}), 500
    fname = re.sub(r'[\x00-\x1f\x7f"\\]+', " ", title or "screenshots")[:80].strip() + "_screenshots.zip"
    # HTTP headers are latin-1: a title with an emoji ("Finals Week ✍️") broke the response and the
    # browser saved nothing. ASCII fallback name + the real name in RFC 5987 form.
    ascii_name = re.sub(r"\s+", " ", fname.encode("ascii", "ignore").decode()).replace(" _", "_").strip()
    if not ascii_name or ascii_name.startswith("_"):
        ascii_name = "screenshots" + ascii_name if ascii_name else "screenshots.zip"
    return Response(data, mimetype="application/zip",
                    headers={"Content-Disposition": "attachment; filename=\"%s\"; filename*=UTF-8''%s"
                             % (ascii_name, quote(fname, safe=""))})


@console_api_bp.route("/telegram-image", methods=["GET"])
@perm_required("telegram")
def telegram_image():
    # Serve a photo the bot stashed for a Telegram message (Telegram file URLs are token-scoped + expire,
    # so the bot downloads the image and stores it; the console serves it here).
    import base64
    from services import blob_store
    mid = (request.args.get("id") or "").strip()
    doc = blob_store.read_blob("telegram_images", mid) if mid else None
    if not doc or not doc.get("b64"):
        return jsonify({"error": "no image"}), 404
    try:
        data = base64.b64decode(doc["b64"])
    except Exception:
        return jsonify({"error": "bad image data"}), 500
    return Response(data, mimetype=doc.get("mime", "image/jpeg"),
                    headers={"Cache-Control": "private, max-age=86400"})


def _cm_awaiting_map(base, headers, ours):
    """For tickets in "CM In Progress", return {issue_key: awaiting} where awaiting is True when NONE
    of the comments is authored by one of OUR Jira users - i.e. the CM team hasn't replied yet. One
    targeted JQL search (the CM queue is small), so it costs almost nothing on top of the main scan.
    The console uses this so Monitor shows only newly-arrived / not-yet-answered CM handoffs."""
    out = {}
    if not ours:
        return out
    try:
        params = {"jql": 'project = %s AND status = "CM In Progress"' % _JIRA_PROJECT,
                  "fields": "comment", "maxResults": 100}
        token, pages = None, 0
        while True:
            if token:
                params["nextPageToken"] = token
            r = requests.get(base + "/rest/api/3/search/jql", params=params, headers=headers, timeout=25)
            if r.status_code != 200:
                break
            data = r.json() or {}
            for issue in data.get("issues", []):
                key = issue.get("key", "")
                comments = ((issue.get("fields") or {}).get("comment") or {}).get("comments") or []
                replied = any(
                    (c.get("author") or {}).get("accountId") in ours
                    or (c.get("author") or {}).get("displayName") in ours
                    for c in comments
                )
                out[key] = not replied
            token = data.get("nextPageToken")
            pages += 1
            if data.get("isLast") or not token or pages >= 10:
                break
    except Exception as e:
        logger.error("[Console] CM-awaiting scan failed: %s", e)
    return out


def _scan_jira_team():
    """Scan the whole project (paged) for OUR tickets - comm link = Facebook/Reddit/Discord.
    Returns (issues, error); issues is None only when Jira isn't configured. This is the
    expensive part, so it runs on demand (POST /jira-sync), not on every page load."""
    base, email, token = _jira_env()
    if not (base and email and token):
        return None, "unconfigured"
    headers = _jira_headers(email, token)
    jql = 'project = %s ORDER BY updated DESC' % _JIRA_PROJECT
    try:   # our Jira accounts = the Jira account id in each member's profile Identity
        ours = {u["jira_account_id"] for u in M.sync_db["console_users"].find(
            {"jira_account_id": {"$nin": [None, ""]}}, {"jira_account_id": 1})}
    except Exception as e:
        logger.warning("[Console] could not read the team's Jira accounts: %s", e)
        ours = set()
    out, page_token, pages = [], None, 0
    try:
        while True:
            params = {"jql": jql, "fields": "key,summary,status,reporter,updated," + _JIRA_COMM_FIELD, "maxResults": 100}
            if page_token:
                params["nextPageToken"] = page_token
            r = requests.get(base + "/rest/api/3/search/jql", params=params, headers=headers, timeout=25)
            if r.status_code != 200:
                return out, "jira %s" % r.status_code
            data = r.json() or {}
            for issue in data.get("issues", []):
                f = issue.get("fields", {}) or {}
                comm = _comm_link_str(f.get(_JIRA_COMM_FIELD))
                rep = f.get("reporter") or {}
                # Ours if the comm link is FB/Reddit/Discord OR the reporter is one of our Jira users.
                is_team = bool(_TEAM_COMM_RE.search(comm))
                if not is_team and ours and (rep.get("accountId") in ours or rep.get("displayName") in ours):
                    is_team = True
                if not is_team:
                    continue
                key = issue.get("key", "")
                out.append({
                    "issue_key": key,
                    "summary": f.get("summary", "") or "",
                    "status": (f.get("status") or {}).get("name", ""),
                    "url": base + "/browse/" + key,
                    "communication_link": comm,
                    "reporter": rep.get("displayName", ""),
                    "reporter_id": rep.get("accountId", ""),
                    "status_since": f.get("updated", ""),
                })
            page_token = data.get("nextPageToken")
            pages += 1
            if data.get("isLast") or not page_token or pages >= 30:
                break
        # Annotate CM In Progress tickets with whether our team has replied yet (for Monitor).
        awaiting = _cm_awaiting_map(base, headers, ours)
        for it in out:
            if it["status"] == "CM In Progress":
                it["cm_awaiting_reply"] = bool(awaiting.get(it["issue_key"], True))
        return out, None
    except Exception as e:
        logger.error("[Console] jira scan failed: %s", e)
        return out, "fetch failed"


def _adf_text(node):
    """Plain text from a Jira v3 (ADF) body."""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_adf_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    t = node.get("type")
    if t == "text":
        return node.get("text", "")
    if t in ("mention", "emoji"):
        return (node.get("attrs") or {}).get("text", "")
    if t == "hardBreak":
        return chr(10)
    inner = _adf_text(node.get("content") or [])
    return inner + (chr(10) if t in ("paragraph", "heading", "listItem") else "")


def _is_system_comment(c):
    """Jira automation / app accounts and our own [System] notes are not a person's comment."""
    a = c.get("author") or {}
    name = (a.get("displayName") or "").lower()
    if a.get("accountType") == "app" or "automation" in name or not name:
        return True
    return _adf_text(c.get("body")).strip().startswith("[System]")


@console_api_bp.route("/jira-brief", methods=["GET"])
@login_required
def jira_brief():
    """Short facts for the chat side panel's linked tickets, one Jira call for all keys: the real title,
    the URG result (Fixed / Disabled / ...) and the last comment written by a person (system/automation
    comments skipped). ?keys=SO-1,URG-2 (max 20). Cached 60s per key set."""
    keys = [k.strip().upper() for k in (request.args.get("keys") or "").split(",") if _JIRA_KEY_RE.match(k.strip() or "")][:20]
    if not keys:
        return jsonify({"items": {}}), 200
    ck = "jira_brief:" + ",".join(sorted(keys))
    cached = _cache_get(ck)
    if cached is not None:
        return jsonify(cached), 200
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"items": {}, "configured": False}), 200
    out = {}
    try:
        r = requests.get(base + "/rest/api/3/search/jql",
                         params={"jql": "key in (%s)" % ",".join(keys), "fields": "summary,comment,status," + _JIRA_URG_UPDATE_RESULT,
                                 "maxResults": len(keys)},
                         headers=_jira_headers(email, token), timeout=20)
        if r.status_code == 200:
            for it in (r.json() or {}).get("issues") or []:
                f = it.get("fields") or {}
                ur = f.get(_JIRA_URG_UPDATE_RESULT)
                if isinstance(ur, dict):
                    ur = ur.get("value") or _URG_UPDATE_RESULT_BY_ID.get(str(ur.get("id") or ""), "")
                comments = [c for c in ((f.get("comment") or {}).get("comments") or []) if not _is_system_comment(c)]
                last = comments[-1] if comments else None
                out[it.get("key")] = {
                    "summary": f.get("summary") or "",
                    "status": ((f.get("status") or {}).get("name") or ""),
                    "update_result": ur or "",
                    "last_comment": ({"author": (last.get("author") or {}).get("displayName", ""),
                                      "body": _adf_text(last.get("body")).strip()[:300],
                                      "created": last.get("created", "")} if last else None),
                }
    except Exception as e:
        logger.warning("[Console] jira-brief failed: %s", e)
    return jsonify(_cache_put(ck, {"items": out}, 60)), 200


@console_api_bp.route("/jira-cache", methods=["GET"])
@perm_required("jira")
@live("jira", "/jira-cache", perm="jira", ttl=6)
def jira_cache():
    # Fast: the locally-stored lightweight ticket list (key/summary/status/user link). Full
    # description + comments load per-ticket on open via /jira-issue/<key>. Refresh via /jira-sync.
    # The console re-pulls this list on every hydrate AND every background refresh, but it changes only
    # when the bot records a Jira transition or an operator hits Sync - so serve it from a short cache to
    # keep the slow main cluster out of the refresh hot path. /jira-sync busts the cache immediately.
    cached = _cache_get("jira_cache")
    if cached is not None:
        return jsonify(cached), 200
    from services import jira_store
    col = M.sync_db[jira_store.COLLECTION]
    docs = [jira_store.to_console(d) for d in col.find({"console": True}, {"_id": 0}).sort("jira_updated", -1).limit(8000)]
    # Latest sync time across the cache, so the Jira tab can show "Synced <ago>".
    meta = col.find_one({"console": True, "synced_at": {"$exists": True}}, {"_id": 0, "synced_at": 1}, sort=[("synced_at", -1)])
    return jsonify(_cache_put("jira_cache", {"issues": docs, "synced_at": (meta or {}).get("synced_at", "")}, 25)), 200


@console_api_bp.route("/jira-sync", methods=["POST"])
@perm_required("jira")
def jira_sync():
    # On-demand: scan Jira and upsert the lightweight records (cumulative - old tickets stay cached).
    issues, err = _scan_jira_team()
    if issues is None:
        return jsonify({"configured": False, "synced": 0, "issues": []}), 200
    from services import jira_store
    col = M.sync_db[jira_store.COLLECTION]
    now = datetime.utcnow().isoformat()
    for it in issues:
        col.update_one({"issue_key": it["issue_key"]}, {"$set": jira_store.from_console(dict(it, synced_at=now))}, upsert=True)
    _cache_bust("jira_cache")   # a manual Sync must show up immediately, not after the cache TTL
    return jsonify({"configured": True, "synced": len(issues), "error": err, "issues": issues, "synced_at": now}), 200


@console_api_bp.route("/jira-issue/<key>", methods=["GET"])
@perm_required("jira")
def jira_issue(key):
    # Live proxy: description + comments come from the Jira REST API (not Mongo).
    # Needs JIRA_BASE_URL / JIRA_API_EMAIL / JIRA_API_TOKEN in the environment.
    if not _JIRA_KEY_RE.match(key or ""):
        return jsonify({"error": "bad key"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False, "descriptionHtml": "", "comments": []}), 200
    headers = _jira_headers(email, token)
    try:
        # renderedFields = Jira's own HTML (links clickable, images as <img>); we proxy the images.
        # We ALSO return the raw source (summary/description/comment bodies) so the console can EDIT them.
        fields_param = "summary,description,comment,%s,%s" % (_JIRA_COMM_FIELD, _JIRA_L1_FIELD)
        r = requests.get(base + "/rest/api/2/issue/" + key,
                         params={"fields": fields_param, "expand": "renderedFields"},
                         headers=headers, timeout=15)
        if r.status_code != 200:
            return jsonify({"configured": True, "error": "jira %s" % r.status_code,
                            "descriptionHtml": "", "comments": []}), 200
        j = r.json() or {}
        rendered = j.get("renderedFields") or {}
        fields = j.get("fields") or {}
        desc_html = _rewrite_jira_html(rendered.get("description") or "", base)
        my_id = _my_account_id(base, headers)
        # Pair rendered comment bodies (HTML) with author/created + RAW body (for editing) from the raw list.
        raw_comments = (fields.get("comment") or {}).get("comments") or []
        rendered_comments = (rendered.get("comment") or {}).get("comments") or []
        comments = []
        for i, c in enumerate(raw_comments):
            body_html = rendered_comments[i].get("body") if i < len(rendered_comments) else c.get("body")
            author = c.get("author") or {}
            aid = author.get("accountId", "")
            comments.append({
                "id": c.get("id", ""),
                "author": author.get("displayName", ""),
                "authorId": aid,
                "editable": bool(my_id) and aid == my_id,  # only comments left through the bot are editable here
                "body": _rewrite_jira_html(body_html or "", base),
                "bodyRaw": c.get("body", "") or "",
                "created": c.get("created", ""),
                "updated": c.get("updated", ""),
            })
        return jsonify({
            "configured": True, "key": key,
            "summary": fields.get("summary", "") or "",
            "descriptionHtml": desc_html,
            "descriptionRaw": fields.get("description", "") or "",
            "communication_link": _comm_link_str(fields.get(_JIRA_COMM_FIELD)),
            "l1_tags": _read_l1_tags(fields.get(_JIRA_L1_FIELD)),
            "comments": comments,
        }), 200
    except Exception as e:
        logger.error("[Console] jira-issue fetch failed for %s: %s", key, e)
        return jsonify({"configured": True, "error": "fetch failed", "descriptionHtml": "", "comments": []}), 200


@console_api_bp.route("/jira-transitions/<key>", methods=["GET"])
@perm_required("jira")
def jira_transitions(key):
    if not _JIRA_KEY_RE.match(key or ""):
        return jsonify({"error": "bad key"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False, "transitions": []}), 200
    try:
        r = requests.get(base + "/rest/api/2/issue/" + key + "/transitions",
                         headers=_jira_headers(email, token), timeout=15)
        if r.status_code != 200:
            return jsonify({"error": "jira %s" % r.status_code, "transitions": []}), 200
        ts = [{"id": t.get("id"), "name": t.get("name", ""), "to": (t.get("to") or {}).get("name", "")}
              for t in (r.json().get("transitions") or [])]
        return jsonify({"configured": True, "transitions": ts}), 200
    except Exception as e:
        logger.error("[Console] jira-transitions failed: %s", e)
        return jsonify({"error": "fetch failed", "transitions": []}), 200


@console_api_bp.route("/jira-transition", methods=["POST"])
@perm_required("jira")
def jira_transition():
    data = request.get_json(silent=True) or {}
    key, tid = data.get("key", ""), str(data.get("transition_id", ""))
    if not _JIRA_KEY_RE.match(key or "") or not tid:
        return jsonify({"error": "bad params"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False}), 200
    try:
        r = requests.post(base + "/rest/api/2/issue/" + key + "/transitions",
                          json={"transition": {"id": tid}}, headers=_jira_headers(email, token), timeout=15)
        if r.status_code not in (200, 204):
            return jsonify({"ok": False, "error": "jira %s" % r.status_code}), 200
        new_status = ""
        try:
            sr = requests.get(base + "/rest/api/2/issue/" + key + "?fields=status",
                              headers=_jira_headers(email, token), timeout=10)
            if sr.status_code == 200:
                new_status = ((sr.json().get("fields") or {}).get("status") or {}).get("name", "")
        except Exception as _e:
            logger.warning("ignored: %s", _e)
        if new_status:
            M.sync_db["jira_tickets"].update_one({"issue_key": key}, {"$set": {"status": new_status}})
        return jsonify({"ok": True, "status": new_status}), 200
    except Exception as e:
        logger.error("[Console] jira-transition failed: %s", e)
        return jsonify({"ok": False, "error": "failed"}), 200


@console_api_bp.route("/jira-comment", methods=["POST"])
@perm_required("jira")
def jira_comment():
    data = request.get_json(silent=True) or {}
    key, text = data.get("key", ""), (data.get("text") or "").strip()
    if not _JIRA_KEY_RE.match(key or "") or not text:
        return jsonify({"error": "bad params"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False}), 200
    try:
        r = requests.post(base + "/rest/api/2/issue/" + key + "/comment",
                          json={"body": text}, headers=_jira_headers(email, token), timeout=15)
        if r.status_code not in (200, 201):
            return jsonify({"ok": False, "error": "jira %s" % r.status_code}), 200
        return jsonify({"ok": True}), 200
    except Exception as e:
        logger.error("[Console] jira-comment failed: %s", e)
        return jsonify({"ok": False, "error": "failed"}), 200


@console_api_bp.route("/jira-urg-review", methods=["GET"])
@perm_required("jira")
def jira_urg_review():
    """URG tickets currently in the Review column. The console fetches only SO by default, so this is a
    small dedicated scan that feeds the To-Do "transfer from URG" tasks."""
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False, "items": []}), 200
    headers = _jira_headers(email, token)
    out = []
    try:
        params = {"jql": 'project = %s AND status = "%s" ORDER BY updated DESC' % (_JIRA_URG_PROJECT, _JIRA_URG_REVIEW),
                  "fields": "summary,updated,%s,%s" % (_JIRA_COMM_FIELD, _JIRA_URG_UPDATE_RESULT), "maxResults": 50}
        r = requests.get(base + "/rest/api/3/search/jql", params=params, headers=headers, timeout=25)
        if r.status_code == 200:
            for issue in (r.json() or {}).get("issues", []):
                f = issue.get("fields") or {}
                key = issue.get("key", "")
                comm = f.get(_JIRA_COMM_FIELD)
                if isinstance(comm, dict):
                    comm = comm.get("value") or ""
                # "Update result" (the URG resolution) - a select field: {value, id}. Show the label so
                # the To-Do card can display "Fixed" / "Disabled" / etc. next to the transfer action.
                ur = f.get(_JIRA_URG_UPDATE_RESULT)
                if isinstance(ur, dict):
                    ur = ur.get("value") or _URG_UPDATE_RESULT_BY_ID.get(str(ur.get("id") or ""), "")
                elif not isinstance(ur, str):
                    ur = ""
                # Users to tell: ours only (an L1-bot ticket shows up only for the users WE added), and
                # only those not transferred yet. No user of ours -> no card at all.
                recs = _urg_recipients(base, headers, key)
                # "My Own Ticket" users are closed automatically by the bot at Review - never a card.
                todo = [r for r in recs if r.get("ours") and not r.get("transferred") and not r.get("own")]
                if not todo:
                    continue
                out.append({"key": key, "summary": f.get("summary", ""), "url": base + "/browse/" + key,
                            "updated": f.get("updated", ""), "communication_link": comm or "",
                            "update_result": ur or "",
                            "recipients": [{"rid": r["rid"], "email": r.get("email", ""), "link": r.get("link", "")} for r in todo],
                            "recipients_total": len([r for r in recs if r.get("ours")])})
    except Exception as e:
        logger.error("[Console] jira-urg-review scan failed: %s", e)
    return jsonify({"configured": True, "items": out}), 200


# --- URG recipients (same rules as the bot's services/urg_recipients.py; shared collection) ---
_URG_UID_RE = re.compile(r"User\s*ID\W{0,3}(\d{3,12})", re.I)


def _urg_who(text):
    """"User ID N" written in the ticket text, else "". The console never stores an address here; the
    bot resolves an email-only recipient to its User ID when it refreshes the list."""
    m = _URG_UID_RE.search(str(text or ""))
    return "User ID %s" % m.group(1) if m else ""
_URG_LINK_RE = re.compile(r"Communication link:\s*\[?(https?://[^\s\]|]+)", re.I)
_URG_URL_RE = re.compile(r"https?://[^\s\]|]+")
_URG_OWN_RE = re.compile(r"own ticket:\s*community manager", re.I)   # "My Own Ticket" marker (bot ticket_create)


def _urg_our_ids(base, headers):
    ids = set()
    try:
        for u in M.sync_db["console_users"].find({"jira_account_id": {"$nin": [None, ""]}}, {"jira_account_id": 1}):
            ids.add(u["jira_account_id"])
    except Exception as _e:
        logger.warning("ignored: %s", _e)
    me = _jira_my_account_id(base, headers)
    if me:
        ids.add(me)
    return ids


def _urg_recipients(base, headers, key):
    """Stored recipients of a URG ticket; read from Jira and stored the first time the console sees it."""
    col = M.sync_db["urg_recipients"]
    docs = list(col.find({"key": key}).sort("order", 1))
    if docs:
        return docs
    try:
        r = requests.get(base + "/rest/api/2/issue/" + key, params={"fields": "description,reporter,%s" % _JIRA_COMM_FIELD},
                         headers=headers, timeout=15)
        f = (r.json() or {}).get("fields", {}) if r.status_code == 200 else {}
        rc = requests.get(base + "/rest/api/2/issue/" + key + "/comment", params={"maxResults": 200}, headers=headers, timeout=15)
        comments = (rc.json() or {}).get("comments", []) if rc.status_code == 200 else []
    except Exception as e:
        logger.warning("[Console] URG recipients fetch failed for %s: %s", key, e)
        return []
    ours = _urg_our_ids(base, headers)
    comm = f.get(_JIRA_COMM_FIELD)
    comm = (comm.get("value") or "") if isinstance(comm, dict) else str(comm or "")
    lm = _URG_URL_RE.search(comm)
    recs = [{"rid": "main", "email": _urg_who(f.get("description")), "link": lm.group(0) if lm else comm,
             "ours": ((f.get("reporter") or {}).get("accountId") or "") in ours,
             "own": bool(_URG_OWN_RE.search(str(f.get("description") or "")))}]
    for c in comments:
        body = str(c.get("body") or "")
        if not re.match(r"^\W*additional user", body.strip(), re.I):
            continue
        lk = _URG_LINK_RE.search(body)
        recs.append({"rid": "c%s" % c.get("id"), "email": _urg_who(body), "link": lk.group(1) if lk else "",
                     "ours": ((c.get("author") or {}).get("accountId") or "") in ours,
                     "own": bool(_URG_OWN_RE.search(body))})
    # a ticket our bot raised (creator stored) whose reporter is not mapped: at least the main user is ours
    if not any(x["ours"] for x in recs) and (M.sync_db["jira_tickets"].find_one({"issue_key": key}) or {}).get("creator_slack_id"):
        recs[0]["ours"] = True
    for i, x in enumerate(recs):
        col.update_one({"_id": "%s|%s" % (key, x["rid"])},
                       {"$set": {"key": key, "rid": x["rid"], "email": x["email"], "link": x["link"], "order": i, "ours": x["ours"],
                                 "own": x.get("own", False)},
                        "$setOnInsert": {"transferred": False}}, upsert=True)
    return list(col.find({"key": key}).sort("order", 1))


def _jira_my_account_id(base, headers):
    """accountId of the Jira account the console posts as (JIRA_API_EMAIL's token)."""
    try:
        r = requests.get(base + "/rest/api/2/myself", headers=headers, timeout=10)
        if r.status_code == 200:
            return (r.json() or {}).get("accountId")
    except Exception as _e:
        logger.warning("ignored: %s", _e)
    return None


def _jira_last_comment(base, key, headers):
    """Newest comment on an issue, or None. orderBy=-created puts the latest first; if an instance
    ignores it we simply don't dedupe (a safe miss, never a false skip)."""
    try:
        r = requests.get(base + "/rest/api/2/issue/" + key + "/comment",
                         params={"orderBy": "-created", "maxResults": 1}, headers=headers, timeout=15)
        if r.status_code == 200:
            comments = (r.json() or {}).get("comments") or []
            if comments:
                return comments[0]
    except Exception as e:
        logger.warning("[Console] jira last-comment fetch failed for %s: %s", key, e)
    return None


def _jira_all_comments(base, key, headers, max_pages=10):
    """Every comment on an issue, oldest first (paged, 100 per request), or None when Jira could not be
    read. Same read path as _jira_last_comment, just the whole list."""
    out, start = [], 0
    try:
        for _ in range(max_pages):
            r = requests.get(base + "/rest/api/2/issue/" + key + "/comment",
                             params={"startAt": start, "maxResults": 100, "orderBy": "created"}, headers=headers, timeout=15)
            if r.status_code != 200:
                logger.warning("[Console] jira comments fetch for %s answered %s", key, r.status_code)
                return None
            d = r.json() or {}
            page = d.get("comments") or []
            out.extend(page)
            start += len(page)
            if not page or start >= int(d.get("total") or 0):
                break
    except Exception as e:
        logger.warning("[Console] jira comments fetch failed for %s: %s", key, e)
        return None
    return out


# Who / which chat a Jira comment points at. Same patterns as the bot's services/jira_l1_followups.py
# (_UID_RE, _SESSION_RE, _DISCORD_RE, _REDDIT_RE) plus console deep links - keep them in step.
_MENTION_RES = (
    ("uid", re.compile(r"(?i)\buser[\s_]*id\b\W{0,4}(\d{3,12})\b")),
    ("session", re.compile(r"\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b")),
    ("discord", re.compile(r"discord(?:app)?\.com/channels/\d+/(\d+)")),
    ("reddit", re.compile(r"\breddit\.com/mail/(?:[a-z]+/)?(\w+)")),
    ("reddit", re.compile(r"#/modmail/(\w+)")),
    ("post", re.compile(r"\breddit\.com/r/[^/\s]+/comments/(\w+)")),
    ("post", re.compile(r"#/posts/(\w+)")),
    ("console-discord", re.compile(r"#/discord/(\w+)")),
)


def _mention_refs(text):
    """{(kind, value)} for every User ID, session ID and chat link in `text`."""
    out = set()
    for kind, rx in _MENTION_RES:
        for v in rx.findall(text or ""):
            out.add((kind, v.lower()))
    return out


@console_api_bp.route("/jira-handled", methods=["GET"])
@perm_required("jira")
@live("jhandled", "/jira-handled", perm="jira", ttl=10)
def jira_handled():
    """'Forwarded' markers for the Jira To-Do: {key: status_since}. Written only by the bot's
    services/jira_todo.py (Slack and console buttons); a task leaves the To-Do until the ticket
    re-enters that status (status_since changes)."""
    col = M.sync_db["console_jira_handled"]
    out = {}
    for d in col.find({}):
        out[d.get("key", "")] = d.get("status_since") or ""
    return jsonify(out), 200


# --- Jira title search for "Link Jira Ticket" (index written by the bot: services/jira_so_index.py) -----
_JIRA_Q_KEY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9]*)?-?(\d{1,7})$")


@console_api_bp.route("/jira-suggest", methods=["GET"])
@login_required
def jira_suggest():
    """Up to 8 tickets for the Link Jira modal. A number / key ("1234", "SO-12") matches ticket keys in
    any status; words match the title of tickets still in Backlog (every word must appear)."""
    q = (request.args.get("q") or "").strip()[:80]
    if len(q) < 2:
        return jsonify({"items": []}), 200
    col = M.sync_db["jira_so_index"]
    m = _JIRA_Q_KEY_RE.match(q.replace(" ", ""))
    if m:
        proj = (m.group(1) or "").upper()
        # Without a project prefix only SO tickets are offered (URG has its own flow); "URG-12" typed in
        # full still finds that ticket.
        flt = {"_id": {"$regex": "^%s-%s" % (re.escape(proj) if proj else re.escape(_JIRA_PROJECT), m.group(2))}}
    else:
        words = [w for w in re.split(r"\s+", q.lower()) if len(w) > 1][:6]
        if not words:
            return jsonify({"items": []}), 200
        flt = {"status": "Backlog", "project": _JIRA_PROJECT,
               "$and": [{"summary_lc": {"$regex": re.escape(w)}} for w in words]}
    base = os.getenv("JIRA_BASE_URL", "").rstrip("/")
    items = []
    try:
        for d in col.find(flt, {"summary": 1, "status": 1}).sort("num", -1).limit(8):
            items.append({"key": d["_id"], "summary": d.get("summary") or "", "status": d.get("status") or "",
                          "url": ("%s/browse/%s" % (base, d["_id"])) if base else ""})
    except Exception as e:
        logger.warning("[Console] jira-suggest failed: %s", e)
    return jsonify({"items": items}), 200


_ADMIN_SESSIONS_URL = ("https://admin.cloud.boosteroid.com/admin/filament/streaming/"
                       "streaming-user-sessions?filters%5Buser_id%5D%5Bvalue%5D=")
_UID_LINE_RE = re.compile(r"(?im)^([ \t]*user[ \t]*id[ \t]*:?[ \t]*)(\d{3,12})[ \t]*$")


def _additional_user_comment(body):
    """A user added to an existing ticket reads like the bot's URG one: an "*Additional user*" header and
    the "User ID: N" line as a link to that user's sessions in the cloud admin (same as the description)."""
    body = _UID_LINE_RE.sub(lambda m: "[User ID %s|%s%s]" % (m.group(2), _ADMIN_SESSIONS_URL, m.group(2)), body)
    if not body.lstrip().lower().startswith("*additional user*"):
        body = "*Additional user*\n" + body
    return body


# --- L1 In Progress follow-ups (written by the bot: services/jira_l1_followups.py) ------------------------
@console_api_bp.route("/jira-link-comment", methods=["POST"])
@login_required
def jira_link_comment():
    """Link Ticket (Quick Actions or a chat): post ONE comment to the ticket in the team's usual format
    (User ID, sessions, optional text, the chat link).

    Before posting, every comment on the ticket is read. When one of them already mentions this user or
    chat (its User ID, a session ID, or the chat link - Discord / ModMail / post - or its console link),
    nothing is posted:
      * the ticket is not linked to this chat yet (`linked` false) -> 200 {skipped: true}; the console
        then only links it (link record, Discord channel note, category move);
      * it is already linked too -> 409, nothing to do.
    Otherwise the comment is posted (same text twice in a row is still never posted)."""
    data = request.get_json(silent=True) or {}
    m = re.search(r"[A-Za-z][A-Za-z0-9]*-\d+", data.get("issue_key") or "")
    key = m.group(0).upper() if m else ""
    body = str(data.get("body") or "").strip()[:20000]
    if not key or not body:
        return jsonify({"error": "issue_key and body are required"}), 400
    body = _additional_user_comment(body)
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"error": "Jira is not configured"}), 503
    headers = dict(_jira_headers(email, token), **{"Content-Type": "application/json"})
    # `refs` = User ID + Session info + chat link + console link only, so the optional free text
    # cannot cause a false "already mentioned"; older clients send no refs -> the whole body.
    ours = _mention_refs(str(data.get("refs") or body)[:20000])
    comments = _jira_all_comments(base, key, headers)
    for c in comments or []:
        hit = _mention_refs(c.get("body") if isinstance(c.get("body"), str) else "") & ours
        if not hit:
            continue
        what = sorted(hit)[0]
        label = {"uid": "User ID %s" % what[1], "session": "session %s" % what[1]}.get(what[0], "this chat's link")
        if data.get("linked"):
            return jsonify({"error": "%s is already linked to this chat and a Jira comment already mentions %s. "
                                     "Nothing was changed." % (key, label)}), 409
        logger.info("[Console] link %s: comment %s already mentions %s, linking without a new comment",
                    key, c.get("id"), label)
        return jsonify({"ok": True, "skipped": True, "mention": label, "comment_id": str(c.get("id") or "")}), 200
    if comments is None:          # full read failed: fall back to the old newest-comment guard
        last = _jira_last_comment(base, key, headers)
    else:
        last = comments[-1] if comments else None
    if last and (last.get("body") or "").strip() == body:
        return jsonify({"ok": True, "duplicate": True}), 200
    try:
        r = requests.post(base + "/rest/api/2/issue/" + key + "/comment", json={"body": body}, headers=headers, timeout=15)
    except requests.RequestException as e:
        return jsonify({"error": "Jira did not answer (%s), try again" % type(e).__name__}), 502
    if r.status_code == 404:
        return jsonify({"error": "Ticket %s not found in Jira" % key}), 404
    if r.status_code not in (200, 201):
        return jsonify({"error": "Jira refused the comment (%s), try again" % r.status_code}), 502
    return jsonify({"ok": True}), 201


@console_api_bp.route("/jira-l1-todo", methods=["GET", "POST"])
@login_required
@live("jl1", "/jira-l1-todo", ttl=10)
def jira_l1_todo():
    """GET -> open entries (one per ticket + user/chat waiting on it). POST {id} -> mark it done.

    Done NEVER touches the ticket's status. When the user was left in one of OUR comments, Done answers
    "Передано" under exactly that comment (mention of its author + a link to the comment; Jira has no
    threaded replies, this is how a reply looks in Jira). Chats found only through a link get no comment.
    If that reply cannot be posted the entry stays open, so nothing is marked done without the answer."""
    col = M.sync_db["jira_l1_todo"]
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        tid = str(data.get("id") or "").strip()
        if not tid or "|" not in tid:
            return jsonify({"error": "bad id"}), 400
        doc = col.find_one({"_id": tid})
        if not doc:
            return jsonify({"error": "not found"}), 404
        replied = False
        if doc.get("comment_id") and not doc.get("replied_at"):
            base, email, token = _jira_env()
            if base and email and token:
                headers = dict(_jira_headers(email, token), **{"Content-Type": "application/json"})
                key = doc.get("issue_key", "")
                link = "%s/browse/%s?focusedCommentId=%s" % (base, key, doc["comment_id"])
                who = ("[~accountId:%s] " % doc["comment_author"]) if doc.get("comment_author") else ""
                body = "%sПередано - [%s|%s]" % (who, doc.get("label") or "user", link)
                last = _jira_last_comment(base, key, headers)
                if last and (last.get("body") or "").strip() == body:
                    replied = True                     # the same answer is already the newest comment
                else:
                    try:
                        r = requests.post(base + "/rest/api/2/issue/" + key + "/comment", json={"body": body},
                                          headers=headers, timeout=15)
                    except requests.RequestException as e:
                        return jsonify({"error": "Jira did not answer (%s), try again" % type(e).__name__}), 502
                    if r.status_code not in (200, 201):
                        return jsonify({"error": "Jira refused the comment (%s), try again" % r.status_code}), 502
                    replied = True
        from api.routes.console_auth import current_user
        u = current_user() or {}
        upd = {"done": True, "done_at": datetime.utcnow(), "done_by": u.get("name") or u.get("email") or ""}
        if replied:
            upd["replied_at"] = datetime.utcnow()
        col.update_one({"_id": tid}, {"$set": upd})
        return jsonify({"ok": True, "replied": replied}), 200
    out = []
    for d in col.find({"done": {"$ne": True}}).sort("entered_at", -1).limit(500):
        at = d.get("entered_at")
        out.append({"id": d["_id"], "issue_key": d.get("issue_key", ""), "summary": d.get("summary", ""),
                    "url": d.get("url", ""), "kind": d.get("kind", ""), "value": str(d.get("value", "")),
                    "label": d.get("label", ""), "added_by": d.get("added_by", ""),
                    "has_comment": bool(d.get("comment_id")),
                    "entered_at": at.isoformat() if hasattr(at, "isoformat") else (at or "")})
    return jsonify(out), 200


@console_api_bp.route("/jira-dismissed", methods=["GET"])
@perm_required("jira")
@live("jdismissed", "/jira-dismissed", perm="jira", ttl=10)
def jira_dismissed():
    """'Dismissed' markers for the Jira To-Do: {key: status_since}. Written only by the bot's
    services/jira_todo.py (Slack and console Dismiss): the card is hidden, without any Jira change, until
    the ticket re-enters that status."""
    col = M.sync_db["console_jira_dismissed"]
    out = {}
    for d in col.find({}):
        out[d.get("key", "")] = d.get("status_since") or ""
    return jsonify(out), 200


@console_api_bp.route("/jira-issue-edit", methods=["POST"])
@perm_required("jira")
def jira_issue_edit():
    # Edit an existing ticket's content: summary and/or description (Jira wiki markup).
    data = request.get_json(silent=True) or {}
    key = data.get("key", "")
    if not _JIRA_KEY_RE.match(key or ""):
        return jsonify({"error": "bad key"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False}), 200
    fields = {}
    if "summary" in data:
        s = (data.get("summary") or "").strip()
        if not s:
            return jsonify({"ok": False, "error": "summary cannot be empty"}), 200
        fields["summary"] = s
    if "description" in data:
        fields["description"] = data.get("description") or ""
    if not fields:
        return jsonify({"ok": False, "error": "nothing to update"}), 200
    try:
        r = requests.put(base + "/rest/api/2/issue/" + key, json={"fields": fields},
                         headers=_jira_headers(email, token), timeout=20)
        if r.status_code not in (200, 204):
            return jsonify({"ok": False, "error": _jira_err(r)}), 200
        if "summary" in fields:
            M.sync_db["jira_tickets"].update_one({"issue_key": key}, {"$set": {"title": fields["summary"]}})
        return jsonify({"ok": True}), 200
    except Exception as e:
        logger.error("[Console] jira-issue-edit failed: %s", e)
        return jsonify({"ok": False, "error": "failed"}), 200


@console_api_bp.route("/jira-comment-edit", methods=["POST"])
@perm_required("jira")
def jira_comment_edit():
    # Edit an existing comment (only ones authored by the bot account, enforced client-side; Jira
    # enforces the real permission and its error is surfaced back).
    data = request.get_json(silent=True) or {}
    key = data.get("key", "")
    cid = str(data.get("comment_id", "")).strip()
    text = (data.get("text") or "").strip()
    if not _JIRA_KEY_RE.match(key or "") or not cid.isdigit() or not text:
        return jsonify({"error": "bad params"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False}), 200
    try:
        r = requests.put(base + "/rest/api/2/issue/" + key + "/comment/" + cid,
                         json={"body": text}, headers=_jira_headers(email, token), timeout=15)
        if r.status_code not in (200, 201):
            return jsonify({"ok": False, "error": _jira_err(r)}), 200
        return jsonify({"ok": True}), 200
    except Exception as e:
        logger.error("[Console] jira-comment-edit failed: %s", e)
        return jsonify({"ok": False, "error": "failed"}), 200


@console_api_bp.route("/jira-fields", methods=["POST"])
@perm_required("jira")
def jira_fields():
    # Edit the Communication Link + L1 Tags on an existing ticket. The comm-link value is shaped
    # for the field's real schema (select/multi/text), resolved at runtime via editmeta.
    data = request.get_json(silent=True) or {}
    key = data.get("key", "")
    if not _JIRA_KEY_RE.match(key or ""):
        return jsonify({"error": "bad key"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False}), 200
    headers = _jira_headers(email, token)
    fields = {}
    if "communication_link" in data:
        meta = _editmeta_fields(base, headers, key)
        fields[_JIRA_COMM_FIELD] = _commlink_payload(meta.get(_JIRA_COMM_FIELD), (data.get("communication_link") or "").strip())
    if "l1_tags" in data:
        tags = [t for t in (data.get("l1_tags") or []) if t in _JIRA_L1_TAGS]
        fields[_JIRA_L1_FIELD] = [{"id": _JIRA_L1_TAGS[t]} for t in tags]
    if not fields:
        return jsonify({"ok": False, "error": "nothing to update"}), 200
    try:
        r = requests.put(base + "/rest/api/2/issue/" + key, json={"fields": fields},
                         headers=headers, timeout=20)
        if r.status_code not in (200, 204):
            return jsonify({"ok": False, "error": _jira_err(r)}), 200
        if "communication_link" in data:
            M.sync_db["jira_tickets"].update_one({"issue_key": key},
                {"$set": {"communication_link": (data.get("communication_link") or "").strip()}})
        return jsonify({"ok": True}), 200
    except Exception as e:
        logger.error("[Console] jira-fields failed: %s", e)
        return jsonify({"ok": False, "error": "failed"}), 200


@console_api_bp.route("/jira-attach", methods=["POST"])
@perm_required("jira")
def jira_attach():
    # Multipart upload: attach an image/video to a ticket, then return the wiki markup to embed it
    # in a description or comment (!file|thumbnail! for images, [^file] as a link for anything else).
    key = request.form.get("key", "")
    if not _JIRA_KEY_RE.match(key or ""):
        return jsonify({"ok": False, "error": "bad key"}), 400
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "no file"}), 400
    base, email, token = _jira_env()
    if not (base and email and token):
        return jsonify({"configured": False}), 200
    content = f.read()
    if len(content) > _MAX_ATTACH:
        return jsonify({"ok": False, "error": "file too large (max 50MB)"}), 200
    try:
        url = base + "/rest/api/2/issue/" + key + "/attachments"
        headers = {"Authorization": "Basic " + b64encode((email + ":" + token).encode()).decode(),
                   "X-Atlassian-Token": "no-check"}
        r = requests.post(url, files={"file": (f.filename, content, f.mimetype or "application/octet-stream")},
                          headers=headers, timeout=60)
        if r.status_code not in (200, 201):
            return jsonify({"ok": False, "error": _jira_err(r)}), 200
        body = r.json()
        att = body[0] if isinstance(body, list) and body else {}
        fname = att.get("filename", f.filename)
        is_image = str(att.get("mimeType", f.mimetype or "")).startswith("image/")
        markup = ("!%s|thumbnail!" % fname) if is_image else ("[^%s]" % fname)
        return jsonify({"ok": True, "filename": fname, "is_image": is_image, "markup": markup}), 200
    except Exception as e:
        logger.error("[Console] jira-attach failed: %s", e)
        return jsonify({"ok": False, "error": "failed"}), 200


@console_api_bp.route("/jira-attachment", methods=["GET"])
@perm_required("jira")
def jira_attachment():
    # Authenticated proxy for Jira attachment images (browser can't auth to Jira directly).
    # SSRF-guarded: only fetches URLs under the configured JIRA_BASE_URL.
    from urllib.parse import urlparse
    base, email, token = _jira_env()
    url = request.args.get("url", "")
    if not (base and email and token):
        return ("", 400)
    # SSRF guard: the target host must EXACTLY match the Jira host - a prefix check like
    # url.startswith(base) is bypassable (e.g. https://acme.atlassian.net.evil.com), which would
    # leak the Jira Basic-auth credential to the attacker's server.
    try:
        if urlparse(url).netloc.lower() != urlparse(base).netloc.lower():
            return ("", 400)
    except Exception:
        return ("", 400)
    try:
        r = requests.get(url, headers={"Authorization": "Basic " + b64encode((email + ":" + token).encode()).decode()},
                         timeout=20, allow_redirects=False)   # never follow a redirect off the Jira host with creds attached
        if r.status_code != 200:
            return ("", r.status_code)
        return Response(r.content, content_type=r.headers.get("Content-Type", "application/octet-stream"),
                        headers={"Cache-Control": "private, max-age=3600"})
    except Exception as e:
        logger.error("[Console] jira-attachment proxy failed: %s", e)
        return ("", 502)


@console_api_bp.route("/users-emails", methods=["GET"])
@login_required
def users_emails():
    # Targeted lookup by identifier (used by the console to resolve one user's email on demand -
    # the collection can be large, so a bulk cap would otherwise miss recent records). Falls back
    # to a bulk list (newest first) when no identifier is given.
    reddit = request.args.get("reddit")
    discord = request.args.get("discord")
    facebook = request.args.get("facebook")
    telegram = request.args.get("telegram")
    if reddit or discord or facebook or telegram:
        q = {}
        if reddit:
            q["reddit_username"] = {"$in": list({reddit, reddit.lower()})}   # Add Email stores it lowercased
        if discord:
            q["discord_user_id"] = {"$in": [discord, str(discord)] + ([int(discord)] if str(discord).isdigit() else [])}
        if facebook:
            q["facebook_author"] = facebook
        if telegram:
            q["telegram_user_id"] = {"$in": [telegram] + ([int(telegram)] if str(telegram).lstrip("-").isdigit() else [])}
        return jsonify(_find(M.sync_users_emails_collection, query=q, limit=50)), 200
    # Bulk: newest first (by _id, always present) so recent emails are included within the cap. This is
    # the single heaviest hydrate read on the slow main cluster (~5s for the full directory), and the
    # directory changes only when a new email is captured, so serve it from a short in-process cache.
    # The on-demand lookup path above (with args) is never cached, so resolving one user stays live.
    cached = _cache_get("users_emails_bulk")
    if cached is not None:
        return jsonify(cached), 200
    docs = _find(M.sync_users_emails_collection, limit=2000, sort=("_id", -1))
    return jsonify(_cache_put("users_emails_bulk", docs, 180)), 200


@console_api_bp.route("/reddit-mod-notes", methods=["GET"])
@perm_required("reddit")
@live("modnotes", "/reddit-mod-notes", perm="reddit", ttl=15)
def reddit_mod_notes():
    return jsonify(_clean(M.get_all_reddit_mod_notes_sync())), 200


_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def _hide_emails(value):
    """Users' email addresses are never shown in the console: every string in the payload has them replaced
    with "[email hidden]" (the user's User ID is shown in the identity panel instead). Applies to data
    stored before the bot started redacting too."""
    if isinstance(value, str):
        return _EMAIL_RE.sub("[email hidden]", value) if "@" in value else value
    if isinstance(value, list):
        return [_hide_emails(v) for v in value]
    if isinstance(value, dict):
        return {k: _hide_emails(v) for k, v in value.items()}
    return value


@console_api_bp.route("/reddit-modmail", methods=["GET"])
@perm_required("reddit")
@live("modmail", "/reddit-modmail", perm="reddit", ttl=6)
def reddit_modmail():
    # Light list from the bot's snapshot (separate DB): drop `messages` (heavy). Fetch a single
    # conversation's messages via /reddit-modmail/<convo_id>.
    docs = list(M.snapshot_db["reddit_modmail_snapshot"].find(
        {}, {"_id": 0, "messages": 0}).sort("last_updated", -1).limit(3000))
    return jsonify(_hide_emails(docs)), 200


def _msg_dt(v):
    """Parse a modmail/note timestamp ("...+0000", "...Z", naive ISO or epoch) to an aware UTC datetime."""
    from datetime import datetime, timezone
    if v is None or v == "":
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(float(v), tz=timezone.utc)
        s = str(v).strip().replace(" ", "T")
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        m = re.search(r"([+-]\d{2})(\d{2})$", s)          # +0000 -> +00:00
        if m and not re.search(r"[+-]\d{2}:\d{2}$", s):
            s = s[:m.start()] + m.group(1) + ":" + m.group(2)
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _norm_body(t):
    return re.sub(r"\s+", " ", str(t or "")).strip()


@console_api_bp.route("/reddit-modmail/<convo_id>", methods=["GET"])
@perm_required("reddit")
def reddit_modmail_detail(convo_id):
    doc = M.snapshot_db["reddit_modmail_snapshot"].find_one({"convo_id": convo_id}, {"_id": 0})
    if not doc:
        return jsonify({"error": "Not found"}), 404
    msgs = doc.get("messages") or []
    # Merge console-only, mods-only system notes (e.g. "linked Jira moved to <status>") into the
    # transcript. They live in their own store (written by the bot on a linked-Jira transition) because the
    # snapshot doc is rebuilt from Reddit each pass and would wipe an injected message. Never written to
    # reddit.com (automated Reddit notes are intentionally disabled).
    try:
        notes = list(M.sync_db["reddit_convo_notes"].find({"convo_id": convo_id}, {"_id": 0}).sort("created_utc", 1))
        for n in notes:
            msgs.append({
                "id": n.get("id") or ("note-" + str(n.get("created_utc") or "")),
                "author": n.get("author") or "System",
                "body": n.get("body") or "",
                "is_internal": True,
                "date": n.get("date") or (n.get("created_utc").isoformat() + "Z" if n.get("created_utc") else ""),
                "console_note": True,
            })
    except Exception as e:
        logger.debug("[Console] reddit_convo_notes merge failed for %s: %s", convo_id, e)
    # Keep the transcript chronological so a system note sits where it happened, not at the bottom.
    # Stable sort; an item without a parsable date keeps the slot of the item before it.
    keyed, last = [], None
    for idx, m in enumerate(msgs):
        d = _msg_dt(m.get("date")) or last
        last = d or last
        keyed.append((d.timestamp() if d else float("-inf"), idx, m))
    msgs = [m for _, _, m in sorted(keyed, key=lambda k: (k[0], k[1]))]
    # Who actually sent it: replies from the console all go out as the shared bot account, so match each
    # mod message to the console sender recorded at send time (reddit_reply_authors: same convo, same
    # text, posted shortly after it was queued) and expose it as `console_author`.
    try:
        recs = list(M.sync_db["reddit_reply_authors"].find({"convo_id": convo_id}, {"_id": 0}).sort("created_at", 1))
        if recs:
            participant = doc.get("participant")
            # Console replies reach Reddit as the app (u/cmthelper) or the bot account: match those first, so a
            # moderator who typed the same text by hand on Reddit is never labelled with the console sender.
            ours = {x.strip().lower() for x in (os.getenv("DEVVIT_APP_ACCOUNTS") or "cmthelper").split(",") if x.strip()}
            if os.getenv("REDDIT_USERNAME"):
                ours.add(os.getenv("REDDIT_USERNAME").strip().lower())
            taken = set()
            for r in recs:
                rbody, rd = _norm_body(r.get("body")), _msg_dt(r.get("created_at"))
                cands = []
                for idx, m in enumerate(msgs):
                    if idx in taken or m.get("console_note") or m.get("author") == participant:
                        continue
                    if _norm_body(m.get("body")) != rbody:
                        continue
                    md = _msg_dt(m.get("date"))
                    if md and rd and not (-120 <= (md - rd).total_seconds() <= 3600):
                        continue
                    cands.append((0 if str(m.get("author") or "").lower() in ours else 1, idx))
                if cands:
                    idx = min(cands)[1]
                    taken.add(idx)
                    msgs[idx]["console_author"] = r.get("author_name") or ""
    except Exception as e:
        logger.debug("[Console] reddit reply attribution failed for %s: %s", convo_id, e)
    doc["messages"] = msgs
    return jsonify(_hide_emails(doc)), 200


@console_api_bp.route("/reddit-posts", methods=["GET"])
@perm_required("posts")
@live("posts", "/reddit-posts", perm="posts", ttl=6)
def reddit_posts():
    # Light list: drop the heavy fields (comments, full body, images). The row only needs title/
    # author/status; fetch the full post + comments via /reddit-posts/<post_id>.
    docs = list(M.snapshot_db["reddit_posts_snapshot"].find(
        {}, {"_id": 0, "comments": 0, "body": 0, "images": 0}).sort("created", -1).limit(2000))
    return jsonify(_hide_emails(docs)), 200


@console_api_bp.route("/reddit-posts/<post_id>", methods=["GET"])
@perm_required("posts")
def reddit_post_detail(post_id):
    doc = M.snapshot_db["reddit_posts_snapshot"].find_one({"post_id": post_id}, {"_id": 0})
    if not doc:
        return jsonify({"error": "Not found"}), 404
    return jsonify(_hide_emails(doc)), 200


@console_api_bp.route("/reddit-comments", methods=["GET"])
@perm_required("reddit_comments")
@live("comments", "/reddit-comments", perm="reddit_comments", ttl=10)
def reddit_comments():
    """Comments that reply to one of OUR comments, flattened across posts (newest first). Fed by the
    reply_to_mod flag the reddit snapshot stamps on each mirrored comment (redit_notifications
    _snap_append_comment). Each row carries the reply plus the comment of ours it answered and its
    parent post, so the console Reddit Comments tab reads at a glance."""
    out = []
    docs = M.snapshot_db["reddit_posts_snapshot"].find(
        {"comments.reply_to_mod": True},
        {"_id": 0, "post_id": 1, "title": 1, "url": 1, "comments": 1},
    ).sort("last_user_reply_to_mod_at", -1).limit(500)
    for d in docs:
        post_id = d.get("post_id", "")
        post_title = d.get("title", "")
        post_url = d.get("url", "")
        for c in (d.get("comments") or []):
            if not c.get("reply_to_mod"):
                continue
            plink = c.get("permalink") or ""
            if plink.startswith("/"):
                link = "https://www.reddit.com" + plink
            elif plink:
                link = plink
            else:
                link = "https://www.reddit.com/comments/%s/_/%s" % (post_id, c.get("id", ""))
            out.append({
                "id": c.get("id", ""),
                "author": c.get("author", ""),
                "body": c.get("body", ""),
                "created": c.get("created"),
                "link": link,
                "parent_author": c.get("parent_author", ""),
                "parent_body": c.get("parent_body", ""),
                "post_id": post_id,
                "post_title": post_title,
                "post_url": post_url,
            })
    out.sort(key=lambda x: x.get("created") or "", reverse=True)
    return jsonify(_hide_emails(out[:500])), 200


@console_api_bp.route("/maintenances", methods=["GET"])
@login_required
@live("maint", "/maintenances", ttl=6)
def maintenances():
    """Active game + server maintenances for the console Maintenance tab. `started_at` drives the
    live 'running for' timer the frontend ticks each second; `eta` is shown when set."""
    out = []
    for d in M.sync_db["active_maintenances"].find({}).sort("started_at", 1):
        started = d.get("started_at")
        out.append({
            "entity": d.get("entity", ""),
            "type": (d.get("type") or "").lower(),
            "eta": d.get("eta", ""),
            "started_at": started.isoformat() if hasattr(started, "isoformat") else (started or None),
        })
    return jsonify(out), 200


@console_api_bp.route("/reddit-modmail/<convo_id>", methods=["DELETE"])
@admin_required
def delete_reddit_convo(convo_id):
    # Admin: remove a conversation from the console only (test / junk rows). Reddit itself is not touched.
    from api.routes import console_live
    n = M.snapshot_db["reddit_modmail_snapshot"].delete_many({"convo_id": convo_id}).deleted_count
    for c in ("console_convo_status", "console_convo_replied", "reddit_convo_notes"):
        M.sync_db[c].delete_many({"convo_id": convo_id})
    console_live.bust("modmail")
    return jsonify({"ok": True, "deleted": n}), 200


@console_api_bp.route("/bans", methods=["GET"])
@login_required
def bans():
    # Bans from the Telegram ban channel (written by the bot: services/bans_tracker.py), newest first.
    # Old-format bans carry only an encrypted email: it never leaves the server, the row just says
    # the User ID is still pending (resolved later by the email -> User ID migration).
    docs = list(M.sync_db["bans"].find({}, {"email_enc": 0, "email_hash": 0}).sort("posted_at", -1).limit(5000))
    for d in docs:
        d["id"] = str(d.pop("_id", ""))
        d["email_pending"] = bool(d.get("needs_user_id")) and not d.get("user_id")
    return jsonify(_clean(docs)), 200


def _kyiv_monday_utc():
    """Monday 00:00 of the current week in Kyiv time, as a naive UTC datetime."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Europe/Kyiv"))
    monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return monday.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


@console_api_bp.route("/wishlist", methods=["GET"])
@perm_required("wishlist")
def wishlist():
    # Our own wishlist (written by the bot: services/wishlist_store.py). Each game carries its requests this
    # week (Monday 00:00 Kyiv onwards) so the tab can sort and show the weekly numbers without more calls.
    since = _kyiv_monday_utc()
    week = {r["_id"]: r["n"] for r in M.sync_db["wishlist_requests"].aggregate([
        {"$match": {"created_at": {"$gte": since}}}, {"$group": {"_id": "$game_key", "n": {"$sum": 1}}}])}
    docs = list(M.sync_db["wishlist_games"].find({}, {"_id": 0, "status_history": 0})
                .sort("requests", -1).limit(5000))
    for d in docs:
        d["week"] = week.get(d.get("key"), 0)
    return jsonify(_clean({"games": docs, "week_start": since})), 200


@console_api_bp.route("/wishlist/requests", methods=["GET"])
@perm_required("wishlist")
def wishlist_requests():
    # Request history of one game + its status changes.
    key = (request.args.get("key") or "").strip()
    if not key:
        return jsonify({"error": "key required"}), 400
    reqs = list(M.sync_db["wishlist_requests"].find({"game_key": key}, {"_id": 0, "legacy_id": 0})
                .sort("created_at", -1).limit(300))
    game = M.sync_db["wishlist_games"].find_one({"key": key}, {"_id": 0, "status_history": 1}) or {}
    return jsonify(_clean({"requests": reqs, "status_history": list(reversed(game.get("status_history") or []))})), 200


@console_api_bp.route("/wishlist/weekly", methods=["GET"])
@perm_required("wishlist")
def wishlist_weekly():
    # Monday summaries of past weeks (written by the bot), newest first.
    docs = list(M.sync_db["wishlist_weekly"].find({}).sort("_id", -1).limit(26))
    for d in docs:
        d["week"] = d.pop("_id")
    return jsonify(_clean(docs)), 200


@console_api_bp.route("/events", methods=["GET"])
@login_required
def mm_events():
    # Boosteroid admin-service events from Mattermost (written by the bot: services/mattermost_events.py).
    docs = list(M.sync_db["mm_events"].find(
        {"ignored": {"$ne": True},
         "category": {"$in": ["new_game", "removed", "game_card", "maintenance", "regional", "server"]}},
        {"_id": 0, "raw": 0}, sort=[("created_at", -1)], limit=500))
    return jsonify(_clean(docs)), 200


@console_api_bp.route("/maintenance-subs", methods=["GET"])
@login_required
@live("subs", "/maintenance-subs", ttl=15)
def maintenance_subs():
    # Active maintenance-end subscriptions (a convo/ticket -> notify on end). The console shows
    # these in the context panel's Maintenance section.
    docs = list(M.sync_db["maintenance_subscriptions"].find(
        {"status": {"$in": ["active", "ended_pending"]}}, {"_id": 0}))
    return jsonify(_clean(docs)), 200
