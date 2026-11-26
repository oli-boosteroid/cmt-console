"""
Console auth.

Real sign-in for the CMT Console, backed by a new `console_users` Mongo collection.
No passwords live in the repo or in env: a user with no password set goes through a
first-run "set your password" step. Sessions use Flask's signed cookie (needs
`CONSOLE_SECRET_KEY` in .env for them to survive restarts).

Shared auth helpers (`current_user`, `login_required`, `admin_required`) are imported
by `console_api.py` so every /api/console/* endpoint is gated the same way: a valid
session (there is no service token: every request acts as a signed-in person).
"""
import os
import re
import secrets
import logging
import time
from functools import wraps
from datetime import datetime

from flask import Blueprint, jsonify, request, session
from werkzeug.security import generate_password_hash, check_password_hash
from bson import ObjectId
from bson.errors import InvalidId

from api.routes.console_db import sync_db
from api.routes import console_live
from api.routes.console_live import live

logger = logging.getLogger(__name__)

console_auth_bp = Blueprint("console_auth", __name__, url_prefix="/api/console")
console_auth_bp.after_request(console_live.after_write)

users_col = sync_db["console_users"]
# Brute-force protection: one doc per (email + client IP) counting recent failed sign-ins.
login_attempts_col = sync_db["console_login_attempts"]

MIN_PASSWORD_LEN = 8          # minimum password length (was 6)
MAX_LOGIN_FAILS = 8           # failed attempts before a temporary lockout
LOGIN_LOCK_SECONDS = 900      # lockout window: 15 minutes
# A real (expensive) hash to run on the no-such-user login path so response timing doesn't reveal
# whether an email exists. Computed once at import.
_DUMMY_HASH = generate_password_hash("cmt-timing-equalizer")


@console_auth_bp.after_request
def _auth_headers(resp):
    """Never cache auth responses, and add baseline hardening headers."""
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _client_ip() -> str:
    xff = request.headers.get("X-Forwarded-For", "")
    return (xff.split(",")[-1].strip() if xff else (request.remote_addr or "")) or "?"   # last hop = what the proxy saw


def _attempt_id(email: str) -> str:
    # Key the lockout on the EMAIL only. Keying on client IP would be bypassable: behind Railway's
    # proxy the only IP we can see comes from the client-supplied X-Forwarded-For header, which an
    # attacker rotates per request to dodge the counter. Per-email means a brute-force against one
    # account is always throttled. (Trade-off: someone can lock a known email for the window; for a
    # 7-person internal tool that's acceptable, and an admin can reset the password.)
    return (email or "?").strip().lower()


def _login_locked_for(email: str) -> int:
    """Seconds remaining on a lockout for this email+IP, or 0 if not locked. Auto-clears a stale one."""
    try:
        d = login_attempts_col.find_one({"_id": _attempt_id(email)})
    except Exception:
        return 0
    if d and d.get("count", 0) >= MAX_LOGIN_FAILS and d.get("last"):
        elapsed = (datetime.utcnow() - d["last"]).total_seconds()
        if elapsed < LOGIN_LOCK_SECONDS:
            return int(LOGIN_LOCK_SECONDS - elapsed)
        login_attempts_col.delete_one({"_id": _attempt_id(email)})   # window passed -> reset
    return 0


def _login_fail(email: str):
    try:
        login_attempts_col.update_one(
            {"_id": _attempt_id(email)},
            {"$inc": {"count": 1}, "$set": {"last": datetime.utcnow()}},
            upsert=True,
        )
    except Exception as e:
        logger.warning("[ConsoleAuth] could not record login failure: %s", e)


def _login_reset(email: str):
    try:
        login_attempts_col.delete_one({"_id": _attempt_id(email)})
    except Exception as _e:
        logger.debug("ignored: %s", _e)


def _new_session_for(user):
    """Start a fresh signed session for the user (rotates the cookie -> no session fixation)."""
    session.clear()
    session["uid"] = str(user["_id"])
    session["sv"] = _session_version(user)
    session.permanent = True


def _session_version(user) -> int:
    """Every signed cookie carries the user's session version. Bumping it (sign-out, password change,
    password reset by an admin) makes every cookie issued before invalid, including a stolen copy."""
    try:
        return int((user or {}).get("session_version") or 0)
    except (TypeError, ValueError):
        return 0


