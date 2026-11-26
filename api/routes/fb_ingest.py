"""
Facebook group feed from the CMT browser extension.

The CM keeps the Facebook group (and the shared account's messages) open in Chrome with the extension
installed. Every 5 minutes the extension reloads those tabs, reads the newest posts and the unread chats
and POSTs them here. We store them (`fb_posts`, `fb_dms`); the bot on the VM announces new ones in Slack
(services/facebook_feed_notify.py) and the console shows them in the Facebook tab.

Auth for the extension: header `X-CMT-FB-Key` must match the key kept in console_config (`fb_ext_key`).
The key is created on the first admin download of the extension and baked into that zip.
"""
import hmac
import io
import logging
import os
import re
import secrets
import zipfile
from datetime import datetime

from flask import Blueprint, jsonify, request, send_file

from api.routes.console_db import sync_db
from api.routes.console_auth import admin_required, perm_required, current_user

logger = logging.getLogger(__name__)

fb_ingest_bp = Blueprint("fb_ingest", __name__)

posts_col = sync_db["fb_posts"]
dms_col = sync_db["fb_dms"]
config_col = sync_db["console_config"]
try:
    posts_col.create_index([("posted_at", -1)])
    posts_col.create_index("slack_sent")
    posts_col.create_index("author_key")
    posts_col.create_index("text_key")
    dms_col.create_index([("last_seen_unread", -1)])
    dms_col.create_index("slack_sent")
except Exception as e:
    logger.warning("[FB] indexes not ensured: %s", e)

EXT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fb-extension")


def _ext_key(create=False):
    d = config_col.find_one({"key": "fb_ext_key"}) or {}
    if d.get("value") or not create:
        return d.get("value", "")
    val = secrets.token_urlsafe(32)
    config_col.update_one({"key": "fb_ext_key"}, {"$set": {"key": "fb_ext_key", "value": val,
                                                           "created_at": datetime.utcnow()}}, upsert=True)
    return val


def _ext_ok():
    key = _ext_key()
    return bool(key) and hmac.compare_digest(key, request.headers.get("X-CMT-FB-Key", ""))


def _s(v, n=4000):
    return str(v or "").strip()[:n]


def author_key(url, name):
    """Stable author identity: the profile id / vanity from the profile URL, else the display name."""
    u = _s(url, 500)
    m = re.search(r"[?&]id=(\d+)", u) or re.search(r"/user/(\d+)", u) or re.search(r"facebook\.com/(?!groups/)([A-Za-z0-9.\-]+)", u)
    return ("fb:" + m.group(1).lower()) if m else ("name:" + _s(name, 200).lower())


def undouble(text):
    """Facebook sometimes renders the same text twice in a row ("abcabc"): keep one copy."""
    t = text or ""
    m = re.fullmatch(r"([\s\S]{4,}?)\s*\1", t)
    return m.group(1) if m else t


def text_key(author_key_, text):
    """Fingerprint for de-duplication: author + the first 120 letters/digits of the text."""
    t = re.sub(r"(…|\.\.\.)?\s*See more\s*$", "", text or "", flags=re.I).lower()
    return author_key_ + "|" + re.sub(r"[\W_]+", "", t)[:120]


users_col = sync_db["users_emails"]   # THE user directory: Reddit / Discord / Telegram / Facebook in one place


def _bindings(keys=None):
    """author_key -> User ID, from the user directory (users_emails.facebook_key)."""
    q = {"facebook_key": {"$in": list(keys)}} if keys is not None else {"facebook_key": {"$nin": [None, ""]}}
    q["cloud_user_id"] = {"$nin": [None, ""]}
    return {d["facebook_key"]: str(d["cloud_user_id"]) for d in users_col.find(q, {"facebook_key": 1, "cloud_user_id": 1})}