def _bump_session_version(user_id) -> int:
    """Invalidate all of a user's existing sessions. Returns the new version."""
    doc = users_col.find_one_and_update({"_id": user_id}, {"$inc": {"session_version": 1}},
                                        projection={"session_version": 1}, return_document=True)
    _user_cache.clear()
    return _session_version(doc)

# Bootstrap admin (the team lead). Seeded once with NO password; first sign-in sets it.
BOOTSTRAP_ADMIN = {
    "email": "o.teleshko@boosteroid.com",
    "name": "Oleg T.",
    "initials": "OT",
    "role": "admin",
    "title": "Community Team Lead",
    "hours": "Mon-Fri 09:00-18:00 (Europe/Kiev)",
    "permissions": ["reddit", "discord", "posts", "jira", "actions", "admin"],
}
# One permission per console section (see NAV in app.js). "admin" also unlocks the Admin tab.
ALL_PERMS = ["reddit", "posts", "reddit_comments", "discord", "facebook", "telegram", "jira",
             "known", "gamecards", "maintenance", "wishlist", "actions", "schedule", "admin"]
# New members get every section except Admin by default; an admin can then restrict.
DEFAULT_PERMS = ["reddit", "posts", "reddit_comments", "discord", "facebook", "telegram", "jira",
                 "known", "gamecards", "maintenance", "wishlist", "actions", "schedule"]
# Sections added AFTER the first permission backfill. Existing members had implicit access to these
# (Maintenance was ungated; Reddit Comments rode on "posts"), so a second one-time wave grants them to
# everyone (additively) - see migrate_permissions - instead of silently hiding the tabs.
_NEW_PERMS_V2 = ["maintenance", "reddit_comments"]
# Third wave: the Wishlist tab (a new section, granted once to every existing member like the v2 wave).
_NEW_PERMS_V3 = ["wishlist"]


def ensure_bootstrap():
    """Create the bootstrap admin (no password) if the collection is empty."""
    try:
        if users_col.count_documents({}) == 0:
            invite = secrets.token_urlsafe(9)
            doc = dict(BOOTSTRAP_ADMIN)
            doc.update({"password_hash": None, "invite_token": invite, "created_at": datetime.utcnow()})
            users_col.insert_one(doc)
            # The invite code lives ONLY in this server log (nobody else can read it), so the first
            # "set your password" is protected against anyone else claiming the account first.
            logger.info("[ConsoleAuth] Seeded bootstrap admin %s. First-run invite code: %s",
                        doc["email"], invite)
    except Exception as e:
        logger.error("[ConsoleAuth] ensure_bootstrap failed: %s", e)


def migrate_permissions():
    """One-time, idempotent backfill run once at process start.

    Until per-section permissions were enforced, every signed-in member saw every section regardless of
    their stored `permissions` list. Now that the nav and API enforce them, an old member whose list
    predates the new sections (facebook/telegram/known/gamecards/schedule, and jira for some) would
    suddenly lose access. To avoid that, grant each existing NON-admin member the full default set (union
    with whatever they already have) so their current visibility is preserved. Admins are untouched - they
    implicitly hold every permission. From here on an admin can *remove* sections per user in the Rights
    editor; this only ever ADDS, and only writes a user whose set actually changed.
    """
    try:
        changed = 0
        # ONCE per user: only members never backfilled before (no perms_migrated flag). After the first
        # pass a member is marked migrated and never touched again - otherwise a perm an admin removes would
        # be re-added on the next restart (the exact bug: restrictions didn't stick).
        for u in users_col.find({"role": {"$ne": "admin"}, "perms_migrated": {"$ne": True}}, {"permissions": 1}):
            cur = list(u.get("permissions") or [])
            merged = cur + [p for p in DEFAULT_PERMS if p not in cur]
            users_col.update_one({"_id": u["_id"]},
                                 {"$set": {"permissions": merged, "perms_migrated": True}})
            changed += 1
        if changed:
            logger.info("[ConsoleAuth] permission backfill: migrated %d member(s) (one-time)", changed)
        # Second wave: newly-split sections (Maintenance, Reddit Comments). Granted ONCE per member
        # (perms_migrated_v2) and only additively, so nobody loses a tab they already used; an admin can
        # remove them afterwards. Independent of the v1 flag so already-migrated members are topped up.
        changed2 = 0
        for u in users_col.find({"role": {"$ne": "admin"}, "perms_migrated_v2": {"$ne": True}}, {"permissions": 1}):
            cur = list(u.get("permissions") or [])
            merged = cur + [p for p in _NEW_PERMS_V2 if p not in cur]
            users_col.update_one({"_id": u["_id"]},
                                 {"$set": {"permissions": merged, "perms_migrated_v2": True}})
            changed2 += 1
        if changed2:
            logger.info("[ConsoleAuth] permission backfill v2: topped up %d member(s) with new sections", changed2)
        changed3 = 0
        for u in users_col.find({"role": {"$ne": "admin"}, "perms_migrated_v3": {"$ne": True}}, {"permissions": 1}):
            cur = list(u.get("permissions") or [])
            merged = cur + [p for p in _NEW_PERMS_V3 if p not in cur]
            users_col.update_one({"_id": u["_id"]},
                                 {"$set": {"permissions": merged, "perms_migrated_v3": True}})
            changed3 += 1
        if changed3:
            logger.info("[ConsoleAuth] permission backfill v3: topped up %d member(s) with new sections", changed3)
    except Exception as e:
        logger.error("[ConsoleAuth] migrate_permissions failed: %s", e)


try:
    ensure_bootstrap()
    migrate_permissions()   # once per process start; idempotent
except Exception as _e:  # never break app import on a transient Mongo hiccup
    logger.debug("ignored: %s", _e)


# ---------------------------------------------------------------------------
# Shared helpers (imported by console_api.py)
# ---------------------------------------------------------------------------
def _initials(name: str) -> str:
    parts = [p for p in re.split(r"\s+", (name or "").strip()) if p]
    return ("".join(p[0] for p in parts[:2]) or "?").upper()


def _int_or(value, default=0):
    """Coerce to a non-negative int, else default (used for leave allowance/usage fields)."""
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


# Identity fields that link one console user to their accounts across every platform. `alias`
# is the unifying key (matches the .env alias, e.g. "o.teleshko"); the bot and console resolve
# "who did what" through these. All are optional and admin-editable; empty for now (populated
# later), so every reader must keep an .env fallback.
IDENTITY_FIELDS = ["alias", "display_name", "telegram_id", "jira_account_id",
                   "slack_id", "discord_id", "discord_name", "reddit_username",
                   "cloud_user_id"]   # the member's own Boosteroid User ID (Testing Session picker)


def _default_alias(email: str) -> str:
    return (email or "").split("@")[0]


def _public_user(doc: dict) -> dict:
    """User safe to send to the client (no password hash, no Reddit refresh token)."""
    out = {
        "id": str(doc["_id"]),
        "email": doc.get("email", ""),
        "name": doc.get("name", ""),
        "initials": doc.get("initials", ""),
        "role": doc.get("role", "member"),
        "title": doc.get("title", ""),
        "hours": doc.get("hours", ""),
        "schedule": doc.get("schedule", None),   # per-day working-hours picker (item X3); each day may
                                                 # carry test_start/test_end (the Testing sub-window)
        "schedule_member": doc.get("schedule_member", ""),   # calendar column this user maps to
        "leave": doc.get("leave", {}) or {},     # {vac_total, vac_used, sick_total, sick_used, renew, renew_note}
        # When on (default), this user's views OUTSIDE their Duty hours don't touch the team-shared read
        # state (so an off-hours peek doesn't mark chats read for whoever is actually on shift).
        "ignore_offduty_reads": bool(doc.get("ignore_offduty_reads", True)),
        "permissions": doc.get("permissions", []),
        "layout": doc.get("layout") or None,   # per-user context panel / menu customization
        "has_password": bool(doc.get("password_hash")),
        # Whether a first-run invite code is still pending (admins share it with the user). The
        # code itself is only ever returned once, from create-user / regenerate-invite - never here.
        "invite_pending": bool(doc.get("invite_token")),
    }
    for f in IDENTITY_FIELDS:
        out[f] = doc.get(f, "")
    if not out["alias"]:
        out["alias"] = _default_alias(out["email"])
    if not out["display_name"]:
        out["display_name"] = out["name"]
    return out