def _bind(akey, uid, name, by):
    """Bind (uid) or unbind ("") a Facebook person. Stored ONLY in the user directory, like every other
    social account; posts carry a copy of the ID for display."""
    now = datetime.utcnow()
    match = {"facebook_key": akey} if users_col.find_one({"facebook_key": akey}, {"_id": 1}) else (
        {"facebook_author": name, "facebook_key": {"$in": [None, ""]}} if name else {"facebook_key": akey})
    if uid:
        users_col.update_one(match, {"$set": {"facebook_key": akey, "facebook_author": name or None,
                                              "cloud_user_id": uid, "cloud_user_id_at": now,
                                              "cloud_user_id_status": "found", "cloud_user_id_source": by or "manual",
                                              "platform": "Facebook", "updated_at": now},
                                     "$setOnInsert": {"created_at": now}}, upsert=True)
    else:
        users_col.update_many({"facebook_key": akey}, {"$set": {"cloud_user_id": "", "updated_at": now}})
    posts_col.update_many({"author_key": akey}, {"$set": {"user_id": uid}})
    try:
        from api.routes.console_api import _cache_bust
        _cache_bust("users_emails_bulk")
    except Exception as _e:
        logger.debug("ignored: %s", _e)


def move_old_binds():
    """Migration step 1 (services/db_migrations.py): Facebook bindings that lived in their own collection
    (fb_author_binds) move into the user directory; posts bound before that keep their ID too."""
    moved = 0
    try:
        old = sync_db["fb_author_binds"]
        for d in old.find({"user_id": {"$nin": [None, ""]}}):
            _bind(d["_id"], str(d["user_id"]), d.get("name") or "", "moved")
            moved += 1
        seen = set()
        for d in posts_col.find({"user_id": {"$nin": [None, ""]}}, {"author_key": 1, "author": 1, "user_id": 1}):
            k = d.get("author_key")
            if k and k not in seen and not users_col.find_one({"facebook_key": k}, {"_id": 1}):
                _bind(k, str(d["user_id"]), d.get("author") or "", "moved")
                moved += 1
            seen.add(k)
        if moved:
            logger.info("[FB] moved %d Facebook binding(s) into the user directory", moved)
        old.drop()
    except Exception as e:
        logger.warning("[FB] moving old bindings failed: %s", e)
        raise
    return {"moved": moved}


try:
    users_col.create_index("facebook_key", sparse=True)
except Exception as _e:
    logger.debug("ignored: %s", _e)


def _resolve_value(value):
    """What the operator typed -> (User ID, error). A User ID is taken as is; an email is looked up through
    the bot's cloud API lookup (a queued action, answered in seconds). The address is never stored."""
    raw = str(value or "").strip()
    if not raw:
        return "", None
    if "@" not in raw:
        uid = re.sub(r"\D", "", raw)[:12]
        return (uid, None) if uid else ("", "not a User ID or an email")
    email = raw.lower()
    if not re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", email):
        return "", "not a valid email"
    import time
    actions = sync_db["console_actions"]
    aid = actions.insert_one({"type": "cloud_user_lookup", "payload": {"email": email}, "status": "pending",
                              "result": None, "error": None, "created_at": datetime.utcnow(), "claimed_at": None,
                              "finished_at": None, "author_name": "Facebook", "source": "facebook"}).inserted_id
    for _ in range(50):     # the bot's worker picks actions up at once (change stream); wait up to ~25s
        time.sleep(0.5)
        a = actions.find_one({"_id": aid}, {"status": 1, "result": 1, "error": 1})
        if a and a.get("status") == "done":
            uid = str((a.get("result") or {}).get("user_id") or "")
            return (uid, None) if uid else ("", "user not found")
        if a and a.get("status") == "error":
            return "", a.get("error") or "lookup failed"
    return "", "the lookup took too long, try again"


def backfill_text_keys():
    """Migration step 2: posts saved before text_key existed get one."""
    n = 0
    for d in posts_col.find({"text_key": {"$exists": False}}, {"author_key": 1, "text": 1}):
        posts_col.update_one({"_id": d["_id"]}, {"$set": {"text_key": text_key(d.get("author_key", ""), d.get("text"))}})
        n += 1
    return {"posts_updated": n}