class AuthUnavailable(Exception):
    """The user store can't be read right now. NOT the same as "signed out"."""


@console_auth_bp.app_errorhandler(AuthUnavailable)
def _auth_unavailable(_e):
    return jsonify({"error": "Temporarily unavailable"}), 503


def current_user():
    """The signed-in user document, or None when signed out. A database hiccup raises AuthUnavailable
    (503) instead of returning None: answering 401 there would throw a valid user to the login screen."""
    uid = session.get("uid")
    if not uid:
        return None
    # One page load fires dozens of API calls that would each re-read this same user document from
    # Mongo. Keep it for a few seconds per process; any write through this blueprint clears the cache,
    # so a role/permission change or a deleted account applies on the next request.
    hit = _user_cache.get(uid)
    if hit and hit[0] > time.time():
        doc = hit[1]
    else:
        try:
            doc = users_col.find_one({"_id": ObjectId(uid)})
        except InvalidId:
            return None
        except Exception as e:
            logger.warning("[ConsoleAuth] user lookup failed: %s", e)
            raise AuthUnavailable()
        if len(_user_cache) > 500:
            _user_cache.clear()
        _user_cache[uid] = (time.time() + _USER_CACHE_TTL, doc)
    if doc is not None and _session_version(doc) != int(session.get("sv") or 0):
        return None          # signed out everywhere / password changed after this cookie was issued
    return doc


_USER_CACHE_TTL = 5
_user_cache = {}   # session uid -> (expires_at, user doc or None)


@console_auth_bp.after_request
def _drop_user_cache_on_write(resp):
    if request.method != "GET":
        _user_cache.clear()
    return resp


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if current_user():
            return fn(*args, **kwargs)
        return jsonify({"error": "Unauthorized"}), 401
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if u and u.get("role") == "admin":
            return fn(*args, **kwargs)
        return jsonify({"error": "Forbidden"}), 403
    return wrapper


def user_has_perm(u, perm) -> bool:
    """True if user doc `u` may access section `perm`. Admins implicitly hold every permission."""
    if not u:
        return False
    if u.get("role") == "admin":
        return True
    return perm in (u.get("permissions") or [])


def perm_required(perm):
    """Gate an endpoint on a single section permission (defence in depth behind the UI's nav filter).
    Admins always pass; a signed-in member needs `perm` in their list."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            u = current_user()
            if not u:
                return jsonify({"error": "Unauthorized"}), 401
            if user_has_perm(u, perm):
                return fn(*args, **kwargs)
            return jsonify({"error": "Forbidden"}), 403
        return wrapper
    return deco


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------
@console_auth_bp.route("/login", methods=["POST"])
def login():
    if os.getenv("CONSOLE_PASSWORD_LOGIN", "1") == "0":
        return jsonify({"error": "Password sign-in is turned off. Use Sign in with Google."}), 403
    ensure_bootstrap()
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    locked = _login_locked_for(email)
    if locked:
        mins = (locked + 59) // 60
        return jsonify({"error": "Too many attempts. Try again in %d minute%s." %
                        (mins, "" if mins == 1 else "s")}), 429

    user = users_col.find_one({"email": email})
    # First run (account exists but no password): send the client to the "set your password" screen,
    # which now also requires the admin-shared invite code, so this signal alone grants nothing.
    if user and not user.get("password_hash"):
        return jsonify({"needsPassword": True, "email": user["email"]}), 200
    # Generic message for both "no such account" and "wrong password" so the login form does not
    # confirm which emails exist (blocks account enumeration). A missing user still runs a hash
    # comparison-ish path timing-wise via the failure counter.
    if not user:
        check_password_hash(_DUMMY_HASH, password)   # equalize timing vs. the real-user path
        _login_fail(email)
        return jsonify({"error": "Invalid email or password"}), 401
    if not check_password_hash(user["password_hash"], password):
        _login_fail(email)
        return jsonify({"error": "Invalid email or password"}), 401

    _login_reset(email)
    _new_session_for(user)
    return jsonify(_public_user(user)), 200


@console_auth_bp.route("/set-password", methods=["POST"])
def set_password():
    """First-run password setup. Allowed only when the account has no password yet AND the caller
    presents the one-time invite code the admin shared out-of-band. Without the code this endpoint
    can't be used to hijack a freshly-created (password-less) account by anyone who knows the email."""
    if os.getenv("CONSOLE_PASSWORD_LOGIN", "1") == "0":
        return jsonify({"error": "Password sign-in is turned off. Use Sign in with Google."}), 403
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    invite = (data.get("invite") or data.get("code") or "").strip()

    locked = _login_locked_for(email)
    if locked:
        mins = (locked + 59) // 60
        return jsonify({"error": "Too many attempts. Try again in %d minute%s." %
                        (mins, "" if mins == 1 else "s")}), 429

    if len(password) < MIN_PASSWORD_LEN:
        return jsonify({"error": "Password must be at least %d characters" % MIN_PASSWORD_LEN}), 400

    user = users_col.find_one({"email": email})
    if not user or user.get("password_hash"):
        # Same generic response whether the account is missing or already has a password.
        return jsonify({"error": "Invalid invite code or account already set up"}), 400

    stored = user.get("invite_token") or ""
    if not stored or not invite or not secrets.compare_digest(invite, stored):
        _login_fail(email)
        return jsonify({"error": "Invalid invite code. Ask an admin for your invite code."}), 403

    _login_reset(email)
    users_col.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": generate_password_hash(password), "updated_at": datetime.utcnow()},
         "$unset": {"invite_token": ""}},   # invite is one-time
    )
    fresh = users_col.find_one({"_id": user["_id"]})
    _new_session_for(fresh)
    return jsonify(_public_user(fresh)), 200


@console_auth_bp.route("/change-password", methods=["POST"])
@login_required
def change_password():
    user = current_user()
    if not user:  # token-only caller has no user to change
        return jsonify({"error": "No session user"}), 400
    data = request.get_json(silent=True) or {}
    new = data.get("new") or ""
    if len(new) < MIN_PASSWORD_LEN:
        return jsonify({"error": "Password must be at least %d characters" % MIN_PASSWORD_LEN}), 400
    if user.get("password_hash") and not check_password_hash(user["password_hash"], data.get("current") or ""):
        return jsonify({"error": "Current password is wrong"}), 401
    users_col.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": generate_password_hash(new), "updated_at": datetime.utcnow()}},
    )
    session["sv"] = _bump_session_version(user["_id"])   # other devices are signed out, this one stays
    return jsonify({"ok": True}), 200


@console_auth_bp.route("/me", methods=["GET"])
def me():
    user = current_user()
    if not user:
        return jsonify({"error": "Not signed in"}), 401
    return jsonify(_public_user(user)), 200


@console_auth_bp.route("/account-prefs", methods=["PATCH"])
def account_prefs():
    """A user updates their own account preferences (self-service, not admin). Only whitelisted, non-
    sensitive fields - never role/permissions/identity (those stay admin-only via /users/<id>)."""
    u = current_user()
    if not u:
        return jsonify({"error": "Not signed in"}), 401
    data = request.get_json(silent=True) or {}
    upd = {}
    if "ignore_offduty_reads" in data:
        upd["ignore_offduty_reads"] = bool(data["ignore_offduty_reads"])
    if isinstance(data.get("layout"), dict):
        lay = {}
        for part in ("ctx", "nav"):
            src = data["layout"].get(part) or {}
            order = [str(x)[:40] for x in (src.get("order") or []) if isinstance(x, str)][:60]
            hidden = {str(k)[:40]: True for k, v in (src.get("hidden") or {}).items() if v}
            lay[part] = {"order": order, "hidden": dict(list(hidden.items())[:60])}
        upd["layout"] = lay
    if not upd:
        return jsonify({"error": "Nothing to update"}), 400
    upd["updated_at"] = datetime.utcnow()
    users_col.update_one({"_id": u["_id"]}, {"$set": upd})
    return jsonify(_public_user(users_col.find_one({"_id": u["_id"]}))), 200