@fb_ingest_bp.route("/api/fb/ingest", methods=["POST"])
def fb_ingest():
    if not _ext_ok():
        return jsonify({"error": "unauthorized"}), 401
    if (request.content_length or 0) > 1024 * 1024:
        return jsonify({"error": "too large"}), 413
    data = request.get_json(silent=True) or {}
    now = datetime.utcnow()
    binds = _bindings({author_key(p.get("author_url"), p.get("author")) for p in (data.get("posts") or [])[:100]})
    first_run = posts_col.count_documents({}, limit=1) == 0   # no Slack flood for what is already on the page
    new_posts = 0
    for p in (data.get("posts") or [])[:100]:
        pid = _s(p.get("id"), 120)
        if not pid:
            continue
        akey = author_key(p.get("author_url"), p.get("author"))
        p["text"] = undouble(p.get("text"))
        tkey = text_key(akey, p.get("text"))
        same = posts_col.find_one({"text_key": tkey}, {"_id": 1}, sort=[("first_seen", 1)])   # the oldest copy wins
        if same:
            pid = same["_id"]       # already have this post (seen with another id): update it, never a new one
        upd = {"author": _s(p.get("author"), 200), "author_url": _s(p.get("author_url"), 500),
               "author_key": akey, "text": _s(p.get("text")), "url": _s(p.get("url"), 500),
               "group": _s(p.get("group"), 200), "updated_at": now, "text_key": tkey}
        res = posts_col.update_one({"_id": pid}, {"$set": upd, "$setOnInsert": {
            "posted_at": now, "first_seen": now, "tags": [], "status": "new",
            "user_id": binds.get(akey, ""), "slack_sent": first_run}}, upsert=True)
        if res.upserted_id:
            new_posts += 1
    new_dms = 0
    for t in (data.get("dms") or [])[:100]:
        tid = _s(t.get("id"), 200)
        if not tid:
            continue
        snippet = _s(t.get("snippet"), 300)
        prev = dms_col.find_one({"_id": tid}, {"snippet": 1})
        if prev and prev.get("snippet") == snippet:
            dms_col.update_one({"_id": tid}, {"$set": {"last_seen_unread": now}})
            continue
        dms_col.update_one({"_id": tid}, {"$set": {"name": _s(t.get("name"), 200), "url": _s(t.get("url"), 500),
                                                    "snippet": snippet, "last_seen_unread": now,
                                                    "status": "new", "slack_sent": first_run},
                                           "$setOnInsert": {"first_seen": now}}, upsert=True)
        new_dms += 1
    config_col.update_one({"key": "fb_ext_heartbeat"}, {"$set": {"key": "fb_ext_heartbeat", "at": now,
                                                                 "page": _s(data.get("page"), 40),
                                                                 "version": _s(data.get("version"), 20),
                                                                 "seen": len(data.get("posts") or []),
                                                                 "hidden": bool(data.get("hidden"))}}, upsert=True)
    return jsonify({"ok": True, "new_posts": new_posts, "new_dms": new_dms}), 200