@console_auth_bp.route("/logout", methods=["POST"])
def logout():
    """Sign out. Bumps the session version, so every cookie of this user stops working (all devices,
    and any copy of the cookie), not only the one in this browser."""
    uid = session.get("uid")
    if uid:
        try:
            _bump_session_version(ObjectId(uid))
        except Exception as e:
            logger.warning("[ConsoleAuth] sign-out could not end other sessions: %s", e)
    session.clear()
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# User management (admin only)
# ---------------------------------------------------------------------------
@console_auth_bp.route("/users", methods=["GET"])
@admin_required
def list_users():
    return jsonify([_public_user(u) for u in users_col.find({}).sort("created_at", 1)]), 200


@console_auth_bp.route("/team-roster", methods=["GET"])
@login_required
@live("roster", "/team-roster", ttl=20)
def team_roster():
    """Minimal team roster any signed-in user may read (the home "Team" tab): name + schedule + role,
    so everyone - not just admins - can see who's on the team, on shift, and online. Never exposes
    permissions, invite codes, password state, or Reddit tokens."""
    out = []
    for u in users_col.find({}).sort("name", 1):
        out.append({
            "id": str(u["_id"]),
            "email": u.get("email", ""),
            "name": u.get("name", ""),
            "display_name": u.get("display_name") or u.get("name", ""),
            "initials": u.get("initials", ""),
            "role": u.get("role", "member"),
            "schedule": u.get("schedule", None),
        })
    return jsonify(out), 200


@console_auth_bp.route("/users", methods=["POST"])
@admin_required
def create_user():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()
    if not email or not name:
        return jsonify({"error": "name and email are required"}), 400
    if users_col.find_one({"email": email}):
        return jsonify({"error": "A user with that email already exists"}), 409
    role = "admin" if data.get("role") == "admin" else "member"
    doc = {
        "email": email,
        "name": name,
        "initials": (data.get("initials") or _initials(name)),
        "role": role,
        "title": data.get("title") or "Community Team",
        "hours": data.get("hours") or "Mon-Fri 09:00-18:00 (Europe/Kiev)",
        "permissions": ALL_PERMS[:] if role == "admin" else DEFAULT_PERMS[:],
        "perms_migrated": True,  # created with an explicit permission set -> the startup backfill must skip it
        "perms_migrated_v2": True, "perms_migrated_v3": True,
        "alias": (data.get("alias") or _default_alias(email)),
        "display_name": (data.get("display_name") or name),
        "password_hash": None,  # user sets it on first sign-in, with the invite code below
        "invite_token": secrets.token_urlsafe(9),  # one-time code the admin shares out-of-band
        "created_at": datetime.utcnow(),
    }
    res = users_col.insert_one(doc)
    doc["_id"] = res.inserted_id
    out = _public_user(doc)
    out["invite"] = doc["invite_token"]   # returned once, so the admin can copy + share it
    return jsonify(out), 201


@console_auth_bp.route("/users/<uid>", methods=["PATCH"])
@admin_required
def update_user(uid):
    try:
        oid = ObjectId(uid)
    except InvalidId:
        return jsonify({"error": "Bad id"}), 400
    data = request.get_json(silent=True) or {}
    allowed = {}
    for key in ("name", "title", "hours", "initials"):
        if key in data:
            allowed[key] = data[key]
    if "schedule" in data and isinstance(data["schedule"], dict):   # per-day working hours (item X3)
        allowed["schedule"] = {
            str(k): {"on": bool((v or {}).get("on")),
                     "start": str((v or {}).get("start", ""))[:5],
                     "end": str((v or {}).get("end", ""))[:5],
                     # Testing sub-window inside the shift: no notifications, shown as "Testing" in Team.
                     "test_start": str((v or {}).get("test_start", ""))[:5],
                     "test_end": str((v or {}).get("test_end", ""))[:5]}
            for k, v in data["schedule"].items() if isinstance(v, dict)
        }
    if "schedule_member" in data:                    # binds this user to a calendar column
        allowed["schedule_member"] = (data["schedule_member"] or "").strip() if isinstance(data["schedule_member"], str) else ""
    if isinstance(data.get("leave"), dict):          # vacation / sick allowance + usage (admin-managed)
        lv = data["leave"]
        allowed["leave"] = {
            "vac_total": _int_or(lv.get("vac_total"), 0), "vac_used": _int_or(lv.get("vac_used"), 0),
            "sick_total": _int_or(lv.get("sick_total"), 0), "sick_used": _int_or(lv.get("sick_used"), 0),
            "renew": str(lv.get("renew", ""))[:20], "renew_note": str(lv.get("renew_note", ""))[:200],
        }
    for key in IDENTITY_FIELDS:                 # identity links (alias + per-platform accounts)
        if key in data:
            allowed[key] = (data[key] or "").strip() if isinstance(data[key], str) else data[key]
    if "permissions" in data and isinstance(data["permissions"], list):
        perms = [p for p in data["permissions"] if p in ALL_PERMS]
        # Don't let the last admin be demoted to member - that would leave zero admins and lock
        # everyone out of user management / config (recoverable only by editing Mongo directly).
        target = users_col.find_one({"_id": oid})
        if (target and target.get("role") == "admin" and "admin" not in perms
                and users_col.count_documents({"role": "admin"}) <= 1):
            return jsonify({"error": "Cannot remove admin rights from the last admin"}), 400
        allowed["permissions"] = perms
        allowed["role"] = "admin" if "admin" in perms else "member"
        allowed["perms_migrated"] = True   # an explicit admin edit freezes the user from the startup backfill
        allowed["perms_migrated_v2"] = allowed["perms_migrated_v3"] = True
    if not allowed:
        return jsonify({"error": "Nothing to update"}), 400
    allowed["updated_at"] = datetime.utcnow()
    res = users_col.update_one({"_id": oid}, {"$set": allowed})
    if res.matched_count == 0:
        return jsonify({"error": "User not found"}), 404
    return jsonify(_public_user(users_col.find_one({"_id": oid}))), 200


@console_auth_bp.route("/users/<uid>", methods=["DELETE"])
@admin_required
def delete_user(uid):
    try:
        oid = ObjectId(uid)
    except InvalidId:
        return jsonify({"error": "Bad id"}), 400
    me_user = current_user()
    if me_user and me_user["_id"] == oid:
        return jsonify({"error": "You cannot delete your own account"}), 400
    target = users_col.find_one({"_id": oid})
    if not target:
        return jsonify({"error": "User not found"}), 404
    if target.get("role") == "admin" and users_col.count_documents({"role": "admin"}) <= 1:
        return jsonify({"error": "Cannot delete the last admin"}), 400
    users_col.delete_one({"_id": oid})
    return jsonify({"ok": True}), 200


@console_auth_bp.route("/users/<uid>/password", methods=["POST"])
@admin_required
def admin_set_password(uid):
    """Admin sets/resets any user's password directly (no current-password needed)."""
    try:
        oid = ObjectId(uid)
    except InvalidId:
        return jsonify({"error": "Bad id"}), 400
    data = request.get_json(silent=True) or {}
    pw = data.get("password") or ""
    if len(pw) < MIN_PASSWORD_LEN:
        return jsonify({"error": "Password must be at least %d characters" % MIN_PASSWORD_LEN}), 400
    res = users_col.update_one(
        {"_id": oid},
        {"$set": {"password_hash": generate_password_hash(pw), "updated_at": datetime.utcnow()},
         "$unset": {"invite_token": ""}},   # a direct reset clears any pending invite
    )
    if res.matched_count == 0:
        return jsonify({"error": "User not found"}), 404
    _bump_session_version(oid)   # whoever held the old password is signed out
    return jsonify({"ok": True}), 200


@console_auth_bp.route("/users/<uid>/invite", methods=["POST"])
@admin_required
def regenerate_invite(uid):
    """Admin mints a fresh one-time invite code for a user who hasn't set a password yet, then shares
    it with them out-of-band. Returned exactly once here; never exposed by any GET."""
    try:
        oid = ObjectId(uid)
    except InvalidId:
        return jsonify({"error": "Bad id"}), 400
    target = users_col.find_one({"_id": oid})
    if not target:
        return jsonify({"error": "User not found"}), 404
    if target.get("password_hash"):
        return jsonify({"error": "This user already set a password"}), 409
    invite = secrets.token_urlsafe(9)
    users_col.update_one({"_id": oid}, {"$set": {"invite_token": invite, "updated_at": datetime.utcnow()}})
    return jsonify({"ok": True, "invite": invite, "email": target.get("email", "")}), 200