@fb_ingest_bp.route("/api/fb/bind", methods=["POST"])
def fb_bind():
    """Extension: bind (or clear) a Facebook author's User ID right from the Facebook page."""
    if not _ext_ok():
        return jsonify({"error": "unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    uid, err = _resolve_value(data.get("user_id"))
    if err:
        return jsonify({"ok": False, "error": err}), 200
    _bind(author_key(data.get("url"), data.get("name")), uid, _s(data.get("name"), 200), "extension")
    return jsonify({"ok": True, "user_id": uid}), 200


@fb_ingest_bp.route("/api/fb/userids", methods=["POST"])
def fb_userids():
    """Extension overlay: [{url, name}] -> {index: user_id} for authors the team already bound."""
    if not _ext_ok():
        return jsonify({"error": "unauthorized"}), 401
    authors = (request.get_json(silent=True) or {}).get("authors", [])[:300]
    keys = [author_key(a.get("url"), a.get("name")) for a in authors]
    binds = _bindings(keys)
    out = {}
    for i, a in enumerate(authors):
        uid = binds.get(keys[i])
        if uid:
            out[str(i)] = uid
    return jsonify(out), 200


def _post_public(d):
    d = dict(d)
    d["id"] = str(d.pop("_id"))
    for k in ("posted_at", "first_seen", "updated_at", "handled_at"):
        if isinstance(d.get(k), datetime):
            d[k] = d[k].isoformat() + "Z"
    d.pop("slack_sent", None)
    return d


@fb_ingest_bp.route("/api/console/fb-posts", methods=["GET"])
@perm_required("facebook")
def list_fb_posts():
    hb = config_col.find_one({"key": "fb_ext_heartbeat"}) or {}
    posts = [_post_public(d) for d in posts_col.find({}).sort("posted_at", -1).limit(1000)]
    dms = [_post_public(d) for d in dms_col.find({}).sort("last_seen_unread", -1).limit(300)]
    return jsonify({"posts": posts, "dms": dms, "ext_version": hb.get("version", ""), "ext_seen": hb.get("seen", 0), "ext_hidden": hb.get("hidden", False), "ext_latest": _ext_version(),
                    "heartbeat": hb["at"].isoformat() + "Z" if isinstance(hb.get("at"), datetime) else ""}), 200


@fb_ingest_bp.route("/api/console/fb-posts/<pid>", methods=["PATCH"])
@perm_required("facebook")
def update_fb_post(pid):
    body = request.get_json(silent=True) or {}
    u = current_user() or {}
    upd = {}
    if "tags" in body and isinstance(body["tags"], list):
        upd["tags"] = [_s(t, 40) for t in body["tags"] if _s(t, 40)][:20]
    if "status" in body and body["status"] in ("new", "handled", "ignored"):
        upd["status"] = body["status"]
        upd["handled_by"] = u.get("name") or u.get("email", "")
        upd["handled_at"] = datetime.utcnow()
    if "user_id" in body:
        uid, err = _resolve_value(body["user_id"])
        if err:
            return jsonify({"error": err}), 200     # shown to the operator as is
        doc = posts_col.find_one({"_id": pid}, {"author_key": 1, "author": 1})
        if not doc:
            return jsonify({"error": "not found"}), 404
        _bind(doc["author_key"], uid, doc.get("author", ""), u.get("name") or u.get("email", ""))
    if upd:
        posts_col.update_one({"_id": pid}, {"$set": upd})
    d = posts_col.find_one({"_id": pid})
    return (jsonify(_post_public(d)), 200) if d else (jsonify({"error": "not found"}), 404)


@fb_ingest_bp.route("/api/console/fb-dms/<tid>", methods=["PATCH"])
@perm_required("facebook")
def update_fb_dm(tid):
    st = (request.get_json(silent=True) or {}).get("status")
    if st not in ("new", "seen"):
        return jsonify({"error": "bad status"}), 400
    dms_col.update_one({"_id": tid}, {"$set": {"status": st}})
    return jsonify({"ok": True}), 200


def _ext_version():
    import json
    with open(os.path.join(EXT_DIR, "manifest.json"), encoding="utf8") as f:
        return json.load(f).get("version", "")


@fb_ingest_bp.route("/api/fb/ext-version", methods=["GET"])
def fb_ext_version():
    if not _ext_ok():
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"version": _ext_version()}), 200


@fb_ingest_bp.route("/api/fb/ext-download", methods=["GET"])
def fb_ext_download():
    """The extension downloads its own update (same zip as the admin button, same key)."""
    if not _ext_ok():
        return jsonify({"error": "unauthorized"}), 401
    return _zip_response()


@fb_ingest_bp.route("/api/console/fb-extension.zip", methods=["GET"])
@admin_required
def fb_extension_zip():
    return _zip_response()


def _firefox_manifest(raw: bytes) -> bytes:
    """Same extension for Firefox: an event-page background (scripts) and a fixed add-on id."""
    import json
    m = json.loads(raw.decode("utf8"))
    m["background"] = {"scripts": ["config.js", "background.js"]}
    m["browser_specific_settings"] = {"gecko": {"id": "cmt-facebook@cmtconsole", "strict_min_version": "121.0"}}
    return (json.dumps(m, indent=2) + "\n").encode("utf8")


def _zip_response():
    firefox = request.args.get("browser") == "firefox"
    base = (os.getenv("CONSOLE_PUBLIC_URL") or request.host_url).rstrip("/")
    if base.startswith("http://") and not re.search(r"//(localhost|127\.0\.0\.1)[:/]?", base):
        base = "https://" + base[len("http://"):]   # behind Railway's proxy the request looks like http
    key = _ext_key(create=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(EXT_DIR)):
            path = os.path.join(EXT_DIR, name)
            if not os.path.isfile(path):
                continue
            data = open(path, "rb").read()
            if name == "config.js":
                data = ("self.CMT_CONFIG = { api: %r, key: %r };\n" % (base, key)).replace("'", '"').encode()
            if name == "manifest.json":
                data = data.replace(b"__CONSOLE_ORIGIN__", (base + "/*").encode())
                if firefox:
                    data = _firefox_manifest(data)
            # Firefox wants manifest.json at the root of the archive (it can be signed as an .xpi as is).
            z.writestr(name if firefox else "cmt-facebook/" + name, data)
    buf.seek(0)
    fname = "cmt-facebook-firefox.zip" if firefox else "cmt-facebook-extension.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)
