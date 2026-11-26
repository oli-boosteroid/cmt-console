"""
Console state - write layer for console-owned data.

Notes and tags live in NEW collections the console owns (`console_notes`, `console_tags`).
They are NOT bot data, so writing them never affects the bot. Everything is attributed to
the signed-in console user and gated by `login_required`.

Tags are stored one document per (context_type, ref, tag) so add == upsert and
remove == delete-one.
"""
import hashlib
import json
import os
import logging
import re
import time
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request
from bson import ObjectId
from bson.errors import InvalidId
from pymongo.errors import DuplicateKeyError

from api.routes.console_db import sync_db, snapshot_db
from api.routes.console_auth import login_required, admin_required, current_user, user_has_perm, perm_required
from api.routes import console_live
from api.routes.console_live import live

logger = logging.getLogger(__name__)

console_state_bp = Blueprint("console_state", __name__, url_prefix="/api/console")
console_state_bp.after_request(console_live.after_write)


@console_state_bp.after_request
def _state_headers(resp):
    """Security headers on every write-API response, and conditional GETs: unchanged JSON lists
    return a bodiless 304 (the browser reuses its cached copy), so the 45s auto-refresh poll costs
    almost no egress until data actually changes. This is the main Railway-traffic saver."""
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    if request.method == "GET" and resp.status_code == 200 and resp.mimetype == "application/json":
        resp.headers["Cache-Control"] = "no-cache, private"   # always revalidate; allow 304 shortcut
        resp.add_etag()
        return resp.make_conditional(request)
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


notes_col = sync_db["console_notes"]
issues_col = sync_db["issues"]                    # tags now live in the shared `issues` store so
                                                  # they feed the bot's daily TL-tags report

# The /tags GET scans the shared (large) `issues` store TWICE - once for console tags, once to merge
# Slack tags - which is slow, and it runs on every hydrate + every 30s refresh for every operator, so it
# dominates the cluster load. Cache the computed list briefly; a tag add/remove busts it immediately, so
# the writer sees their change at once and everyone else within the TTL.
_TAGS_TTL = 30
_tags_cache = {"at": 0.0, "val": None}


def _bust_tags_cache():
    _tags_cache["val"] = None
actions_col = sync_db["console_actions"]
reports_col = sync_db["console_reports"]
config_col = sync_db["console_config"]
templates_col = sync_db["console_templates"]
handoffs_col = sync_db["console_handoffs"]
testing_col = sync_db["testing_sessions"]         # the SHARED testing store the 08:00 daily report
                                                  # reads (collect_and_send_testing_sessions) - the
                                                  # console writes the exact Slack schema into it
post_flags_col = sync_db["console_post_flags"]    # per-post site flags (e.g. Ignored)
convo_status_col = sync_db["console_convo_status"]  # per-convo manual status override 
convo_replied_col = sync_db["console_convo_replied"]  # convos we've publicly replied to (item W3)
activity_col = sync_db["console_activity"]          # shared team action feed (item W9)
presence_col = sync_db["console_presence"]          # live "who's on the console now" heartbeat (agents tab)
ki_suggestions_col = sync_db["known_issues_suggestions"]  # regular-user suggestions awaiting admin approval
feedback_col = sync_db["console_feedback"]          # in-app Suggestion/Bug feedback (item Y)
post_jira_col = sync_db["console_post_jira"]        # Reddit post <-> Jira links, console-only (item W4)
jira_user_col = sync_db["jira_user_links"]          # User ID <-> Jira links (Quick Actions > Link Ticket); the bot's L1 follow-ups read it
discord_tickets_col = sync_db["discord_tickets"]    # bot-owned; we add Jira links to jira_ticket_keys (W4)
reads_col = sync_db["console_reads"]              # SHARED read state for the Inbox (items S6/S7)
fb_notes_col = sync_db["console_fb_notes"]        # Facebook Notes (item T8), console-only
leave_requests_col = sync_db["console_leave_requests"]  # Vacation / Sick Leave requests + approvals
# Bot collections the console also writes directly (data writes, no Reddit/Discord API call):
emails_col = sync_db["users_emails"]              # Add Email -> feeds the bot's email readers
mod_notes_col = sync_db["reddit_mod_notes"]       # Add Jira link -> jira_convos display link
# Per-user notification system (settings live here; the bot's delivery engine reads them):
notify_prefs_col = sync_db["console_notify_prefs"]   # one doc per user: types + channels + schedule
push_subs_col = sync_db["console_push_subs"]         # one doc per browser/device (Web Push)
notify_links_col = sync_db["console_notify_links"]   # short-lived Telegram deep-link tokens
notify_feed_col = sync_db["console_notify_feed"]     # in-app notification center (bell); bot writes, console reads

# Notification event types the user can subscribe to, and the delivery channels.
NOTIFY_TYPES = ["reddit_post", "reddit_modmail", "reddit_modmail_msg",
                "discord_ticket", "discord_msg", "discord_forum", "discord_mod_mention",
                "jira_cm", "jira_urg_review", "jira_l1",
                "feedback_new", "leave_request", "ki_suggest"]
_ADMIN_EVENT_TYPES = {"feedback_new", "leave_request", "ki_suggest"}   # admin-only notify events (default OFF, admins only)
NOTIFY_CHANNELS = ["telegram", "slack", "webpush"]
_WEEKDAYS = ["0", "1", "2", "3", "4", "5", "6"]   # Mon..Sun (matches the working-hours picker)


def _ensure_notify_indexes():
    """Indexes for the notification collections. Idempotent; safe to run on every import (both the
    Railway console and the bot import this module). The TTL on notify links makes a Telegram
    'connect' token self-destruct 15 minutes after it is minted, closing the leak window."""
    specs = [
        (notify_prefs_col, "user_email", {}),
        (notify_prefs_col, "enabled", {}),   # notify_event fans out over enabled prefs on every event
        (push_subs_col, "endpoint", {}),
        (push_subs_col, "user_email", {}),
        (notify_links_col, "token", {}),
        (notify_links_col, "created_at", {"expireAfterSeconds": 900}),
        # Notification-center feed: index for newest-first reads + a 30-day TTL so it self-prunes.
        (notify_feed_col, "created_at", {"expireAfterSeconds": 2592000}),
    ]
    for col, field, opts in specs:
        try:
            col.create_index(field, **opts)
        except Exception as e:
            logger.debug("[ConsoleState] index %s skipped: %s", field, e)
    # Feed read is find({type: {$in: ...}}).sort(created_at desc) - a compound index serves both.
    try:
        notify_feed_col.create_index([("type", 1), ("created_at", -1)])
    except Exception as e:
        logger.debug("[ConsoleState] feed compound index skipped: %s", e)


try:
    _ensure_notify_indexes()
except Exception as _e:
    logger.warning("ignored: %s", _e)

# Actions the console may enqueue for the bot worker to execute.
_ACTION_TYPES = {"ping", "reddit_note", "reddit_reply", "reddit_archive", "reddit_highlight",
                 "reddit_post_reply", "discord_reply", "discord_status", "discord_postpone",
                 "maintenance_notify", "maintenance_end", "maintenance_sheet_add", "report", "create_so_ticket", "create_urgent",
                 "add_suggestion", "add_proposal", "telegram_reply",
                 "known_issues_add", "known_issues_set_canned", "known_issues_update", "known_issues_sync", "game_list_sync",
                 "schedule_set", "schedule_create_month", "schedule_sync",
                 "game_cards_generate", "game_cards_set", "game_cards_set_row", "game_cards_create_week", "game_cards_sync", "game_cards_delete", "game_testing_set", "game_testing_sync",
                 "jira_todo", "discord_mention_email", "discord_jira_link",
                 "notify_user_dm",
                 "cloud_user_lookup", "cloud_sessions", "wishlist_set_status"}

# Section-exclusive write actions: a member must hold the section's permission to enqueue them (defence in
# depth behind the UI's nav filter). Only actions initiated solely from within one section are listed here;
# cross-section flows (ticket creation, maintenance, reports, suggestions) stay login-only so they don't break
# for a member who lacks the destination section. Admins implicitly pass (user_has_perm returns True). The
# schedule/known-issues writes keep their stricter admin-only gate below.
_ACTION_PERM = {
    "reddit_note": "reddit", "reddit_reply": "reddit", "reddit_archive": "reddit", "reddit_highlight": "reddit",
    "reddit_post_reply": "posts",
    "discord_reply": "discord", "discord_status": "discord", "discord_postpone": "discord", "discord_jira_link": "discord",
    "telegram_reply": "telegram",
    "game_cards_generate": "gamecards", "game_cards_set": "gamecards", "game_cards_set_row": "gamecards",
    "game_cards_create_week": "gamecards", "game_cards_sync": "gamecards", "game_cards_delete": "gamecards",
    "game_testing_set": "gamecards", "game_testing_sync": "gamecards",
    "jira_todo": "jira", "discord_mention_email": "discord",
    "wishlist_set_status": "wishlist",
}


def _payload_files_b64_len(payload):
    """Total base64 length of the files carried in a ticket-create payload (SO or URG)."""
    total = 0
    for f in (payload.get("files") or []):
        total += len(f.get("b64") or "")
    for flist in (payload.get("files_by_block") or {}).values():
        for f in (flist or []):
            total += len(f.get("b64") or "")
    return total


def _action_public(d):
    return {
        "id": str(d["_id"]),
        "type": d.get("type", ""),
        "status": d.get("status", ""),
        "result": d.get("result"),
        "error": d.get("error"),
        "requested_by": d.get("author_name", ""),
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
        "finished_at": d["finished_at"].isoformat() if d.get("finished_at") else None,
    }


_DEDUP_SECONDS = 15


def _action_fingerprint(atype, payload, author_email):
    """Stable hash of what an action does and who asked for it (used to drop double submits)."""
    body = json.dumps({"t": atype, "p": payload, "a": author_email}, sort_keys=True, default=str)
    return hashlib.sha1(body.encode("utf-8")).hexdigest()


def _who():
    u = current_user() or {}
    return {"author_email": u.get("email", ""), "author_name": u.get("name") or u.get("email", "")}


def _created_by():
    """The `created_by` value Slack stores on every issue doc (its slack username). The console
    uses the email local-part, which matches the team's slack handles (firstname.lastname), so
    console tags are attributed the same way Slack tags are in the per-user stats."""
    u = current_user() or {}
    email = u.get("email", "")
    return email.split("@")[0] if email else (u.get("name") or "console")


def _jira_key_from_url(url):
    """Extract a Jira issue key (e.g. ABC-123) from any URL, or None."""
    if not url:
        return None
    m = re.search(r"([A-Z][A-Z0-9]+-\d+)", str(url).upper())
    return m.group(1) if m else None


def _note_public(d):
    return {
        "id": str(d["_id"]),
        "context_type": d.get("context_type", "general"),
        "ref": d.get("ref", ""),
        "refLabel": d.get("refLabel", ""),
        "text": d.get("text", ""),
        "author": d.get("author_name", ""),
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
    }


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------
@console_state_bp.route("/notes", methods=["GET"])
@login_required
@live("notes", "/notes", ttl=10)
def list_notes():
    docs = notes_col.find({}).sort("created_at", -1).limit(2000)
    return jsonify([_note_public(d) for d in docs]), 200


@console_state_bp.route("/notes", methods=["POST"])
@login_required
def add_note():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    doc = {
        "context_type": data.get("context_type") or "general",
        "ref": str(data.get("ref") or ""),
        "refLabel": data.get("label") or data.get("refLabel") or "",
        "text": text,
        "created_at": datetime.utcnow(),
    }
    doc.update(_who())
    doc["_id"] = notes_col.insert_one(doc).inserted_id
    return jsonify(_note_public(doc)), 201


@console_state_bp.route("/notes/<note_id>", methods=["PATCH"])
@login_required
def update_note(note_id):
    try:
        oid = ObjectId(note_id)
    except (InvalidId, Exception):
        return jsonify({"error": "Bad id"}), 400
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    res = notes_col.update_one({"_id": oid}, {"$set": {"text": text, "updated_at": datetime.utcnow()}})
    if res.matched_count == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True}), 200


@console_state_bp.route("/notes/<note_id>", methods=["DELETE"])
@login_required
def del_note(note_id):
    try:
        oid = ObjectId(note_id)
    except (InvalidId, Exception):
        return jsonify({"error": "Bad id"}), 400
    notes_col.delete_one({"_id": oid})
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Tags - UNIFIED with the bot's `issues` store, BOTH ways:
#   - Write: one console tag = one issue doc {source:"console", context_type, ref, tag, tags:[tag],
#     platform, post_url|ticket_url, created_by, created_at, author}. It carries `tags` +
#     post_url/ticket_url + created_by exactly like Slack, so it feeds the daily/TL tag reports and
#     the per-user stats the same way a Slack tag does.
#   - Read (list_tags): returns console tags AND Slack-created tags (mapped onto objects by URL),
#     so tags set in Slack are visible in the console too.
# ---------------------------------------------------------------------------
def _tag_report_url(ctx, ref):
    """The URL the daily TL report should show for a tagged object."""
    if ctx == "post":
        try:
            doc = snapshot_db["reddit_posts_snapshot"].find_one({"post_id": ref}, {"url": 1, "_id": 0})
            return (doc or {}).get("url", "") or ""
        except Exception:
            return ""
    if ctx == "convo":
        return "https://mod.reddit.com/mail/all/" + ref
    return ""


@console_state_bp.route("/tags", methods=["GET"])
@login_required
@live("tags", "/tags", ttl=6)
def list_tags():
    # Return BOTH console-created tags AND Slack-created tags, as a flat list of
    # {context_type, ref, tag} the frontend attaches onto posts/convos/tickets (applyTags).
    #   - Console docs carry context_type/ref directly.
    #   - Slack docs have no context: map them onto objects by URL (Reddit post_url == snapshot url
    #     exactly; modmail URL pattern; Discord via the Jira key on the ticket, best-effort).
    # So a tag added in Slack now shows up in the console too.
    now = time.time()
    if _tags_cache["val"] is not None and (now - _tags_cache["at"]) < _TAGS_TTL:
        return jsonify(_tags_cache["val"]), 200
    # One schema (services/issue_tags.py): every tag record, from Slack or the console, carries its chat
    # (context_type / ref) and its tags[]. Old Slack records got their chat in migration step 5.
    seen = set()
    out = []
    for d in issues_col.find({"context_type": {"$exists": True}, "tags": {"$exists": True, "$ne": []}},
                             {"context_type": 1, "ref": 1, "tags": 1, "_id": 0}).sort("created_at", -1).limit(12000):
        ctx, ref = d.get("context_type") or "", str(d.get("ref") or "")
        for tag in (d.get("tags") or []):
            k = (ctx, ref, tag)
            if ctx and ref and tag and k not in seen:
                seen.add(k)
                out.append({"context_type": ctx, "ref": ref, "tag": tag})

    _tags_cache["val"] = out
    _tags_cache["at"] = time.time()
    return jsonify(out), 200


@console_state_bp.route("/tags", methods=["POST"])
@login_required
def add_tag():
    data = request.get_json(silent=True) or {}
    tag = str(data.get("tag") or "").strip()
    ctx = str(data.get("context_type") or "")   # str() so a dict can't inject a Mongo operator
    ref = str(data.get("ref") or "")
    if not tag or not ctx:
        return jsonify({"error": "context_type and tag are required"}), 400
    key = {"source": "console", "context_type": ctx, "ref": ref, "tag": tag}
    url = _tag_report_url(ctx, ref)
    set_on_insert = {
        "tags": [tag],                                   # report reads `tags`
        "platform": "Discord" if ctx == "ticket" else "Reddit",
        ("ticket_url" if ctx == "ticket" else "post_url"): url,
        "created_by": _created_by(),                      # parity with Slack (per-user stats)
        "created_at": datetime.utcnow(),
    }
    set_on_insert.update(_who())
    issues_col.update_one(key, {"$setOnInsert": set_on_insert}, upsert=True)
    _bust_tags_cache()   # the adder sees their tag immediately; others within the TTL
    return jsonify({"ok": True}), 201


@console_state_bp.route("/tags", methods=["DELETE"])
@login_required
def del_tag():
    # Removes a tag wherever it was added: a console record (one tag per record) is deleted; a Slack
    # record keeps its other tags and its platform entry for the daily report, only this tag goes.
    ctx = request.args.get("context_type") or ""
    ref = str(request.args.get("ref") or "")
    tag = request.args.get("tag") or ""
    if not tag or not ctx:
        return jsonify({"error": "context_type and tag are required"}), 400
    issues_col.delete_one({"source": "console", "context_type": ctx, "ref": ref, "tag": tag})
    issues_col.update_many({"source": {"$ne": "console"}, "context_type": ctx, "ref": ref, "tags": tag},
                           {"$pull": {"tags": tag}})
    _bust_tags_cache()
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Reddit post flags: "Ignore" marks a post as intentionally left without a reply
# (a decision was made not to answer). An ignored post counts as closed - it drops
# out of the No-reply queue, same as a replied one. Site-only, persisted here.
# ---------------------------------------------------------------------------
@console_state_bp.route("/post-flags", methods=["GET"])
@login_required
@live("flags", "/post-flags", ttl=6)
def list_post_flags():
    ids, meta = [], {}
    for d in post_flags_col.find({"ignored": True}, {"post_id": 1, "ignore_reason": 1, "author_name": 1, "_id": 0}):
        pid = d.get("post_id")
        if not pid:
            continue
        ids.append(pid)
        meta[pid] = {"reason": d.get("ignore_reason", ""), "by": d.get("author_name", "")}   # who ignored it + why
    return jsonify({"ignored": ids, "meta": meta}), 200


@console_state_bp.route("/post-flags", methods=["POST"])
@login_required
def set_post_flag():
    data = request.get_json(silent=True) or {}
    post_id = (data.get("post_id") or "").strip()
    if not post_id:
        return jsonify({"error": "post_id is required"}), 400
    ignored = bool(data.get("ignored", True))
    reason = (data.get("reason") or "").strip()
    doc = {"post_id": post_id, "ignored": ignored, "updated_at": datetime.utcnow(),
           "ignore_reason": reason if ignored else ""}   # record why a post was ignored 
    doc.update(_who())
    post_flags_col.update_one({"post_id": post_id},
                              {"$set": doc, "$setOnInsert": {"created_at": datetime.utcnow()}}, upsert=True)
    return jsonify({"ok": True, "ignored": ignored, "ignore_reason": doc["ignore_reason"]}), 200


# ---------------------------------------------------------------------------
# Reddit ModMail manual status override. Statuses are mostly DERIVED from the message
# flow in the frontend; this only stores a mod's explicit override: "in_progress" (actively
# working, e.g. waiting on L2) or "done". Empty string clears it (back to auto).
# ---------------------------------------------------------------------------
_CONVO_OVERRIDES = {"", "new", "needs_review", "waiting_user", "in_progress", "postponed", "done"}


@console_state_bp.route("/convo-status", methods=["GET"])
@login_required
@live("cstatus", "/convo-status", ttl=6)
def list_convo_status():
    # `overrides_at` is when each override was set (updated_at). The frontend uses it as an ACK marker so
    # an explicit "Waiting on user" sticks even if the user spoke last, and only flips to Needs Review
    # when the user writes AFTER we set it.
    out, out_at = {}, {}
    for d in convo_status_col.find({"status": {"$nin": [None, ""]}},
                                   {"convo_id": 1, "status": 1, "updated_at": 1, "_id": 0}):
        cid = d.get("convo_id")
        if not cid:
            continue
        out[cid] = d.get("status", "")
        ua = d.get("updated_at")
        out_at[cid] = ua.isoformat() if hasattr(ua, "isoformat") else (ua or "")
    return jsonify({"overrides": out, "overrides_at": out_at}), 200


@console_state_bp.route("/convo-status", methods=["POST"])
@login_required
def set_convo_status():
    data = request.get_json(silent=True) or {}
    convo_id = (data.get("convo_id") or "").strip()
    status = (data.get("status") or "").strip()
    if not convo_id:
        return jsonify({"error": "convo_id is required"}), 400
    if status not in _CONVO_OVERRIDES:
        return jsonify({"error": "bad status"}), 400
    doc = {"convo_id": convo_id, "status": status, "updated_at": datetime.utcnow()}
    doc.update(_who())
    convo_status_col.update_one({"convo_id": convo_id},
                                {"$set": doc, "$setOnInsert": {"created_at": datetime.utcnow()}}, upsert=True)
    return jsonify({"ok": True, "status": status}), 200


# ---------------------------------------------------------------------------
# Replied convos (item W3): the set of Reddit ModMail convos we've publicly replied to. The bot's
# snapshot `mod_replied` lags after a reply, so the LIST row would briefly show "New" again; this
# remembers our reply so the derived status stays "Waiting on user" across refresh + reload. We only
# ever record that a reply happened (mod_replied is permanently true once we've answered).
# ---------------------------------------------------------------------------
@console_state_bp.route("/convo-replied", methods=["GET"])
@login_required
@live("replied", "/convo-replied", ttl=6)
def list_convo_replied():
    convos = [d.get("convo_id") for d in convo_replied_col.find({}, {"convo_id": 1, "_id": 0})]
    return jsonify({"convos": [c for c in convos if c]}), 200


@console_state_bp.route("/convo-replied", methods=["POST"])
@login_required
def set_convo_replied():
    data = request.get_json(silent=True) or {}
    convo_id = (data.get("convo_id") or "").strip()
    if not convo_id:
        return jsonify({"error": "convo_id is required"}), 400
    doc = {"convo_id": convo_id, "replied_at": datetime.utcnow()}
    doc.update(_who())
    convo_replied_col.update_one({"convo_id": convo_id},
                                 {"$set": doc, "$setOnInsert": {"created_at": datetime.utcnow()}}, upsert=True)
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Facebook group "last checked" (item W7): a single shared record of who last opened the FB group
# from the console and when, so the team can see when it was last reviewed.
# ---------------------------------------------------------------------------
@console_state_bp.route("/fb-group-check", methods=["GET"])
@login_required
@live("fbcheck", "/fb-group-check", ttl=20)
def get_fb_group_check():
    d = config_col.find_one({"key": "fb_group_check"}) or {}
    return jsonify({"by": d.get("by", ""), "at": d.get("at").isoformat() if d.get("at") else ""}), 200


@console_state_bp.route("/fb-group-check", methods=["POST"])
@login_required
def set_fb_group_check():
    u = current_user() or {}
    now = datetime.utcnow()
    config_col.update_one({"key": "fb_group_check"},
                          {"$set": {"key": "fb_group_check", "by": u.get("name") or u.get("email", ""), "at": now}},
                          upsert=True)
    return jsonify({"ok": True, "by": u.get("name") or u.get("email", ""), "at": now.isoformat()}), 200


# ---------------------------------------------------------------------------
# Reminders + Discord-forums config (Admin), and Discord mention triage status.
# ---------------------------------------------------------------------------
_APPS_SCRIPT_URL = re.compile(
    r"^https://script\.google\.com/(?:a/macros/[A-Za-z0-9.-]+|macros)/s/[A-Za-z0-9_-]{10,200}/(?:exec|dev)$")


def _bad_webapp_url(data):
    """An error response when the posted config carries a web-app URL that is not a Google Apps Script
    address (the bot refuses such URLs too, services/apps_script_url.py), else None."""
    url = str((data or {}).get("webapp_url") or "").strip()
    if url and not _APPS_SCRIPT_URL.match(url):
        return jsonify({"error": "Web app URL must look like https://script.google.com/macros/s/.../exec"}), 400
    return None


@console_state_bp.route("/reminders-config", methods=["POST"])
@admin_required
def set_reminders_config():
    data = request.get_json(silent=True) or {}
    config_col.update_one({"key": "reminders"}, {"$set": {"key": "reminders", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/forums-config", methods=["POST"])
@admin_required
def set_forums_config():
    data = request.get_json(silent=True) or {}
    config_col.update_one({"key": "discord_forums"}, {"$set": {"key": "discord_forums", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/known-issues-config", methods=["POST"])
@admin_required
def set_known_issues_config():
    data = request.get_json(silent=True) or {}
    bad = _bad_webapp_url(data)
    if bad:
        return bad
    config_col.update_one({"key": "known_issues"}, {"$set": {"key": "known_issues", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/game-list-config", methods=["POST"])
@admin_required
def set_game_list_config():
    data = request.get_json(silent=True) or {}
    bad = _bad_webapp_url(data)
    if bad:
        return bad
    config_col.update_one({"key": "game_list"}, {"$set": {"key": "game_list", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/schedule-config", methods=["POST"])
@admin_required
def set_schedule_config():
    data = request.get_json(silent=True) or {}
    bad = _bad_webapp_url(data)
    if bad:
        return bad
    config_col.update_one({"key": "schedule"}, {"$set": {"key": "schedule", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/game-cards-config", methods=["POST"])
@admin_required
def set_game_cards_config():
    data = request.get_json(silent=True) or {}
    bad = _bad_webapp_url(data)
    if bad:
        return bad
    config_col.update_one({"key": "game_cards"}, {"$set": {"key": "game_cards", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/game-testing-config", methods=["POST"])
@admin_required
def set_game_testing_config():
    data = request.get_json(silent=True) or {}
    bad = _bad_webapp_url(data)
    if bad:
        return bad
    config_col.update_one({"key": "game_testing"}, {"$set": {"key": "game_testing", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/maintenance-sheet-config", methods=["POST"])
@admin_required
def set_maintenance_sheet_config():
    data = request.get_json(silent=True) or {}
    bad = _bad_webapp_url(data)
    if bad:
        return bad
    config_col.update_one({"key": "maintenance_sheet"}, {"$set": {"key": "maintenance_sheet", "value": data}}, upsert=True)
    return jsonify({"ok": True}), 200


_KI_CATS = ("games", "apps", "session", "account")


def _ki_entities(data, cap=200):
    """Games / apps of a suggestion: one problem can be suggested for several games at once.
    Accepts "entities" (list) and/or the old single "entity"; trimmed, de-duplicated, at most 20."""
    raw = data.get("entities")
    items = list(raw) if isinstance(raw, list) else []
    if data.get("entity"):
        items.insert(0, data.get("entity"))
    out, seen = [], set()
    for x in items:
        s = str(x or "").strip()[:cap]
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out[:20]


@console_state_bp.route("/known-issues-suggest", methods=["POST"])
@login_required
def suggest_known_issue():
    """A regular user proposes a new known-issue row. Stored pending; an admin approves it (which then
    writes it to the sheet via the known_issues_add action) or rejects it."""
    data = request.get_json(silent=True) or {}
    category = (data.get("category") or "").strip().lower()
    if category not in _KI_CATS:
        return jsonify({"error": "invalid category"}), 400
    problem = (data.get("problem") or "").strip()
    if not problem:
        return jsonify({"error": "problem is required"}), 400
    u = current_user() or {}
    doc = {
        "category": category,
        "entity": "",
        "entities": _ki_entities(data),
        "problem": problem,
        "solution": (data.get("solution") or "").strip(),
        "link": (data.get("link") or "").strip(),
        "canned": (data.get("canned") or "").strip(),
        "by": u.get("name") or u.get("email", "") or "someone",
        "by_email": u.get("email", ""),
        "created_at": datetime.utcnow(),
    }
    doc["entity"] = doc["entities"][0] if doc["entities"] else ""
    from services import ki_shots
    token = ki_shots.new_upload_token(doc, doc["created_at"])
    doc["_id"] = ki_suggestions_col.insert_one(doc).inserted_id
    _ki_suggest_notify(doc)
    return jsonify({"ok": True, "id": str(doc["_id"]), "upload_token": token}), 201


def _ki_suggest_notify(doc):
    """Admin alert for a new Known Issues suggestion (from the console or the public page)."""
    ents = doc.get("entities") or ([doc["entity"]] if doc.get("entity") else [])
    what = (", ".join(ents[:3]) + (" +%d more" % (len(ents) - 3) if len(ents) > 3 else "")) if ents else doc.get("category", "").capitalize()
    if doc.get("kind") == "edit":
        parts = [k for k in ("problem", "solution", "canned") if k in (doc.get("changes") or {})]
        _admin_notify("ki_suggest", "Known issue edit suggested: " + (what or doc.get("category", "")),
                      (doc.get("by") or "someone") + ": " + ", ".join(parts) + " of " + (doc.get("problem") or "")[:120],
                      route="#/admin/known")
        return
    if doc.get("kind") == "addition":
        parts = (["canned message"] if doc.get("canned") else []) + (["screenshots"] if doc.get("with_shots") else [])
        _admin_notify("ki_suggest", "Known issue addition suggested: " + (what or doc.get("category", "")),
                      (doc.get("by") or "someone") + ": " + " and ".join(parts or ["addition"]) + " for " + (doc.get("problem") or "")[:120],
                      route="#/admin/known")
        return
    _admin_notify("ki_suggest", "Known issue suggested: " + (what or "new row"),
                  (doc.get("by") or "someone") + ": " + (doc.get("problem") or "")[:160], route="#/admin/known")


@console_state_bp.route("/known-issues-suggestions/<sid>", methods=["PATCH"])
@admin_required
def edit_known_issue_suggestion(sid):
    """Admin edits a pending suggestion before approving it (fields the suggester filled in)."""
    try:
        oid = ObjectId(sid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    data = request.get_json(silent=True) or {}
    upd = {}
    if "category" in data:
        cat = (data.get("category") or "").strip().lower()
        if cat not in _KI_CATS:
            return jsonify({"error": "invalid category"}), 400
        upd["category"] = cat
    for k in ("problem", "solution", "link", "canned"):
        if k in data:
            upd[k] = str(data.get(k) or "").strip()[:4000]
    if "entities" in data or "entity" in data:
        upd["entities"] = _ki_entities(data, cap=4000)
        upd["entity"] = upd["entities"][0] if upd["entities"] else ""
    if "problem" in upd and not upd["problem"]:
        return jsonify({"error": "problem is required"}), 400
    u = current_user() or {}
    upd["edited_by"] = u.get("name") or u.get("email", "")
    upd["edited_at"] = datetime.utcnow()
    ki_suggestions_col.update_one({"_id": oid}, {"$set": upd})
    return jsonify({"ok": True}), 200


@console_state_bp.route("/known-issues-suggestions/<sid>", methods=["DELETE"])
@admin_required
def delete_known_issue_suggestion(sid):
    """Remove a suggestion (used both to reject it and to clear it after it was approved/written)."""
    try:
        oid = ObjectId(sid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    from services import ki_shots
    d = ki_suggestions_col.find_one({"_id": oid}, {"shots": 1})
    ki_shots.delete_suggestion_shots((d or {}).get("shots"))   # reject = its screenshots go too (approve moved them first)
    ki_suggestions_col.delete_one({"_id": oid})
    return jsonify({"ok": True}), 200


@console_state_bp.route("/known-issues-suggestions/shot/<shot_id>", methods=["GET"])
@admin_required
def known_issue_suggestion_shot(shot_id):
    """Admin preview of a suggestion's screenshot (private until approved), streamed from R2."""
    from flask import Response
    from services import r2_store
    shot_id = re.sub(r"[^0-9a-f]", "", (shot_id or "").lower())[:32]
    d = ki_suggestions_col.find_one({"shots.id": shot_id}, {"shots": 1}) if shot_id else None
    key = next((x.get("key") for x in ((d or {}).get("shots") or []) if x.get("id") == shot_id), None)
    body, ctype = r2_store.get_object(key) if key else (None, None)
    if body is None:
        return jsonify({"error": "not found"}), 404
    resp = Response(body, mimetype=ctype)
    resp.headers["Cache-Control"] = "private, max-age=3600"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@console_state_bp.route("/known-issues-suggestions/<sid>/shots/<shot_id>", methods=["DELETE"])
@admin_required
def delete_known_issue_suggestion_shot(sid, shot_id):
    """Admin drops one screenshot from a pending suggestion (e.g. unrelated or unsafe image)."""
    from services import ki_shots
    try:
        oid = ObjectId(sid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    d = ki_suggestions_col.find_one({"_id": oid}, {"shots": 1}) or {}
    gone = [x for x in (d.get("shots") or []) if x.get("id") == shot_id]
    ki_shots.delete_suggestion_shots(gone)
    ki_suggestions_col.update_one({"_id": oid}, {"$pull": {"shots": {"id": shot_id}}})
    return jsonify({"ok": True}), 200


@console_state_bp.route("/known-issues-suggestions/<sid>/promote-shots", methods=["POST"])
@admin_required
def promote_known_issue_suggestion_shots(sid):
    """On Approve: attach the suggestion's screenshots to the published issue (the FINAL category / games /
    problem the admin approved, so edits made in review still match), making them public."""
    from services import r2_store, ki_shots
    try:
        oid = ObjectId(sid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    data = request.get_json(silent=True) or {}
    category = (data.get("category") or "").strip().lower()
    problem = (data.get("problem") or "").strip()
    ents = [str(e).strip() for e in (data.get("entities") or []) if str(e).strip()][:20]
    if category not in _KI_CATS or not problem:
        return jsonify({"error": "category and problem are required"}), 400
    if category not in ("games", "apps"):
        ents = [""]
    if not ents:
        return jsonify({"error": "a game / app is required"}), 400
    d = ki_suggestions_col.find_one({"_id": oid}, {"shots": 1}) or {}
    shots = d.get("shots") or []
    if not shots:
        return jsonify({"ok": True, "moved": 0}), 200
    col = sync_db["known_issue_shots"]
    moved = 0
    for e in ents:
        k = ki_shots.issue_key(category, e, problem)
        have = len((col.find_one({"_id": k}, {"shots.id": 1}) or {}).get("shots") or [])
        room = max(0, ki_shots.MAX_PER_ISSUE - have)
        add = [{"id": x["id"], "key": x["key"], "url": r2_store.public_url(x["key"]), "by": "suggestion",
                "at": x.get("at") or datetime.utcnow()} for x in shots[:room] if x.get("id") and x.get("key")]
        if add:
            col.update_one({"_id": k}, {"$setOnInsert": {"category": category, "entity": e, "problem": problem},
                                        "$push": {"shots": {"$each": add}}}, upsert=True)
            moved = max(moved, len(add))
    ki_suggestions_col.update_one({"_id": oid}, {"$unset": {"shots": "", "upload_token": ""}})
    _ki_bust_caches()
    return jsonify({"ok": True, "moved": moved}), 200


# --- Known Issues screenshots (admin only; bytes go to Cloudflare R2, see services/r2_store.py) --------
_KI_SHOT_MAX_BYTES = 4 * 1024 * 1024   # the console compresses to WebP first, so real uploads are ~100-300 KB


def _ki_bust_caches():
    console_live.bust("known")
    try:
        from api.routes import console_public
        console_public._ki_public_cache["payload"] = None
    except Exception:
        pass


@console_state_bp.route("/known-issue-shots", methods=["POST"])
@admin_required
def upload_known_issue_shot():
    """Attach one screenshot to a known issue (or to the same problem for several games at once).
    multipart: file, category, problem, entities (JSON list; empty for Session/Account). The image is
    uploaded to R2 ONCE and referenced from every listed game's row."""
    import uuid
    from services import r2_store, ki_shots
    if not r2_store.configured():
        return jsonify({"ok": False, "error": "R2 is not configured (R2_* env on the console)"}), 200
    category = (request.form.get("category") or "").strip().lower()
    problem = (request.form.get("problem") or "").strip()
    if category not in _KI_CATS or not problem:
        return jsonify({"ok": False, "error": "category and problem are required"}), 200
    try:
        ents = [str(e).strip() for e in (json.loads(request.form.get("entities") or "[]") or []) if str(e).strip()][:20]
    except Exception:
        ents = []
    if category in ("games", "apps") and not ents:
        return jsonify({"ok": False, "error": "a game / app is required"}), 200
    if category not in ("games", "apps"):
        ents = [""]
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "no file"}), 200
    data = f.read(_KI_SHOT_MAX_BYTES + 1)
    if len(data) > _KI_SHOT_MAX_BYTES:
        return jsonify({"ok": False, "error": "image is too big (max 4 MB)"}), 200
    kind = ki_shots.sniff_image(data[:16])
    if not kind:
        return jsonify({"ok": False, "error": "only PNG, JPEG or WebP images"}), 200
    col = sync_db["known_issue_shots"]
    keys = [ki_shots.issue_key(category, e, problem) for e in ents]
    for k in keys:
        d = col.find_one({"_id": k}, {"shots.id": 1}) or {}
        if len(d.get("shots") or []) >= ki_shots.MAX_PER_ISSUE:
            return jsonify({"ok": False, "error": "max %d screenshots per issue" % ki_shots.MAX_PER_ISSUE}), 200
    sid = uuid.uuid4().hex
    obj_key = "ki/%s.%s" % (sid, kind[0])
    try:
        url = r2_store.put_object(obj_key, data, kind[1])
    except Exception as e:
        logging.warning("[KI shots] upload failed: %s", e)
        return jsonify({"ok": False, "error": "upload to storage failed"}), 200
    u = current_user() or {}
    shot = {"id": sid, "key": obj_key, "url": url, "by": u.get("name") or u.get("email", ""), "at": datetime.utcnow()}
    for k, e in zip(keys, ents):
        col.update_one({"_id": k}, {"$setOnInsert": {"category": category, "entity": e, "problem": problem},
                                    "$push": {"shots": shot}}, upsert=True)
    _ki_bust_caches()
    return jsonify({"ok": True, "shot": {"id": sid, "url": url}}), 200


@console_state_bp.route("/known-issue-shots/<sid>", methods=["DELETE"])
@admin_required
def delete_known_issue_shot(sid):
    """Remove a screenshot from every issue that uses it, then delete the R2 object."""
    from services import r2_store
    sid = re.sub(r"[^0-9a-f]", "", (sid or "").lower())[:32]
    if not sid:
        return jsonify({"error": "bad id"}), 400
    col = sync_db["known_issue_shots"]
    d = col.find_one({"shots.id": sid}, {"shots": 1})
    obj_key = next((x.get("key") for x in ((d or {}).get("shots") or []) if x.get("id") == sid), None)
    col.update_many({"shots.id": sid}, {"$pull": {"shots": {"id": sid}}})
    if obj_key and r2_store.configured():
        r2_store.delete_object(obj_key)
    _ki_bust_caches()
    return jsonify({"ok": True}), 200


@console_state_bp.route("/mention-status", methods=["POST"])
@login_required
def set_mention_status():
    data = request.get_json(silent=True) or {}
    mid = (data.get("id") or "").strip()
    status = (data.get("status") or "").strip()
    if not mid or status not in ("new", "replied", "ignored"):
        return jsonify({"error": "id and a valid status (new/replied/ignored) are required"}), 400
    sync_db["discord_mentions"].update_one({"_id": mid}, {"$set": {"status": status}})
    return jsonify({"ok": True}), 200


@console_state_bp.route("/forum-status", methods=["POST"])
@login_required
def set_forum_status():
    # Console-side triage for a Discord forum post (which is otherwise read-only): mark it Replied /
    # Ignored so it leaves the To-Do, or "new" to clear. Stored in a console-owned collection so the
    # forum snapshot never clobbers it; the frontend merges it onto the forum list.
    data = request.get_json(silent=True) or {}
    fid = (data.get("id") or "").strip()
    status = (data.get("status") or "").strip()
    if not fid:
        return jsonify({"error": "id required"}), 400
    col = sync_db["console_forum_status"]
    if status in ("replied", "ignored"):
        col.update_one({"forum_id": fid}, {"$set": {"forum_id": fid, "status": status, "at": datetime.utcnow()}}, upsert=True)
    else:
        col.delete_one({"forum_id": fid})   # "new"/empty -> back into the To-Do
    return jsonify({"ok": True}), 200


@console_state_bp.route("/telegram-status", methods=["POST"])
@login_required
def set_telegram_status():
    # Ignore / un-ignore a Telegram message so it leaves the unanswered queue and stops
    # counting, without sending a reply. Mirrors /mention-status.
    data = request.get_json(silent=True) or {}
    tmid = (data.get("id") or "").strip()
    status = (data.get("status") or "").strip()
    if not tmid or status not in ("new", "ignored"):
        return jsonify({"error": "id and a valid status (new/ignored) are required"}), 400
    ignored = (status == "ignored")
    sync_db["telegram_messages"].update_one(
        {"$or": [{"id": tmid}, {"_id": tmid}]}, {"$set": {"ignored": ignored}})
    return jsonify({"ok": True, "ignored": ignored}), 200


# ---------------------------------------------------------------------------
# Activity feed (item W9): a real, shared log of team actions in the console (replies, status
# changes, notes, tags, Jira links, ignores, logins). The frontend appends one record per action.
# ---------------------------------------------------------------------------
@console_state_bp.route("/activity", methods=["GET"])
@login_required
@live("activity", "/activity", ttl=10)
def list_activity():
    docs = list(activity_col.find({}, {"_id": 0}).sort("at", -1).limit(100))
    return jsonify([
        {"user": d.get("user", ""), "action": d.get("action", ""), "target": d.get("target", ""),
         "at": d.get("at").isoformat() if d.get("at") else ""}
        for d in docs
    ]), 200


@console_state_bp.route("/activity", methods=["POST"])
@login_required
def add_activity():
    data = request.get_json(silent=True) or {}
    action = (data.get("action") or "").strip()
    if not action:
        return jsonify({"error": "action is required"}), 400
    u = current_user() or {}
    activity_col.insert_one({
        "user": u.get("name") or u.get("email", "") or "someone",
        "action": action[:120],
        "target": (data.get("target") or "").strip()[:200],
        "at": datetime.utcnow(),
    })
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Presence heartbeat (agents tab): each open console pings this while its tab is active; the agents
# view reads the list and shows a green dot for anyone seen in the last few minutes ("who's at the
# console now"), independent of their Working-hours shift.
# ---------------------------------------------------------------------------
@console_state_bp.route("/presence", methods=["POST"])
@login_required
def ping_presence():
    u = current_user() or {}
    email = (u.get("email") or "").strip().lower()
    if not email:
        return jsonify({"ok": False}), 200
    presence_col.update_one(
        {"_id": email},
        {"$set": {"email": email, "name": u.get("name") or email, "at": datetime.utcnow()}},
        upsert=True,
    )
    return jsonify({"ok": True}), 200


@console_state_bp.route("/presence", methods=["GET"])
@login_required
@live("presence", "/presence", ttl=10)
def list_presence():
    # Everyone seen in the last 6h; the client decides online (<~3min) vs "last seen N ago".
    since = datetime.utcnow() - timedelta(hours=6)
    docs = list(presence_col.find({"at": {"$gte": since}}, {"_id": 0}))
    return jsonify([
        {"email": d.get("email", ""), "name": d.get("name", ""),
         "at": d.get("at").isoformat() if d.get("at") else ""}
        for d in docs
    ]), 200


# ---------------------------------------------------------------------------
# Translate a message to Russian (item W10). Uses a KEYLESS, free provider so no paid DeepL key is
# needed (DeepL's free tier is too limited): Google's public translate endpoint, with MyMemory as a
# fallback. Source language is auto-detected, so English and Portuguese both work. Optional override
# via TRANSLATE_API_KEY + TRANSLATE_API_URL (a DeepL/LibreTranslate-compatible endpoint) if the team
# later wants a paid provider - but nothing is required for it to work out of the box.
# ---------------------------------------------------------------------------
# Keyless providers can fail "successfully": MyMemory returns an all-caps warning string AS the
# translation (same source+target, quota, invalid pair) - e.g. "PLEASE SELECT TWO DISTINCT LANGUAGES".
# Never surface those as a result; treat them as a provider failure and move on.
_TRANSLATE_SENTINELS = (
    "PLEASE SELECT TWO DISTINCT LANGUAGES",
    "INVALID LANGUAGE PAIR",
    "AUTOMATED TRANSLATION IS TEMPORARILY UNAVAILABLE",
    "MYMEMORY WARNING",
    "QUERY LENGTH LIMIT EXCEEDED",
    "AUTOMATED TRANSLATION IS NOT AVAILABLE",
)


def _is_bad_translation(out):
    up = (out or "").strip().upper()
    return any(s in up for s in _TRANSLATE_SENTINELS)


def _same_text(a, b):
    def norm(s):
        return " ".join((s or "").split()).strip().lower()
    return norm(a) == norm(b)


_LANG_HINTS = (
    # (code, regex) checked in order on lower-cased text; the first match wins. Scripts first, then
    # Latin languages by their own letters and most common short words.
    ("uk", r"[іїєґ]"),
    ("ru", r"[а-яё]"),
    ("ar", r"[؀-ۿ]"),
    ("he", r"[֐-׿]"),
    ("ja", r"[぀-ヿ]"),
    ("ko", r"[가-힯]"),
    ("zh", r"[一-鿿]"),
    ("el", r"[Ͱ-Ͽ]"),
    ("th", r"[฀-๿]"),
    ("tr", r"[ğış]|\b(?:oyun|açılmıyor|değil|için|teşekkür|merhaba|nasıl)\b"),
    ("pl", r"[ąęłńśźż]|\b(?:nie|się|jest|gra|dzięki|proszę|działa)\b"),
    ("de", r"[äöüß]|\b(?:nicht|das|ist|und|spiel|bitte|danke|funktioniert)\b"),
    ("pt", r"[ãõ]|\b(?:não|você|obrigad\w*|jogo|está|também|por favor|ontem|sessão)\b"),
    ("es", r"[ñ¿¡]|\b(?:juego|gracias|hola|funciona|también|ayer|sesión|pero)\b"),
    ("fr", r"[œ]|\b(?:le jeu|merci|bonjour|ne marche|fonctionne pas|avec|je suis|c'est)\b"),
    ("it", r"\b(?:gioco|grazie|ciao|non funziona|anche|perché|sono)\b"),
    ("nl", r"\b(?:spel|bedankt|werkt niet|alsjeblieft|het is|niet)\b"),
)


def _detect_lang_local(text):
    """Offline language guess (no network). Google's detection is often rate-limited (429) from
    servers, so this decides the source language MyMemory gets. Returns "" when unsure, and then
    MyMemory is asked to auto-detect instead of being told a wrong language."""
    low = (text or "").lower()
    for code, rx in _LANG_HINTS:
        if re.search(rx, low):
            return code
    letters = re.findall(r"[a-z]", low)
    return "en" if len(letters) >= 3 and re.search(r"\b(?:the|is|and|you|not|my|it|game|can|please)\b", low) else ""


# --- names that must never be translated (game titles, maintenance names) -------------------------
# A message like "o Dune: Awakening não abre" must keep "Dune: Awakening" as is. Names come from the
# Game List, active maintenances and Known Issues, cached for 10 minutes; each one found in the text
# is swapped for a placeholder that translators leave alone, and put back afterwards.
_TERMS_CACHE = {"at": 0.0, "val": []}
_PH = "ZQX%dZQX"
_PH_RE = re.compile(r"ZQX\s*(\d+)\s*ZQX", re.IGNORECASE)


def _protected_terms():
    now = time.time()
    if _TERMS_CACHE["val"] and now - _TERMS_CACHE["at"] < 600:
        return _TERMS_CACHE["val"]
    names = set()

    def add(n):
        n = " ".join(str(n or "").split())
        if len(n) < 3 or not re.search(r"[A-Za-z]", n):
            return
        names.add(n)
        base = re.sub(r"\s*[\(\[][^)\]]*[\)\]]\s*$", "", n).strip()   # "Dune: Awakening (Xbox)" -> "Dune: Awakening"
        if len(base) >= 3 and base != n:
            names.add(base)
    try:
        for d in sync_db["game_list"].find({}, {"title": 1, "_id": 0}).limit(20000):
            add(d.get("title"))
        for d in sync_db["active_maintenances"].find({}, {"entity": 1, "_id": 0}):
            add(re.sub(r"(?i)\s*\[\s*brazil\s*\]\s*", " ", str(d.get("entity") or "")))
    except Exception as e:
        logger.debug("[ConsoleState] protected terms load failed: %s", e)
    # Single common words ("Control", "Inside", "Journey") would block normal translation; keep only
    # multi-word names, names with digits/punctuation, or a single word with an inner capital.
    out = [n for n in names if (" " in n or re.search(r"[\d:&'!-]", n) or re.search(r"[a-z][A-Z]", n))]
    out.sort(key=len, reverse=True)   # longest first, so "Dune: Awakening (Xbox)" wins over "Dune: Awakening"
    _TERMS_CACHE.update(at=now, val=out)
    return out


def _shield(text):
    """Swap protected names for placeholders. Returns (text, originals)."""
    found = []
    low = text.lower()
    for name in _protected_terms():
        i = low.find(name.lower())
        while i >= 0:
            j = i + len(name)
            # whole-name match only (not inside a longer word)
            if (i == 0 or not text[i - 1].isalnum()) and (j >= len(text) or not text[j].isalnum()):
                found.append(text[i:j])
                ph = _PH % (len(found) - 1)
                text = text[:i] + ph + text[j:]
                low = text.lower()
                i = low.find(name.lower(), i + len(ph))
            else:
                i = low.find(name.lower(), j)
    return text, found


def _unshield(text, found):
    return _PH_RE.sub(lambda m: found[int(m.group(1))] if int(m.group(1)) < len(found) else m.group(0), text)


def _chunks(text, limit):
    """Split text into pieces of at most `limit` chars, on paragraph, then sentence, then word
    boundaries, keeping the separators so the joined translation keeps its layout."""
    if len(text) <= limit:
        return [text]
    parts = re.split(r"(\n\s*\n)", text)
    if max(len(p) for p in parts) > limit:
        parts = re.split(r"(\n|(?<=[.!?])\s+)", text)
    out, cur = [], ""
    for p in parts:
        if p is None:
            continue
        while len(p) > limit:                     # one huge sentence: cut on the last space
            cut = p.rfind(" ", 0, limit)
            cut = cut if cut > limit // 2 else limit
            if cur:
                out.append(cur); cur = ""
            out.append(p[:cut]); p = p[cut:]
        if len(cur) + len(p) > limit and cur:
            out.append(cur); cur = ""
        cur += p
    if cur:
        out.append(cur)
    return out


def _translate_deepl(text, target, source=""):
    """Optional paid path: only used if TRANSLATE_API_KEY is set."""
    import requests
    key = os.getenv("TRANSLATE_API_KEY", "")
    if not key:
        return None
    default_url = "https://api-free.deepl.com/v2/translate" if key.endswith(":fx") else "https://api.deepl.com/v2/translate"
    url = os.getenv("TRANSLATE_API_URL", default_url)
    resp = requests.post(url, headers={"Authorization": "DeepL-Auth-Key " + key},
                         data={"text": text[:5000], "target_lang": target.upper()[:2]}, timeout=15)
    if resp.status_code != 200:
        logger.warning("[ConsoleState] paid translate %s: %s", resp.status_code, resp.text[:160])
        return None
    trs = (resp.json() or {}).get("translations") or []
    first = trs[0] if trs else {}
    return {"text": first.get("text", ""), "source": first.get("detected_source_language", "")}


def _translate_google(text, target, source=""):
    """Keyless: Google's public gtx endpoint (often 429 from servers; then the next provider runs)."""
    import requests
    if getattr(_translate_google, "_cool", 0) > time.time():
        return None                                   # recently rate-limited: skip instead of waiting
    r = requests.get("https://translate.googleapis.com/translate_a/single",
                     params={"client": "gtx", "sl": "auto", "tl": target.lower()[:2], "dt": "t", "q": text},
                     headers={"User-Agent": "Mozilla/5.0 (cmt-console translate)"}, timeout=10)
    if r.status_code == 429:
        _translate_google._cool = time.time() + 300   # back off for 5 minutes
        return None
    if r.status_code != 200:
        return None
    arr = r.json()
    out = "".join(seg[0] for seg in (arr[0] or []) if seg and seg[0])
    src = arr[2] if len(arr) > 2 else ""
    return {"text": out, "source": (src or "").upper()} if out else None


def _translate_lingva(text, target, source=""):
    """Keyless Google-Translate proxy. Off unless LINGVA_HOST is set: the public instances are down
    or blocked and only add a long timeout."""
    import requests
    import urllib.parse
    host = os.getenv("LINGVA_HOST", "").strip().rstrip("/")
    if not host:
        return None
    q = urllib.parse.quote(text, safe="")
    try:
        r = requests.get(host + "/api/v1/auto/" + target.lower()[:2] + "/" + q,
                         headers={"User-Agent": "Mozilla/5.0 (cmt-console translate)"}, timeout=8)
        if r.status_code != 200:
            return None
        j = r.json() or {}
        out = (j.get("translation") or "").strip()
        if not out:
            return None
        src = ((j.get("info") or {}).get("detectedSource") or "")
        return {"text": out, "source": (src or "").upper()}
    except Exception:
        return None


_MM_LIMIT = 480   # MyMemory's per-request limit


def _translate_mymemory(text, target, source=""):
    """Keyless fallback. Long text is sent in pieces under its 480-char limit. The source language is
    the detected one, or MyMemory's own "autodetect" when unsure (never a guessed wrong language)."""
    import requests
    tgt = target.lower()[:2]
    src = (source or "").lower()[:2] or _detect_lang_local(text)
    if src == tgt:
        return None
    pieces = []
    for part in _chunks(text, _MM_LIMIT):
        if not part.strip():
            pieces.append(part); continue
        lead = part[:len(part) - len(part.lstrip())]
        trail = part[len(part.rstrip()):]
        params = {"q": part.strip(), "langpair": (src or "autodetect") + "|" + tgt}
        _email = os.getenv("MYMEMORY_EMAIL", "").strip()   # optional: raises the anonymous daily quota
        if _email:
            params["de"] = _email
        r = requests.get("https://api.mymemory.translated.net/get", params=params, timeout=12)
        if r.status_code != 200:
            return None
        j = r.json() or {}
        if str((j.get("responseStatus") or 200)).split(".")[0] != "200":
            return None
        out = ((j.get("responseData") or {}).get("translatedText") or "")
        if not out or _is_bad_translation(out):
            return None
        pieces.append(lead + out + trail)
    return {"text": "".join(pieces), "source": (src or _detect_lang_local(text) or "").upper()}


def _translate_piece(text, tgt2, detected):
    """Run one piece through the providers. Returns (result dict or None, detected source)."""
    for provider in (_translate_deepl, _translate_google, _translate_lingva, _translate_mymemory):
        try:
            res = provider(text, tgt2, detected)
        except Exception as e:
            logger.warning("[ConsoleState] %s failed: %s", provider.__name__, e)
            continue
        if not res:
            continue
        src = (res.get("source") or "").lower()[:2]
        if src and not detected:
            detected = src            # thread the detected source to later providers (e.g. MyMemory)
        out = (res.get("text") or "").strip()
        if not out or _is_bad_translation(out):
            continue                  # never let a provider's error string through as a "translation"
        if src and src == tgt2 and _same_text(out, text):
            return {"text": text, "same": True, "source": src}, detected
        if _same_text(out, text) and src != tgt2 and len(re.sub(_PH_RE, "", text).strip()) > 8:
            continue                  # provider echoed the input for a different language = didn't translate
        return {"text": out, "same": False, "source": src}, detected
    return None, detected


@console_state_bp.route("/translate", methods=["POST"])
@login_required
def translate():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400
    target = (data.get("target_lang") or "ru").strip().lower()[:5] or "ru"
    tgt2 = target[:2]
    if len(text) > 15000:
        return jsonify({"error": "The message is too long to translate (over 15000 characters)"}), 200
    shielded, names = _shield(text)
    # Nothing left to translate but names (e.g. the message is just a game title): keep it as is.
    if not re.sub(_PH_RE, "", shielded).strip(" \t\n.,!?:;-"):
        return jsonify({"text": text, "source": "", "same": True, "names_only": True}), 200
    detected =_detect_lang_local(shielded) if not os.getenv("TRANSLATE_API_KEY") else ""
    if detected == tgt2 and len(shielded) > 20:
        detected = ""                 # a local guess is not proof it is already in the target: ask the providers
    outs, all_same, src_seen = [], True, ""
    for piece in _chunks(shielded, 1800):
        if not piece.strip():
            outs.append(piece); continue
        res, detected = _translate_piece(piece.strip(), tgt2, detected)
        if res is None:
            if _detect_lang_local(text) == tgt2:
                return jsonify({"text": text, "source": tgt2.upper(), "same": True}), 200
            return jsonify({"error": "Translation unavailable right now, try again"}), 200
        lead = piece[:len(piece) - len(piece.lstrip())]
        outs.append(lead + res["text"] + piece[len(piece.rstrip()):])
        all_same = all_same and res["same"]
        src_seen = src_seen or res.get("source") or ""
    if all_same:
        return jsonify({"text": text, "source": (src_seen or tgt2).upper(), "same": True}), 200
    return jsonify({"text": _unshield("".join(outs), names).strip(), "source": (src_seen or detected or "").upper()}), 200


# ---------------------------------------------------------------------------
# History cutoff: a single timestamp. Every Reddit ModMail convo / Post whose last
# activity is at or before it drops into the console's History view; newer activity brings it back.
# The admin "Move all to History" button sets it to now. Reddit only (Discord/Jira untouched).
# ---------------------------------------------------------------------------
@console_state_bp.route("/history-cutoff", methods=["GET"])
@login_required
@live("cutoff", "/history-cutoff", ttl=20)
def get_history_cutoff():
    d = config_col.find_one({"key": "history_cutoff"})
    return jsonify({"cutoff": (d or {}).get("value", "")}), 200


@console_state_bp.route("/history-cutoff", methods=["POST"])
@admin_required
def set_history_cutoff():
    now = datetime.utcnow().isoformat() + "Z"
    config_col.update_one({"key": "history_cutoff"},
                          {"$set": {"key": "history_cutoff", "value": now}}, upsert=True)
    return jsonify({"ok": True, "cutoff": now}), 200


# ---------------------------------------------------------------------------
# In-app feedback (item Y): the floating widget submits a Suggestion/Bug; the Feedback tab lists
# them all with the submitter + status. Only an admin can change the status.
# ---------------------------------------------------------------------------
_FEEDBACK_STATUSES = ["New", "Review", "In Progress", "Done", "Can't add"]
_FEEDBACK_CATEGORIES = {"Suggestion", "Bug", "Question"}


def _admin_notify(event_type, title, body="", route=""):
    """Admin alert for a console-side event (new feedback / leave request). Writes the bell feed entry
    directly - admins see it in the notification centre by default (they can turn it off via the Admin
    alerts toggles); non-admins never see it. Works even where user_notify_service is not deployed (the
    console reads the feed itself); best-effort push fan-out runs where that module exists (the bot).
    Never raises."""
    try:
        notify_feed_col.insert_one({"type": event_type, "title": title, "body": body or "",
                                    "url": "", "route": route or "", "created_at": datetime.utcnow(),
                                    "admin_only": True})
    except Exception as e:
        logger.warning("[Console] admin feed insert failed: %s", e)
    # Push fan-out: the console process can't send Telegram/Slack/Web Push itself (tokens + VAPID key
    # live on the bot VM, and user_notify_service is only deployed there), so enqueue a job the bot
    # worker delivers via notify_event. The bell was already written above, so the worker passes
    # feed=False (no duplicate). Mirrors how /notify-test reaches the bot.
    try:
        actions_col.insert_one({
            "type": "admin_notify_push",
            "payload": {"event_type": event_type, "title": title, "body": body or "", "route": route or ""},
            "status": "pending", "author_email": "", "author_name": "system",
            "created_at": datetime.utcnow(),
        })
    except Exception as e:
        logger.warning("[Console] admin push enqueue failed: %s", e)


def _feedback_public(d):
    return {
        "id": str(d["_id"]),
        "category": d.get("category", ""),
        "message": d.get("message", ""),
        "status": d.get("status", "New"),
        "by": d.get("author_name", "") or d.get("author_email", ""),
        "by_email": d.get("author_email", ""),
        "edited_at": d["edited_at"].isoformat() if d.get("edited_at") else "",
        "reply": d.get("reply", ""),
        "reply_by": d.get("reply_by", ""),
        "reply_at": d["reply_at"].isoformat() if d.get("reply_at") else "",
        "created_at": d["created_at"].isoformat() if d.get("created_at") else "",
        # screenshots: private R2 objects served through the authed proxy below (never a public URL)
        "shots": [{"id": x.get("id"), "url": "/api/console/feedback-shot/" + str(x.get("id"))}
                  for x in (d.get("shots") or []) if x.get("id")],
    }


_FB_SHOT_MAX = 3                     # screenshots per feedback
_FB_SHOT_MAX_BYTES = 4 * 1024 * 1024


def _fb_drop_shots(doc):
    """Delete a feedback's screenshots from R2 and the doc (feedback marked Done no longer needs them)."""
    shots = (doc or {}).get("shots") or []
    if not shots:
        return
    from services import r2_store
    if r2_store.configured():
        for x in shots:
            if x.get("key"):
                r2_store.delete_object(x["key"])
    feedback_col.update_one({"_id": doc["_id"]}, {"$unset": {"shots": ""}})


@console_state_bp.route("/feedback/<fb_id>/shots", methods=["POST"])
@login_required
def add_feedback_shot(fb_id):
    """Attach a screenshot to a feedback - its AUTHOR only (the point: the reporter shows the problem). multipart: file."""
    import uuid
    from services import r2_store, ki_shots
    try:
        oid = ObjectId(fb_id)
    except (InvalidId, Exception):
        return jsonify({"ok": False, "error": "Bad id"}), 400
    if not r2_store.configured():
        return jsonify({"ok": False, "error": "Screenshots are not configured yet"}), 200
    cur = feedback_col.find_one({"_id": oid}, {"author_email": 1, "status": 1, "shots": 1})
    if not cur:
        return jsonify({"ok": False, "error": "not found"}), 404
    me = current_user() or {}
    mine = bool(me.get("email")) and (cur.get("author_email") or "").lower() == me.get("email", "").lower()
    if not mine:   # only the person who sent the feedback attaches screenshots to it
        return jsonify({"ok": False, "error": "you can only add screenshots to your own feedback"}), 403
    if (cur.get("status") or "New") == "Done":
        return jsonify({"ok": False, "error": "this feedback is already done"}), 200
    if len(cur.get("shots") or []) >= _FB_SHOT_MAX:
        return jsonify({"ok": False, "error": "max %d screenshots" % _FB_SHOT_MAX}), 200
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "no file"}), 200
    data = f.read(_FB_SHOT_MAX_BYTES + 1)
    if len(data) > _FB_SHOT_MAX_BYTES:
        return jsonify({"ok": False, "error": "image is too big (max 4 MB)"}), 200
    kind = ki_shots.sniff_image(data[:16])
    if not kind:
        return jsonify({"ok": False, "error": "only PNG, JPEG or WebP images"}), 200
    sid = uuid.uuid4().hex
    obj_key = "fb/%s.%s" % (uuid.uuid4().hex, kind[0])   # storage name != the id in console links (private file)
    try:
        r2_store.put_object(obj_key, data, kind[1])
    except Exception as e:
        logger.warning("[Feedback] screenshot upload failed: %s", e)
        return jsonify({"ok": False, "error": "upload to storage failed"}), 200
    feedback_col.update_one({"_id": oid}, {"$push": {"shots": {"id": sid, "key": obj_key, "at": datetime.utcnow()}}})
    console_live.bust("feedback")
    return jsonify({"ok": True, "shot": {"id": sid, "url": "/api/console/feedback-shot/" + sid}}), 200


@console_state_bp.route("/feedback-shot/<sid>", methods=["GET"])
@login_required
def get_feedback_shot(sid):
    """Stream a feedback screenshot from R2 to a signed-in console user (feedback images stay private)."""
    from flask import Response
    from services import r2_store
    sid = re.sub(r"[^0-9a-f]", "", (sid or "").lower())[:32]
    d = feedback_col.find_one({"shots.id": sid}, {"shots": 1}) if sid else None
    key = next((x.get("key") for x in ((d or {}).get("shots") or []) if x.get("id") == sid), None)
    if not key:
        return jsonify({"error": "not found"}), 404
    body, ctype = r2_store.get_object(key)
    if body is None:
        return jsonify({"error": "not found"}), 404
    resp = Response(body, mimetype=ctype)
    resp.headers["Cache-Control"] = "private, max-age=86400"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@console_state_bp.route("/feedback", methods=["GET"])
@login_required
@live("feedback", "/feedback", ttl=15)
def list_feedback():
    docs = feedback_col.find({}).sort("created_at", -1).limit(2000)
    return jsonify([_feedback_public(d) for d in docs]), 200


@console_state_bp.route("/feedback", methods=["POST"])
@login_required
def add_feedback():
    data = request.get_json(silent=True) or {}
    category = (data.get("category") or "").strip()
    message = (data.get("message") or "").strip()
    if category not in _FEEDBACK_CATEGORIES:
        return jsonify({"error": "Pick a category"}), 400
    if not message:
        return jsonify({"error": "Message is required"}), 400
    doc = {"category": category, "message": message[:4000], "status": "New", "created_at": datetime.utcnow()}
    doc.update(_who())
    doc["_id"] = feedback_col.insert_one(doc).inserted_id
    _by = doc.get("author_name") or doc.get("author_email") or "Someone"
    _admin_notify("feedback_new", "New feedback: " + category, _by + ": " + message[:160], route="#/feedback")
    return jsonify(_feedback_public(doc)), 201


@console_state_bp.route("/feedback/<fb_id>", methods=["PATCH"])
@login_required
def update_feedback(fb_id):
    """Status and reply are admin-only; the message itself can be edited by its author (or an admin)."""
    try:
        oid = ObjectId(fb_id)
    except (InvalidId, Exception):
        return jsonify({"error": "Bad id"}), 400
    data = request.get_json(silent=True) or {}
    me = current_user() or {}
    is_admin = me.get("role") == "admin"
    if ("status" in data or "reply" in data) and not is_admin:
        return jsonify({"error": "admins only"}), 403
    set_doc = {"updated_at": datetime.utcnow()}
    if "message" in data:
        cur = feedback_col.find_one({"_id": oid}, {"author_email": 1})
        if not cur:
            return jsonify({"error": "not found"}), 404
        mine = bool(me.get("email")) and (cur.get("author_email") or "").lower() == me.get("email", "").lower()
        if not (mine or is_admin):
            return jsonify({"error": "you can only edit your own feedback"}), 403
        msg = str(data.get("message") or "").strip()
        if not msg:
            return jsonify({"error": "Message is required"}), 400
        set_doc["message"] = msg[:4000]
        set_doc["edited_at"] = datetime.utcnow()
    if "status" in data:
        status = (data.get("status") or "").strip()
        if status not in _FEEDBACK_STATUSES:
            return jsonify({"error": "bad status"}), 400
        set_doc["status"] = status
    if "reply" in data:                                   # admin's response to the feedback
        set_doc["reply"] = str(data.get("reply") or "")[:4000]
        set_doc["reply_by"] = _who().get("author_name", "")
        set_doc["reply_at"] = datetime.utcnow()
    if len(set_doc) == 1:
        return jsonify({"error": "nothing to update"}), 400
    res = feedback_col.update_one({"_id": oid}, {"$set": set_doc})
    if res.matched_count == 0:
        return jsonify({"error": "not found"}), 404
    d = feedback_col.find_one({"_id": oid})
    if d and set_doc.get("status") == "Done" and d.get("shots"):
        _fb_drop_shots(d)          # Done = screenshots no longer needed: free the storage
        d.pop("shots", None)
        console_live.bust("feedback")
    return jsonify(_feedback_public(d) if d else {"ok": True}), 200


# ---------------------------------------------------------------------------
# Inbox read state (items S6/S7). SHARED across the whole team: opening a chat marks it read for
# everyone. A record stores the message count seen at read time; an item is "unread" again once its
# live count exceeds it. Keyed by "<ref_type>:<ref>".
# ---------------------------------------------------------------------------
def _read_key(ref_type, ref):
    return (ref_type or "") + ":" + (ref or "")


@console_state_bp.route("/reads", methods=["GET"])
@login_required
@live("reads", "/reads", ttl=6)
def list_reads():
    out = {}
    for d in reads_col.find({}, {"_id": 0, "key": 1, "count": 1, "seen_at": 1}).limit(20000):
        if d.get("key"):
            out[d["key"]] = {"c": d.get("count", 0),
                             "at": d["seen_at"].isoformat() if hasattr(d.get("seen_at"), "isoformat") else d.get("seen_at")}
    return jsonify({"reads": out}), 200


@console_state_bp.route("/reads", methods=["POST"])
@login_required
def set_read():
    data = request.get_json(silent=True) or {}
    ref_type = (data.get("ref_type") or "").strip()
    ref = str(data.get("ref") or "").strip()
    if not ref_type or not ref:
        return jsonify({"error": "ref_type and ref are required"}), 400
    try:
        count = int(data.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    key = _read_key(ref_type, ref)
    doc = {"key": key, "ref_type": ref_type, "ref": ref, "count": count, "seen_at": datetime.utcnow()}
    doc.update(_who())
    reads_col.update_one({"key": key}, {"$set": doc, "$setOnInsert": {"created_at": datetime.utcnow()}}, upsert=True)
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Facebook Notes (item T8): simple per-person notes - username, optional chat link, text, optional
# Jira ticket. Console-only, persisted here.
# ---------------------------------------------------------------------------
def _fb_public(d):
    return {"id": str(d["_id"]), "username": d.get("username", ""), "link": d.get("link", ""),
            "text": d.get("text", ""), "ticket": d.get("ticket", ""), "author": d.get("author_name", "")}


@console_state_bp.route("/fb-notes", methods=["GET"])
@perm_required("facebook")
@live("fbnotes", "/fb-notes", perm="facebook", ttl=20)
def list_fb_notes():
    return jsonify([_fb_public(d) for d in fb_notes_col.find({}).sort("created_at", -1).limit(2000)]), 200


@console_state_bp.route("/fb-notes", methods=["POST"])
@perm_required("facebook")
def add_fb_note():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    text = (data.get("text") or "").strip()
    if not username or not text:
        return jsonify({"error": "username and text are required"}), 400
    doc = {"username": username, "link": (data.get("link") or "").strip(),
           "text": text, "ticket": (data.get("ticket") or "").strip(), "created_at": datetime.utcnow()}
    doc.update(_who())
    doc["_id"] = fb_notes_col.insert_one(doc).inserted_id
    return jsonify(_fb_public(doc)), 201


@console_state_bp.route("/fb-notes/<nid>", methods=["PUT"])
@perm_required("facebook")
def update_fb_note(nid):
    try:
        oid = ObjectId(nid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    data = request.get_json(silent=True) or {}
    upd = {}
    for k in ("username", "link", "text", "ticket"):
        if k in data:
            upd[k] = (data[k] or "").strip()
    if not upd:
        return jsonify({"error": "nothing to update"}), 400
    upd["updated_at"] = datetime.utcnow()
    res = fb_notes_col.update_one({"_id": oid}, {"$set": upd})
    return (jsonify({"ok": True}), 200) if res.matched_count else (jsonify({"error": "not found"}), 404)


@console_state_bp.route("/fb-notes/<nid>", methods=["DELETE"])
@perm_required("facebook")
def delete_fb_note(nid):
    try:
        oid = ObjectId(nid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    fb_notes_col.delete_one({"_id": oid})
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Leave (Vacation / Sick Leave): a member requests days off -> an admin approves/rejects -> on approval
# the console decrements the member's balance, writes VACATION/SICK LEAVE into the calendar (via the same
# schedule_set actions the bot executes against the Google Sheet), and DMs the member the outcome.
# ---------------------------------------------------------------------------
_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
LEAVE_TYPES = ("vacation", "sick")
VAC_MAX_WORK_DAYS = 5      # one vacation request spans at most 5 of the person's working days
VAC_MIN_LEAD_DAYS = 7      # vacation must be requested at least a week before its first day
LEAVE_CAL_VALUE = {"vacation": "VACATION", "sick": "SICK LEAVE"}
schedule_col = sync_db["team_schedule"]


def _kyiv_date():
    """Today's date in Europe/Kyiv (UTC+2, +3 during DST) - matches the calendar's wall clock."""
    now = datetime.utcnow()
    y = now.year

    def last_sunday(month):
        d = datetime(y, month, 28)
        while (d + timedelta(days=1)).month == month:
            d += timedelta(days=1)
        while d.weekday() != 6:
            d -= timedelta(days=1)
        return d
    dst = last_sunday(3).replace(hour=1) <= now < last_sunday(10).replace(hour=1)
    return (now + timedelta(hours=3 if dst else 2)).date()


def _parse_dmy(s):
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", str(s or "").strip())
    if not m:
        return None
    try:
        from datetime import date
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def _fmt_dmy(d):
    return "%02d.%02d.%04d" % (d.day, d.month, d.year)


_WORK_DAYKEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]   # Python weekday() index -> work schedule key


def _working_dates(schedule, start, end):
    """Dates in [start, end] that are working days for this member. Uses the per-weekday working-hours
    schedule (keyed mon..sun); if the member has no schedule at all, falls back to Mon-Fri."""
    out = []
    d = start
    while d <= end:
        slot = (schedule or {}).get(_WORK_DAYKEYS[d.weekday()]) if schedule else None
        on = bool(slot.get("on")) if isinstance(slot, dict) else (not schedule and d.weekday() < 5)
        if on:
            out.append(d)
        d += timedelta(days=1)
    return out


def _leave_config():
    doc = config_col.find_one({"key": "leave"}) or {}
    v = doc.get("value") or {}
    return {"vac_total": int(v.get("vac_total") or 0), "sick_total": int(v.get("sick_total") or 0)}


def _user_leave(user, cfg=None):
    """Resolve a member's leave balance: per-user totals fall back to the global default."""
    cfg = cfg or _leave_config()
    lv = (user or {}).get("leave") or {}
    vac_total = int(lv.get("vac_total") or 0) or cfg["vac_total"]
    sick_total = int(lv.get("sick_total") or 0) or cfg["sick_total"]
    return {"vac_total": vac_total, "vac_used": int(lv.get("vac_used") or 0),
            "sick_total": sick_total, "sick_used": int(lv.get("sick_used") or 0),
            "renew": lv.get("renew", ""), "renew_note": lv.get("renew_note", "")}


def _leave_public(d):
    return {"id": str(d["_id"]), "type": d.get("type", ""), "status": d.get("status", "pending"),
            "user_email": d.get("user_email", ""), "user_name": d.get("user_name", ""),
            "start": d.get("start", ""), "end": d.get("end", ""), "dates": d.get("dates") or [],
            "work_days": d.get("work_days", 0), "reason": d.get("reason", ""),
            "decide_note": d.get("decide_note", ""), "decided_by": d.get("decided_by", ""),
            "created_at": d.get("created_at").isoformat() if d.get("created_at") else None,
            "decided_at": d.get("decided_at").isoformat() if d.get("decided_at") else None}


@console_state_bp.route("/leave-config", methods=["GET"])
@login_required
def get_leave_config():
    return jsonify(_leave_config()), 200


@console_state_bp.route("/leave-config", methods=["POST"])
@admin_required
def set_leave_config():
    data = request.get_json(silent=True) or {}
    val = {"vac_total": max(0, int(data.get("vac_total") or 0)),
           "sick_total": max(0, int(data.get("sick_total") or 0))}
    config_col.update_one({"key": "leave"}, {"$set": {"key": "leave", "value": val}}, upsert=True)
    return jsonify(val), 200


# Reddit "account flagged as a bot" alert (bot: services/reddit_snapshot.py reads this, 60s cache).
# tag = console user to @-mention in the TG meeting group (email, email local part, name or alias);
# empty = tag whoever is on shift.
_REDDIT_FLAG_DEFAULTS = {"enabled": True, "alert_minutes": 10, "min_errors": 5,
                         "realert_hours": 3, "tag": "o.teleshko"}


def _reddit_flag_config():
    d = (config_col.find_one({"key": "reddit_flag_alert"}) or {}).get("value") or {}
    out = dict(_REDDIT_FLAG_DEFAULTS)
    out.update({k: v for k, v in d.items() if k in out})
    return out


@console_state_bp.route("/reddit-flag-alert", methods=["GET"])
@login_required
def get_reddit_flag_alert():
    return jsonify(_reddit_flag_config()), 200


@console_state_bp.route("/reddit-flag-alert", methods=["POST"])
@admin_required
def set_reddit_flag_alert():
    data = request.get_json(silent=True) or {}

    def _num(key, cast, lo, hi):
        try:
            return min(hi, max(lo, cast(data.get(key))))
        except (TypeError, ValueError):
            return _REDDIT_FLAG_DEFAULTS[key]
    val = {"enabled": bool(data.get("enabled", True)),
           "alert_minutes": _num("alert_minutes", int, 1, 1440),
           "min_errors": _num("min_errors", int, 1, 1000),
           "realert_hours": _num("realert_hours", float, 0.25, 168),
           "tag": str(data.get("tag") or "").strip()[:120]}
    config_col.update_one({"key": "reddit_flag_alert"},
                          {"$set": {"key": "reddit_flag_alert", "value": val}}, upsert=True)
    return jsonify(val), 200


@console_state_bp.route("/leave-requests", methods=["GET"])
@login_required
def list_leave_requests():
    u = current_user() or {}
    is_admin = u.get("role") == "admin"
    if request.args.get("all") and is_admin:
        docs = leave_requests_col.find({}).sort("created_at", -1).limit(500)
    else:
        docs = leave_requests_col.find({"user_email": u.get("email", "")}).sort("created_at", -1).limit(200)
    return jsonify([_leave_public(d) for d in docs]), 200


@console_state_bp.route("/leave-requests", methods=["POST"])
@login_required
def create_leave_request():
    u = current_user()
    if not u:
        return jsonify({"error": "No session user"}), 400
    data = request.get_json(silent=True) or {}
    ltype = (data.get("type") or "").strip()
    if ltype not in LEAVE_TYPES:
        return jsonify({"error": "type must be vacation or sick"}), 400
    start, end = _parse_dmy(data.get("start")), _parse_dmy(data.get("end"))
    if not start or not end:
        return jsonify({"error": "start and end must be dd.mm.yyyy"}), 400
    if end < start:
        return jsonify({"error": "end is before start"}), 400
    if (end - start).days > 60:
        return jsonify({"error": "range too long"}), 400
    wdates = _working_dates(u.get("schedule"), start, end)
    if not wdates:
        return jsonify({"error": "no working days in that range for your schedule"}), 400
    bal = _user_leave(u)
    if ltype == "vacation":
        if len(wdates) > VAC_MAX_WORK_DAYS:
            return jsonify({"error": "Vacation is at most %d working days at a time." % VAC_MAX_WORK_DAYS}), 400
        lead = (start - _kyiv_date()).days
        if lead < VAC_MIN_LEAD_DAYS:
            return jsonify({"error": "Vacation must be requested at least %d days before it starts." % VAC_MIN_LEAD_DAYS}), 400
        remaining = bal["vac_total"] - bal["vac_used"]
        if len(wdates) > remaining:
            return jsonify({"error": "Only %d vacation day(s) left." % max(0, remaining)}), 400
    # Sick leave is unplanned: no lead time or 5-day cap, and it may exceed the nominal allowance.
    doc = {"type": ltype, "status": "pending", "user_email": u.get("email", ""),
           "user_name": u.get("name") or u.get("email", ""), "member": u.get("schedule_member", ""),
           "start": _fmt_dmy(start), "end": _fmt_dmy(end),
           "dates": [_fmt_dmy(d) for d in wdates], "work_days": len(wdates),
           "reason": str(data.get("reason") or "")[:500], "created_at": datetime.utcnow()}
    doc["_id"] = leave_requests_col.insert_one(doc).inserted_id
    _kind = "vacation" if ltype == "vacation" else "sick leave"
    _admin_notify("leave_request", "Leave request: " + doc["user_name"],
                  "%s requested %s for the period from %s to %s (%d working day(s))." % (
                      doc["user_name"], _kind, doc["start"], doc["end"], doc["work_days"]),
                  route="#/team")
    return jsonify(_leave_public(doc)), 201


def _enqueue_calendar_leave(member, date_strs, value, author):
    """Queue one schedule_set action per leave date so the bot writes it to the Google Sheet. Resolves
    the member's column index from the mirrored month tab (the bot also matches by name as a fallback)."""
    if not member:
        return 0
    n = 0
    for ds in date_strs:
        m = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})$", ds)
        if not m:
            continue
        monthkey = _MONTHS[int(m.group(2)) - 1] + " " + m.group(3)
        sdoc = schedule_col.find_one({"$or": [{"month": monthkey}, {"_id": monthkey}]}) or {}
        members = sdoc.get("members") or []
        idx = members.index(member) if member in members else None
        actions_col.insert_one({
            "type": "schedule_set",
            "payload": {"month": monthkey, "date": ds, "member": member, "member_index": idx, "value": value},
            "status": "pending", "result": None, "error": None,
            "created_at": datetime.utcnow(), "claimed_at": None, "finished_at": None,
            "created_by": author, "source": "leave"})
        n += 1
    return n


def _enqueue_notify_dm(user_email, title, body):
    actions_col.insert_one({
        "type": "notify_user_dm",
        "payload": {"user_email": user_email, "title": title, "body": body,
                    "url": os.getenv("CONSOLE_URL", "https://cmtconsole.xyz/console/")},
        "status": "pending", "result": None, "error": None,
        "created_at": datetime.utcnow(), "claimed_at": None, "finished_at": None, "source": "leave"})


@console_state_bp.route("/leave-requests/<rid>/decide", methods=["POST"])
@admin_required
def decide_leave_request(rid):
    try:
        oid = ObjectId(rid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    req = leave_requests_col.find_one({"_id": oid})
    if not req:
        return jsonify({"error": "not found"}), 404
    if req.get("status") != "pending":
        return jsonify({"error": "already decided"}), 400
    data = request.get_json(silent=True) or {}
    decision = (data.get("decision") or "").strip()
    if decision not in ("approve", "reject"):
        return jsonify({"error": "decision must be approve or reject"}), 400
    note = str(data.get("note") or "")[:300]
    admin = current_user() or {}
    upd = {"status": "approved" if decision == "approve" else "rejected",
           "decided_at": datetime.utcnow(), "decided_by": admin.get("name") or admin.get("email", ""),
           "decide_note": note}
    # Claim the decision atomically first: if another admin decided a moment ago, stop here so the balance,
    # the calendar and the DM are not done twice.
    if not leave_requests_col.find_one_and_update({"_id": oid, "status": "pending"}, {"$set": upd}):
        return jsonify({"error": "already decided"}), 409
    ltype = req.get("type")
    pretty = "Vacation" if ltype == "vacation" else "Sick leave"
    if decision == "approve":
        # Decrement the member's balance by the working-day count.
        used_field = "leave.vac_used" if ltype == "vacation" else "leave.sick_used"
        from api.routes.console_auth import users_col as _users
        _users.update_one({"email": req.get("user_email")}, {"$inc": {used_field: int(req.get("work_days") or 0)}})
        # Write VACATION / SICK LEAVE into the calendar (Google Sheet via the bot) + DM the member.
        _enqueue_calendar_leave(req.get("member") or "", req.get("dates") or [],
                                LEAVE_CAL_VALUE[ltype], admin.get("email", ""))
        _enqueue_notify_dm(req.get("user_email", ""), "%s approved" % pretty,
                           "Your %s for %s-%s was approved.%s" % (pretty.lower(), req.get("start"), req.get("end"),
                                                                  (" Note: " + note) if note else ""))
    else:
        _enqueue_notify_dm(req.get("user_email", ""), "%s declined" % pretty,
                           "Your %s for %s-%s was declined.%s" % (pretty.lower(), req.get("start"), req.get("end"),
                                                                  (" Note: " + note) if note else ""))
    return jsonify(_leave_public(leave_requests_col.find_one({"_id": oid}))), 200


# ---------------------------------------------------------------------------
# Actions queue: the console enqueues, a worker inside the bot process
# executes via the bot's live Discord/Reddit connections and writes the result back.
# Console never talks to the bot directly - they meet only here, in Mongo.
# ---------------------------------------------------------------------------
@console_state_bp.route("/actions", methods=["POST"])
@login_required
def enqueue_action():
    data = request.get_json(silent=True) or {}
    atype = data.get("type", "")
    if atype not in _ACTION_TYPES:
        return jsonify({"error": "unknown action type"}), 400
    # notify_user_dm is server-internal (leave approve/reject only) - never client-enqueuable, otherwise any
    # signed-in user could DM arbitrary text to anyone. It's inserted directly by the decide endpoint.
    if atype == "notify_user_dm":
        return jsonify({"error": "not allowed"}), 403
    # Writing directly to the known-issues sheet (and forcing a sync) is admin-only; regular users go
    # through the suggestion queue (/known-issues-suggest -> admin approves).
    # Game Cards is a shared, collaborative sheet - anyone can generate/edit. Known-issues and schedule
    # writes stay admin-only.
    if atype in ("known_issues_add", "known_issues_set_canned", "known_issues_update", "known_issues_sync", "game_list_sync",
                 "schedule_set", "schedule_create_month", "schedule_sync"):
        u = current_user() or {}
        if u.get("role") != "admin":
            return jsonify({"error": "admin only"}), 403
    # Section-exclusive writes require that section's permission (admins always pass).
    need = _ACTION_PERM.get(atype)
    if need and not user_has_perm(current_user(), need):
        return jsonify({"error": "Forbidden"}), 403
    payload = data.get("payload") or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "payload must be an object"}), 400
    # The action document must fit Mongo's 16MB limit; refuse anything close to it up front instead of
    # failing inside insert_one with a 500.
    if (request.content_length or 0) > 14 * 1024 * 1024:
        return jsonify({"error": "Request is too large"}), 413
    if atype == "cloud_sessions" and payload.get("mine"):
        # "My sessions": the User ID is taken from the signed-in member's own profile, never from the
        # client, so the picker can only ever list the caller's own sessions.
        own = str((current_user() or {}).get("cloud_user_id") or "").strip()
        if not own.isdigit():
            return jsonify({"error": "Your Boosteroid User ID is not set. Ask an admin to add it in Admin > Users > Identity."}), 400
        payload = {"user_id": int(own), "limit": 15, "force": bool(payload.get("force"))}
    if atype in ("create_so_ticket", "create_urgent"):
        # The author is ALWAYS the signed-in console user - never trust the client for it. And cap the
        # base64 file payload so the action doc stays comfortably under Mongo's 16MB limit.
        u = current_user() or {}
        payload["author_email"] = u.get("email", "")
        payload["author_display"] = u.get("name") or u.get("email", "")
        payload["author_slack_id"] = u.get("slack_id", "")
        if atype == "create_urgent":
            # "My Own Ticket": attributed to the signed-in member's own Boosteroid User ID (from their
            # profile, never the client). The bot marks it own -> testing session + auto-close at Review.
            if payload.get("own_ticket"):
                own = str(u.get("cloud_user_id") or "").strip()
                if not own.isdigit():
                    return jsonify({"error": "Your Boosteroid User ID is not set. Ask an admin to add it in Admin > Users > Identity."}), 400
                payload["own_ticket"] = True
                payload["own_user_id"] = int(own)
            else:
                payload.pop("own_ticket", None)
                payload.pop("own_user_id", None)
        if _payload_files_b64_len(payload) > 12 * 1024 * 1024:
            return jsonify({"error": "Attached files are too large. Create the ticket, then attach the large files to it."}), 413
    doc = {
        "type": atype,
        "payload": payload,
        "status": "pending",
        "result": None, "error": None,
        "created_at": datetime.utcnow(), "claimed_at": None, "finished_at": None,
    }
    doc.update(_who())
    # Double click / double submit: the same action with the same payload from the same person within
    # _DEDUP_SECONDS returns the action already queued instead of running it twice (two tickets, two
    # replies). The unique index on dedup_key also catches two requests that arrive at the same moment.
    fp = _action_fingerprint(atype, payload, doc.get("author_email", ""))
    doc["dedup_key"] = "%s:%d" % (fp, int(time.time()) // _DEDUP_SECONDS)
    doc["dedup_fp"] = fp
    prev = actions_col.find_one({"dedup_fp": fp,
                                 "created_at": {"$gte": doc["created_at"] - timedelta(seconds=_DEDUP_SECONDS)}})
    if prev:
        logger.info("[ConsoleState] duplicate %s action from %s ignored (same as %s)",
                    atype, doc.get("author_email", ""), prev["_id"])
        return jsonify(_action_public(prev)), 200
    try:
        doc["_id"] = actions_col.insert_one(doc).inserted_id
    except DuplicateKeyError:
        prev = actions_col.find_one({"dedup_key": doc["dedup_key"]})
        if prev:
            return jsonify(_action_public(prev)), 200
        raise
    if atype in _REPLY_TYPES:
        _reply_log_add(doc)
    # Remember WHO sent a Reddit modmail reply/note from the console. Reddit shows the shared bot account
    # as the author; the modmail detail endpoint matches this record (same convo + same text, posted
    # shortly after) to show the real operator. Best-effort, never blocks the send.
    if atype in ("reddit_reply", "reddit_note"):
        try:
            sync_db["reddit_reply_authors"].insert_one({
                "convo_id": str(payload.get("convo_id") or "").strip(),
                "body": str(payload.get("text") or "").strip(),
                "author_name": doc.get("author_name", ""),
                "author_email": doc.get("author_email", ""),
                "created_at": doc["created_at"],
            })
        except Exception as e:
            logger.debug("[ConsoleState] reddit reply attribution not stored: %s", e)
    return jsonify(_action_public(doc)), 201


@console_state_bp.route("/actions/<action_id>", methods=["GET"])
@login_required
def action_status(action_id):
    try:
        oid = ObjectId(action_id)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    d = actions_col.find_one({"_id": oid})
    if not d:
        return jsonify({"error": "not found"}), 404
    return jsonify(_action_public(d)), 200


@console_state_bp.route("/actions", methods=["GET"])
@login_required
def list_actions():
    docs = actions_col.find({}).sort("created_at", -1).limit(50)
    return jsonify([_action_public(d) for d in docs]), 200


# ---------------------------------------------------------------------------
# Reports (each user's own; admin can see all via ?all=1)
# ---------------------------------------------------------------------------
def _report_public(d):
    return {
        "id": str(d["_id"]), "type": d.get("type", "daily"), "date": d.get("date", ""),
        "author": d.get("author_name", ""), "author_email": d.get("author_email", ""),
        "fields": d.get("fields", []),
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
    }


@console_state_bp.route("/reports", methods=["GET"])
@login_required
def list_reports():
    u = current_user()
    if request.args.get("all") == "1" and u and u.get("role") == "admin":
        query = {}
    else:
        query = {"author_email": (u or {}).get("email", "")}
    docs = reports_col.find(query).sort("created_at", -1).limit(500)
    return jsonify([_report_public(d) for d in docs]), 200


# ---------------------------------------------------------------------------
# Bot exclusion lists (identity). These are the "clean" exclusions NOT tied to a console
# user - e.g. Reddit bots (AutoModerator) or Discord mod accounts we don't have profiles for. The
# bot's EFFECTIVE ignore list = this list UNION every console user's linked account, and it only
# suppresses the bot's Slack/Discord notifications - the console still shows everything. Empty for
# now; the bot keeps its .env fallback (IGNORED_USERS / MODERATORS) until these are populated.
# ---------------------------------------------------------------------------
def _get_list(key):
    d = config_col.find_one({"key": key})
    return (d or {}).get("value", []) or []


def _set_list(key, items):
    vals = [str(x).strip() for x in (items or []) if str(x).strip()]
    config_col.update_one({"key": key}, {"$set": {"key": key, "value": vals}}, upsert=True)
    return vals


@console_state_bp.route("/ignored-reddit", methods=["GET"])
@login_required
def get_ignored_reddit():
    return jsonify({"users": _get_list("ignored_reddit")}), 200


@console_state_bp.route("/ignored-reddit", methods=["PUT"])
@admin_required
def set_ignored_reddit():
    data = request.get_json(silent=True) or {}
    return jsonify({"ok": True, "users": _set_list("ignored_reddit", data.get("users"))}), 200


@console_state_bp.route("/moderators-discord", methods=["GET"])
@login_required
def get_moderators_discord():
    return jsonify({"users": _get_list("moderators_discord")}), 200


@console_state_bp.route("/moderators-discord", methods=["PUT"])
@admin_required
def set_moderators_discord():
    data = request.get_json(silent=True) or {}
    return jsonify({"ok": True, "users": _set_list("moderators_discord", data.get("users"))}), 200


# Permanent whitelist for the Discord image ratelimit (names or ids). The bot reads it
# (identity_service.get_image_whitelist_discord, 60s cache) and never alerts on these accounts.
@console_state_bp.route("/image-whitelist-discord", methods=["GET"])
@login_required
def get_image_whitelist_discord():
    return jsonify({"users": _get_list("image_whitelist_discord")}), 200


@console_state_bp.route("/image-whitelist-discord", methods=["PUT"])
@admin_required
def set_image_whitelist_discord():
    data = request.get_json(silent=True) or {}
    return jsonify({"ok": True, "users": _set_list("image_whitelist_discord", data.get("users"))}), 200


# ---------------------------------------------------------------------------
# Per-user notifications: settings + Web Push subscriptions + Telegram linking.
# The console stores what each user wants; the bot's delivery engine
# (services/user_notify_service.py) reads these and sends via Telegram DM,
# Slack DM, and Web Push (which covers desktop AND installed-PWA mobile).
# ---------------------------------------------------------------------------
def _default_schedule_from_working(user):
    """Seed the notification schedule from the user's working-hours picker, else an all-day window."""
    sched = (user or {}).get("schedule") or {}
    out = {}
    for d in _WEEKDAYS:
        s = sched.get(d) or {}
        out[d] = {"on": bool(s.get("on", True)),
                  "start": (str(s.get("start", "") or "")[:5] or "00:00"),
                  "end": (str(s.get("end", "") or "")[:5] or "23:59")}
    return out


def _prefs_public(doc, user):
    doc = doc or {}
    types = doc.get("types") or {}
    channels = doc.get("channels") or {}
    u = user or {}
    return {
        "enabled": bool(doc.get("enabled", False)),                       # master on/off
        "use_working_hours": bool(doc.get("use_working_hours", True)),
        "types": {t: bool(types.get(t, (u.get("role") == "admin") if t in _ADMIN_EVENT_TYPES else True)) for t in NOTIFY_TYPES},   # admin events default ON for admins
        "channels": {c: bool(channels.get(c, False)) for c in NOTIFY_CHANNELS},
        "schedule": doc.get("schedule") or _default_schedule_from_working(u),
        # Link status so the UI can show Connected / Connect for each channel.
        "telegram_linked": bool(u.get("telegram_chat_id")),
        "slack_linked": bool(u.get("slack_id")),
        "webpush_devices": (push_subs_col.count_documents({"user_email": u.get("email", "")})
                            if u.get("email") else 0),
    }


@console_state_bp.route("/notify-prefs", methods=["GET"])
@login_required
def get_notify_prefs():
    u = current_user() or {}
    return jsonify(_prefs_public(notify_prefs_col.find_one({"user_email": u.get("email", "")}), u)), 200


@console_state_bp.route("/notify-prefs", methods=["PUT"])
@login_required
def set_notify_prefs():
    u = current_user()
    if not u:
        return jsonify({"error": "No session user"}), 400
    data = request.get_json(silent=True) or {}
    set_doc = {"user_email": u.get("email", ""), "updated_at": datetime.utcnow()}
    if "enabled" in data:
        set_doc["enabled"] = bool(data["enabled"])
    if "use_working_hours" in data:
        set_doc["use_working_hours"] = bool(data["use_working_hours"])
    # Merge with dotted keys so a partial update (e.g. toggling one type) doesn't wipe the sibling
    # keys of types / channels / schedule.
    if isinstance(data.get("types"), dict):
        for t in NOTIFY_TYPES:
            if t in data["types"]:
                set_doc["types.%s" % t] = bool(data["types"][t])
    if isinstance(data.get("channels"), dict):
        for c in NOTIFY_CHANNELS:
            if c in data["channels"]:
                set_doc["channels.%s" % c] = bool(data["channels"][c])
    if isinstance(data.get("schedule"), dict):
        for k, v in data["schedule"].items():
            if str(k) in _WEEKDAYS and isinstance(v, dict):
                set_doc["schedule.%s" % str(k)] = {"on": bool(v.get("on")),
                                                   "start": str(v.get("start", ""))[:5],
                                                   "end": str(v.get("end", ""))[:5]}
    notify_prefs_col.update_one({"user_email": u.get("email", "")}, {"$set": set_doc}, upsert=True)
    return jsonify(_prefs_public(notify_prefs_col.find_one({"user_email": u.get("email", "")}), u)), 200


@console_state_bp.route("/notify-feed", methods=["GET"])
@login_required
def get_notify_feed():
    """In-app notification center (the bell). Returns the recent events of the types this user is
    subscribed to, newest first, each flagged read/unread against the user's last-seen marker."""
    u = current_user() or {}
    prefs = notify_prefs_col.find_one({"user_email": u.get("email", "")}) or {}
    types = prefs.get("types") or {}
    is_admin = (u.get("role") == "admin")
    # Admin events default ON for admins, and are never shown to non-admins (mirrors notify_event).
    wanted = [t for t in NOTIFY_TYPES
              if types.get(t, is_admin if t in _ADMIN_EVENT_TYPES else True) and (is_admin or t not in _ADMIN_EVENT_TYPES)]
    seen_at = prefs.get("feed_seen_at")
    items, unread = [], 0
    # Personal entries (to_email, e.g. the result of the member's own urgent request) are shown only to
    # that member, whatever their type subscriptions; shared events have no to_email.
    me = u.get("email", "")
    shared = {"type": {"$in": wanted}, "to_email": {"$exists": False}}
    flt = {"$or": [shared, {"to_email": me}]} if me else shared
    if wanted or me:
        for d in notify_feed_col.find(flt).sort("created_at", -1).limit(50):
            ca = d.get("created_at")
            is_unread = bool(seen_at is None or (ca and ca > seen_at))
            if is_unread:
                unread += 1
            items.append({"type": d.get("type", ""), "title": d.get("title", ""),
                          "body": d.get("body", ""), "url": d.get("url", ""), "route": d.get("route", ""),
                          "created_at": ca.isoformat() if ca else None, "unread": is_unread})
    return jsonify({"items": items, "unread": unread}), 200


@console_state_bp.route("/notify-feed/seen", methods=["POST"])
@login_required
def mark_notify_feed_seen():
    """Mark the whole feed read for this user (clears the bell dot)."""
    u = current_user()
    if not u:
        return jsonify({"error": "No session user"}), 400
    notify_prefs_col.update_one({"user_email": u.get("email", "")},
                                {"$set": {"feed_seen_at": datetime.utcnow()}}, upsert=True)
    return jsonify({"ok": True}), 200


@console_state_bp.route("/notify-vapid", methods=["GET"])
@login_required
def get_notify_vapid():
    # Public VAPID key so the browser can subscribe to Web Push. Empty -> push not configured yet.
    return jsonify({"publicKey": os.getenv("VAPID_PUBLIC_KEY", "")}), 200


@console_state_bp.route("/notify-push-subscribe", methods=["POST"])
@login_required
def notify_push_subscribe():
    u = current_user()
    if not u:
        return jsonify({"error": "No session user"}), 400
    data = request.get_json(silent=True) or {}
    sub = data.get("subscription") or data
    endpoint = (sub or {}).get("endpoint")
    keys = (sub or {}).get("keys") or {}
    # endpoint MUST be a string - otherwise a dict like {"$ne": null} would inject a Mongo operator.
    if not isinstance(endpoint, str) or not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        return jsonify({"error": "Invalid push subscription"}), 400
    push_subs_col.update_one(
        {"endpoint": endpoint},
        {"$set": {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
                  "user_email": u.get("email", ""), "ua": (request.headers.get("User-Agent") or "")[:300],
                  "updated_at": datetime.utcnow()}},
        upsert=True,
    )
    return jsonify({"ok": True, "devices": push_subs_col.count_documents({"user_email": u.get("email", "")})}), 200


@console_state_bp.route("/notify-push-unsubscribe", methods=["POST"])
@login_required
def notify_push_unsubscribe():
    u = current_user() or {}
    data = request.get_json(silent=True) or {}
    endpoint = ((data.get("subscription") or {}) or {}).get("endpoint") or data.get("endpoint")
    email = u.get("email", "")
    # Always scope the delete to THIS user (no deleting another user's subscription) and require a
    # string endpoint (else a {"$ne": null} could delete an arbitrary row via operator injection).
    if isinstance(endpoint, str) and endpoint:
        push_subs_col.delete_one({"endpoint": endpoint, "user_email": email})
    else:   # no endpoint -> drop every device for this user only
        push_subs_col.delete_many({"user_email": email})
    return jsonify({"ok": True, "devices": push_subs_col.count_documents({"user_email": u.get("email", "")})}), 200


@console_state_bp.route("/notify-telegram-link", methods=["GET"])
@login_required
def notify_telegram_link():
    u = current_user()
    if not u:
        return jsonify({"error": "No session user"}), 400
    import secrets as _secrets
    bot = os.getenv("TELEGRAM_BOT_USERNAME", "")
    if not bot:
        return jsonify({"error": "Telegram bot username not configured on the server"}), 503
    token = _secrets.token_urlsafe(9)
    notify_links_col.update_one(
        {"user_email": u.get("email", "")},
        {"$set": {"user_email": u.get("email", ""), "token": token, "created_at": datetime.utcnow()}},
        upsert=True,
    )
    # The mod taps this link, Telegram opens the bot with /start cmt_<token>; the bot maps the token
    # to this user and stores their chat_id (see telegram_bot start handler).
    return jsonify({"url": "https://t.me/%s?start=cmt_%s" % (bot, token), "bot": bot}), 200


@console_state_bp.route("/notify-telegram-unlink", methods=["POST"])
@login_required
def notify_telegram_unlink():
    u = current_user() or {}
    from api.routes.console_auth import users_col as _users
    if u.get("_id"):
        _users.update_one({"_id": u["_id"]}, {"$unset": {"telegram_chat_id": ""}})
    return jsonify({"ok": True}), 200


@console_state_bp.route("/notify-test", methods=["POST"])
@login_required
def notify_test():
    # The console can't send Telegram/Slack/Web Push itself (tokens + VAPID private key live on the
    # bot VM), so enqueue a test action for the bot worker to fan out to this user's linked channels.
    u = current_user()
    if not u:
        return jsonify({"error": "No session user"}), 400
    actions_col.insert_one({
        "type": "notify_test", "payload": {"user_email": u.get("email", "")},
        "status": "pending", "author_email": u.get("email", ""),
        "author_name": u.get("name") or u.get("email", ""), "created_at": datetime.utcnow(),
    })
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Reply templates (shared, team-wide)
# ---------------------------------------------------------------------------
def _tpl_public(d):
    return {"id": str(d["_id"]), "title": d.get("title", ""), "category": d.get("category", "General"),
            "body": d.get("body", "")}


@console_state_bp.route("/templates", methods=["GET"])
@login_required
@live("templates", "/templates", ttl=20)
def list_templates():
    return jsonify([_tpl_public(d) for d in templates_col.find({}).sort("title", 1)]), 200


@console_state_bp.route("/templates", methods=["POST"])
@login_required
def add_template():
    data = request.get_json(silent=True) or {}
    if not (data.get("title") and data.get("body")):
        return jsonify({"error": "title and body required"}), 400
    doc = {"title": data["title"], "category": data.get("category") or "General",
           "body": data["body"], "created_at": datetime.utcnow()}
    doc.update(_who())
    doc["_id"] = templates_col.insert_one(doc).inserted_id
    return jsonify(_tpl_public(doc)), 201


@console_state_bp.route("/templates/<tid>", methods=["PATCH"])
@login_required
def update_template(tid):
    try:
        oid = ObjectId(tid)
    except (InvalidId, Exception):
        return jsonify({"error": "Bad id"}), 400
    data = request.get_json(silent=True) or {}
    allowed = {k: data[k] for k in ("title", "category", "body") if k in data}
    if not allowed:
        return jsonify({"error": "Nothing to update"}), 400
    templates_col.update_one({"_id": oid}, {"$set": allowed})
    d = templates_col.find_one({"_id": oid})
    return (jsonify(_tpl_public(d)), 200) if d else (jsonify({"error": "Not found"}), 404)


@console_state_bp.route("/templates/<tid>", methods=["DELETE"])
@login_required
def delete_template(tid):
    try:
        oid = ObjectId(tid)
    except (InvalidId, Exception):
        return jsonify({"error": "Bad id"}), 400
    templates_col.delete_one({"_id": oid})
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Variables & links (single shared config doc)
# ---------------------------------------------------------------------------
@console_state_bp.route("/variables", methods=["GET"])
@login_required
def get_variables():
    d = config_col.find_one({"key": "variables"})
    return jsonify({"variables": (d or {}).get("value", [])}), 200


@console_state_bp.route("/variables", methods=["PUT"])
@admin_required
def set_variables():
    data = request.get_json(silent=True) or {}
    vs = data.get("variables") or []
    config_col.update_one({"key": "variables"}, {"$set": {"key": "variables", "value": vs}}, upsert=True)
    return jsonify({"ok": True, "variables": vs}), 200


# ---------------------------------------------------------------------------
# Handoff notes (shared). May be attached to a chat (context_type + ref).
# ---------------------------------------------------------------------------
def _handoff_public(d):
    return {
        "id": str(d["_id"]), "from": d.get("author_name", ""), "target": d.get("target", ""),
        "context_type": d.get("context_type", ""), "ref": d.get("ref", ""), "refLabel": d.get("refLabel", ""),
        "text": d.get("text", ""),
        "done": bool(d.get("done")), "done_by": d.get("done_by", ""),
        "done_at": d["done_at"].isoformat() if d.get("done_at") else None,
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
    }


@console_state_bp.route("/handoffs", methods=["GET"])
@login_required
@live("handoffs", "/handoffs", ttl=10)
def list_handoffs():
    return jsonify([_handoff_public(d) for d in handoffs_col.find({}).sort("created_at", -1).limit(500)]), 200


@console_state_bp.route("/handoffs", methods=["POST"])
@login_required
def add_handoff():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text required"}), 400
    doc = {
        "target": data.get("target") or "anyone", "text": text,
        "context_type": data.get("context_type") or "", "ref": str(data.get("ref") or ""),
        "refLabel": data.get("label") or data.get("refLabel") or "", "created_at": datetime.utcnow(),
    }
    doc.update(_who())
    doc["_id"] = handoffs_col.insert_one(doc).inserted_id
    return jsonify(_handoff_public(doc)), 201


@console_state_bp.route("/handoffs/<hid>/done", methods=["POST"])
@login_required
def mark_handoff_done(hid):
    """Mark a handoff done (or reopen it). 'done' is global + persistent (survives reload / device),
    so a handoff stays in everyone's Inbox until someone completes it."""
    try:
        oid = ObjectId(hid)
    except (InvalidId, Exception):
        return jsonify({"error": "bad id"}), 400
    data = request.get_json(silent=True) or {}
    if bool(data.get("done", True)):
        handoffs_col.update_one({"_id": oid},
            {"$set": {"done": True, "done_by": _who().get("author_name", ""), "done_at": datetime.utcnow()}})
    else:
        handoffs_col.update_one({"_id": oid}, {"$set": {"done": False}, "$unset": {"done_by": "", "done_at": ""}})
    d = handoffs_col.find_one({"_id": oid})
    return jsonify(_handoff_public(d) if d else {"ok": True}), 200


@console_state_bp.route("/handoffs/<hid>", methods=["DELETE"])
@login_required
def delete_handoff(hid):
    try:
        oid = ObjectId(hid)
    except (InvalidId, Exception):
        return jsonify({"error": "Bad id"}), 400
    handoffs_col.delete_one({"_id": oid})
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Testing sessions. Saved EXACTLY like the Slack "Add Testing Session" flow
# (handlers/modal_handlers.handle_testing_session_submission): the pasted "Session Info" blob is
# parsed into one or more sessions and one doc per session is written into the shared
# `testing_sessions` collection in the Slack schema (session_id/game/result/ticket_url/environment/
# issue/created_by/testing_tags/created_at). That is the same DB + format the 08:00 daily report
# (services.mongo_db_service.collect_and_send_testing_sessions, sent via SLACK_REPORT_API_URL) and
# the per-user stats read. NO Slack post - the Slack handler's only side effect was a self DM.
# ---------------------------------------------------------------------------
@console_state_bp.route("/testing", methods=["POST"])
@login_required
def add_testing():
    from services import testing_sessions
    data = request.get_json(silent=True) or {}
    try:
        ids, err = testing_sessions.add(testing_col, data.get("session"), data.get("environment"), data.get("issue"),
                                        data.get("result"), data.get("ticket_url"), data.get("tags"), _created_by())
    except Exception as e:
        logger.error("[ConsoleState] add_testing insert failed: %s", e)
        return jsonify({"error": "Database error while saving the session(s). Please retry."}), 500
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True, "count": len(ids), "ids": ids}), 201


@console_state_bp.route("/testing/<sid>", methods=["PATCH"])
@login_required
def edit_testing(sid):
    """Edit a saved testing session (the same function as the Slack Edit button). Members edit their own
    sessions; an admin can edit anyone's."""
    from services import testing_sessions
    data = request.get_json(silent=True) or {}
    u = current_user() or {}
    only = None if u.get("role") == "admin" else _created_by()
    doc, err = testing_sessions.update(testing_col, sid, data.get("session"), data.get("environment"), data.get("issue"),
                                       data.get("result"), data.get("ticket_url"), data.get("tags"),
                                       updated_by=_created_by(), only_author=only)
    if err:
        return jsonify({"error": err}), (404 if err.startswith("not found") or err == "bad id" else 400)
    return jsonify({"ok": True, "id": str(doc["_id"])}), 200


@console_state_bp.route("/testing", methods=["GET"])
@login_required
def list_testing():
    docs = testing_col.find({}).sort("created_at", -1).limit(200)
    out = []
    for d in docs:
        out.append({"id": str(d["_id"]), "session_id": d.get("session_id", ""), "game": d.get("game", ""),
                    "environment": d.get("environment", ""), "issue": d.get("issue", ""),
                    "result": d.get("result", ""), "tags": d.get("testing_tags", []),
                    "author": d.get("created_by", ""),
                    "created_at": d["created_at"].isoformat() if d.get("created_at") else None})
    return jsonify(out), 200


# ---------------------------------------------------------------------------
# My Activity - the signed-in user's own tags + testing sessions over the last 8 days.
# 8 days covers both "this week" (Mon-Sun) and the current/previous shift; the frontend
# buckets the rows into those windows client-side (it owns the schedule/shift logic).
# Tags come from the shared `issues` store filtered by created_by (== the user's Slack
# handle), so tags added in Slack AND in the console both show up, exactly like the stats.
# ---------------------------------------------------------------------------
# Admin reply log: who wrote what, where, in any period. Every reply / internal note sent from the console
# is copied into reply_log (kept forever) when it is enqueued; console_actions itself expires after 30 days.
# Delivery status is read from the queue while the action still exists there.
_REPLY_TYPES = {"reddit_reply": "Reddit", "reddit_note": "Reddit", "reddit_post_reply": "Reddit",
                "discord_reply": "Discord", "telegram_reply": "Telegram"}
reply_log_col = sync_db["reply_log"]


def _reply_log_doc(d):
    pl = d.get("payload") or {}
    t = d.get("type")
    return {
        "action_id": d["_id"], "type": t, "platform": _REPLY_TYPES.get(t, t),
        "internal": bool(t == "reddit_note" or pl.get("kind") in ("note", "internal")),
        "text": str(pl.get("text") or pl.get("body") or ""),
        "target": str(pl.get("convo_id") or pl.get("ticket_id") or pl.get("id") or pl.get("post_id") or ""),
        "author_email": d.get("author_email", ""), "author_name": d.get("author_name", ""),
        "created_at": d.get("created_at") or datetime.utcnow(),
    }


def _reply_log_add(d):
    try:
        reply_log_col.update_one({"action_id": d["_id"]}, {"$setOnInsert": _reply_log_doc(d)}, upsert=True)
    except Exception as e:
        logger.debug("[ConsoleState] reply log not stored: %s", e)


def _reply_log_init():
    """Reply log indexes (idempotent). The one-time copy of old replies is migration step 3."""
    try:
        reply_log_col.create_index("action_id", unique=True)
        reply_log_col.create_index([("created_at", -1)])
        reply_log_col.create_index([("author_email", 1), ("created_at", -1)])
    except Exception as e:
        logger.warning("[ConsoleState] reply log indexes skipped: %s", e)


def reply_log_backfill():
    """Migration step 3 (services/db_migrations.py): copy the replies still in the 30-day action queue."""
    if sync_db["console_config"].find_one({"key": "reply_log_backfilled"}):
        return {"copied": 0, "note": "already copied earlier"}
    n = 0
    for d in actions_col.find({"type": {"$in": list(_REPLY_TYPES)}}):
        _reply_log_add(d)
        n += 1
    sync_db["console_config"].update_one({"key": "reply_log_backfilled"},
                                         {"$set": {"key": "reply_log_backfilled", "value": True}}, upsert=True)
    return {"copied": n}


import threading as _rl_threading
_rl_threading.Thread(target=_reply_log_init, daemon=True, name="reply-log-init").start()


@console_state_bp.route("/admin/reply-log", methods=["GET"])
@admin_required
def admin_reply_log():
    def _dt(v):
        d = _parse_iso_dt(v)
        return d.replace(tzinfo=None) - (d.utcoffset() or timedelta(0)) if d and d.tzinfo else d
    now = datetime.utcnow()
    since = _dt(request.args.get("from")) or (now - timedelta(days=1))
    until = _dt(request.args.get("to")) or now
    q = {"created_at": {"$gte": since, "$lt": until}}
    author = (request.args.get("author") or "").strip()
    if author:
        q["author_email"] = author
    docs = list(reply_log_col.find(q).sort("created_at", -1).limit(5000))
    st = {a["_id"]: a for a in actions_col.find({"_id": {"$in": [d["action_id"] for d in docs]}},
                                                 {"status": 1, "error": 1})}
    out = []
    for d in docs:
        a = st.get(d["action_id"]) or {}
        out.append({
            "id": str(d["action_id"]), "at": d["created_at"].isoformat() + "Z",
            "author_email": d.get("author_email", ""), "author_name": d.get("author_name", ""),
            "platform": d.get("platform", ""), "type": d.get("type", ""), "internal": bool(d.get("internal")),
            "text": d.get("text", ""), "target": d.get("target", ""),
            "status": a.get("status") or "done", "error": a.get("error") or "",
        })
    return jsonify({"items": out, "truncated": len(out) >= 5000}), 200


@console_state_bp.route("/my-activity", methods=["GET"])
@login_required
def my_activity():
    alias = _created_by()
    since = datetime.utcnow() - timedelta(days=8)

    tags = []
    for d in issues_col.find({"created_by": alias, "created_at": {"$gte": since}}).sort("created_at", -1).limit(1000):
        url = d.get("post_url") or d.get("ticket_url") or ""
        where = d.get("context_type") or d.get("platform") or ""
        at = d["created_at"].isoformat() if d.get("created_at") else None
        for t in (d.get("tags") or []):
            tags.append({"tag": t, "url": url, "where": where, "at": at})

    testing = []
    for d in testing_col.find({"created_by": alias, "created_at": {"$gte": since}}).sort("created_at", -1).limit(1000):
        testing.append({
            "id": str(d["_id"]), "ticket_url": d.get("ticket_url", ""),
            "session_id": d.get("session_id", ""), "game": d.get("game", ""),
            "result": d.get("result", ""), "issue": d.get("issue", ""),
            "environment": d.get("environment", ""), "tags": d.get("testing_tags", []),
            "at": d["created_at"].isoformat() if d.get("created_at") else None,
        })

    return jsonify({"tags": tags, "testing": testing}), 200


# ---------------------------------------------------------------------------
# "Maintenance In Brazil" - a console-only maintenance category (type "brazil") the admin manages by
# hand: it is NOT tied to the Mattermost maintenance events or the bot's Slack/subscription flow. Records
# live in the same `active_maintenances` collection (so the read-side /maintenances endpoint and the
# console timer pick them up), with a caller-supplied started_at and a plain delete on end.
# ---------------------------------------------------------------------------
def _parse_iso_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


@console_state_bp.route("/brazil-maintenance", methods=["POST"])
@admin_required
def add_brazil_maintenance():
    data = request.get_json(silent=True) or {}
    entity = (data.get("entity") or "").strip()
    if not entity:
        return jsonify({"error": "entity is required"}), 400
    started = _parse_iso_dt(data.get("started_at")) or datetime.utcnow()
    sync_db["active_maintenances"].update_one(
        {"entity": entity, "type": "brazil"},
        {"$set": {"entity": entity, "type": "brazil", "started_at": started}},
        upsert=True,
    )
    # On a genuinely new start (not an edit), append a row to the maintenance Google Sheet as
    # "Only for Brazil". The sheet secret lives on the bot, so we enqueue the append for the worker.
    if data.get("push_sheet"):
        try:
            actions_col.insert_one({
                "type": "maintenance_sheet_add",
                "payload": {"game": entity, "maintenance_in": "Only for Brazil",
                            "started_at": started.isoformat()},
                "status": "pending", "author_email": "", "author_name": "system",
                "created_at": datetime.utcnow(),
            })
        except Exception as e:
            logger.warning("[Console] brazil maintenance sheet enqueue failed: %s", e)
    return jsonify({"ok": True}), 201


@console_state_bp.route("/brazil-maintenance/end", methods=["POST"])
@admin_required
def end_brazil_maintenance():
    data = request.get_json(silent=True) or {}
    entity = (data.get("entity") or "").strip()
    if not entity:
        return jsonify({"error": "entity is required"}), 400
    sync_db["active_maintenances"].delete_one({"entity": entity, "type": "brazil"})
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Add Email (writes the bot's `users_emails` collection). Field names match the
# bot's readers in services/mongo_db_service.py: reddit_username, discord_user_id,
# facebook_author, url. The platform is inferred from the profile URL.
# ---------------------------------------------------------------------------
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _parse_profile_url(url):
    """Returns (identity_field, identity_value, platform) parsed from a profile URL, or
    (None, None, 'Other') when nothing recognisable is found."""
    u = (url or "").strip()
    low = u.lower()
    m = re.search(r"reddit\.com/u(?:ser)?/([^/?#\s]+)", low)
    if m:
        return "reddit_username", m.group(1), "Reddit"
    m = re.search(r"discord(?:app)?\.com/users/(\d+)", low)
    if m:
        return "discord_user_id", int(m.group(1)), "Discord"
    m = re.search(r"facebook\.com/(?:profile\.php\?id=(\d+)|([^/?#\s]+))", low)
    if m:
        return "facebook_author", (m.group(1) or m.group(2)), "Facebook"
    return None, None, "Other"


def _save_user_id(user_id, profile_url):
    """Upsert a directory record that ties a Boosteroid User ID to a social profile (platform inferred
    from the URL). Only the ID is stored - plain, it is not personal data. Returns the inferred platform."""
    field, value, platform = _parse_profile_url(profile_url)
    now = datetime.utcnow()
    doc = {"cloud_user_id": str(int(user_id)), "cloud_user_id_at": now, "cloud_user_id_status": "found",
           "url": profile_url, "platform": platform}
    doc.update(_who())
    if field:
        # Reddit names differ only by case between writers (the bot keeps the original case, the console
        # lowercases), so every record of this account is updated - none is left behind with an email.
        match = ({field: {"$regex": "^" + re.escape(str(value)) + "$", "$options": "i"}}
                 if field == "reddit_username" else {field: value})
        res = emails_col.update_many(match, {"$set": doc})
        if res.matched_count == 0:
            doc[field] = value
            doc["created_at"] = now
            emails_col.insert_one(doc)
    else:
        doc["created_at"] = now
        emails_col.insert_one(doc)
    try:
        from api.routes.console_api import _cache_bust
        _cache_bust("users_emails_bulk")
    except Exception as _e:
        logger.warning("ignored: %s", _e)
    return platform


@console_state_bp.route("/users-emails", methods=["POST"])
@login_required
def add_user_email():
    """Tie a User ID to a social profile. Emails are not accepted here: the console resolves an
    address to its User ID first (bot action cloud_user_lookup) and sends only the ID."""
    data = request.get_json(silent=True) or {}
    uid = str(data.get("user_id") or "").strip()
    profile_url = (data.get("profile_url") or "").strip()
    if not uid.isdigit():
        return jsonify({"error": "a numeric User ID is required (emails are no longer stored)"}), 400
    if not profile_url:
        return jsonify({"error": "profile_url is required"}), 400
    platform = _save_user_id(uid, profile_url)
    return jsonify({"ok": True, "platform": platform}), 201


# ---------------------------------------------------------------------------
# Custom issue (= Slack `send_custom_user_issue`). Writes a Slack-identical `issues` doc
# {post_url, tags, ticket_url, platform, created_by, created_at} (multi-tag, NO source field so it
# flows through the same report + list_tags paths as a Slack issue), and optionally saves the email.
# Console-side only - no bot / Slack post (the Slack handler's only side effects are this Mongo
# write + a self-confirmation DM).
# ---------------------------------------------------------------------------
@console_state_bp.route("/custom-issue", methods=["POST"])
@login_required
def custom_issue():
    data = request.get_json(silent=True) or {}
    issue_url = (data.get("issue_url") or "").strip()
    tags = [t for t in (data.get("tags") or []) if t]
    platform = (data.get("platform") or "").strip() or "Reddit"
    ticket_url = (data.get("ticket_url") or "").strip()
    facebook_name = (data.get("facebook_name") or "").strip()
    if not issue_url:
        return jsonify({"error": "issue_url is required"}), 400
    if not tags:
        return jsonify({"error": "at least one tag is required"}), 400

    doc = {
        "post_url": issue_url,
        "tags": tags,
        "ticket_url": ticket_url,
        "platform": platform,
        "created_by": _created_by(),
        "created_at": datetime.utcnow(),
    }
    doc.update(_who())
    issues_col.insert_one(doc)

    # Optional: tie the user's Boosteroid User ID to this profile (emails are never stored).
    uid = str(data.get("user_id") or "").strip()
    if uid.isdigit():
        try:
            if platform == "Facebook" and facebook_name and "facebook.com" not in issue_url.lower():
                now = datetime.utcnow()
                fdoc = {"cloud_user_id": uid, "cloud_user_id_at": now, "cloud_user_id_status": "found",
                        "facebook_author": facebook_name, "platform": "Facebook", "url": issue_url}
                fdoc.update(_who())
                emails_col.update_one({"facebook_author": facebook_name},
                                      {"$set": fdoc, "$setOnInsert": {"created_at": now}}, upsert=True)
            else:
                _save_user_id(uid, issue_url)
        except Exception as e:
            logger.warning("[ConsoleState] custom-issue User ID save failed: %s", e)

    return jsonify({"ok": True}), 201


# ---------------------------------------------------------------------------
# Add Jira link (Reddit ModMail): records a Jira key <-> conversation link in the
# bot's reddit_mod_notes.jira_convos, which the console already reads back to show
# linked tickets. Mirrors the bot's set_reddit_mod_note_jira_convo_sync. The actual
# Reddit mod note (jira_notes) stays a bot job and is untouched here.
# ---------------------------------------------------------------------------
@console_state_bp.route("/reddit-jira-link", methods=["POST"])
@login_required
def add_reddit_jira_link():
    data = request.get_json(silent=True) or {}
    reddit_user = (data.get("reddit_user") or "").strip()
    convo_id = (data.get("convo_id") or "").strip()
    # Accept a URL or bare key; keep only the SO-1234 form (a dotted URL would corrupt the
    # jira_convos.<key> field name).
    m = re.search(r"[A-Za-z][A-Za-z0-9]*-\d+", data.get("issue_key") or "")
    issue_key = m.group(0).upper() if m else ""
    if not reddit_user or not issue_key or not convo_id:
        return jsonify({"error": "reddit_user, a valid issue_key and convo_id are required"}), 400
    mod_notes_col.update_one(
        {"reddit_user": reddit_user},
        {"$set": {f"jira_convos.{issue_key}": convo_id, "updated_at": datetime.utcnow()},
         "$setOnInsert": {"reddit_user": reddit_user}},
        upsert=True,
    )
    return jsonify({"ok": True, "issue_key": issue_key}), 201


def _valid_issue_key(raw):
    m = re.search(r"[A-Za-z][A-Za-z0-9]*-\d+", raw or "")
    return m.group(0).upper() if m else ""


@console_state_bp.route("/jira-chat", methods=["GET"])
@login_required
def jira_chat():
    """Which console chat a Jira ticket belongs to, searched in the database (the browser only knows the
    chats it has loaded). Order: Discord ticket link, Reddit ModMail link, Reddit post link, then the
    ticket's Communication Link. Returns {"go": "#/..."} or {"go": ""}."""
    import re as _re
    key = _valid_issue_key(request.args.get("key"))
    link = (request.args.get("link") or "").strip()
    if not key:
        return jsonify({"go": ""}), 200
    t = discord_tickets_col.find_one({"$or": [{"jira_ticket_keys": key}, {"jira_ticket_key": key}]}, {"_id": 1})
    if t:
        return jsonify({"go": "#/discord/" + str(t["_id"])}), 200
    n = mod_notes_col.find_one({"jira_convos." + key: {"$exists": True}}, {"jira_convos": 1})
    if n and (n.get("jira_convos") or {}).get(key):
        return jsonify({"go": "#/modmail/" + str(n["jira_convos"][key])}), 200
    pj = post_jira_col.find_one({"issue_keys": key}, {"post_id": 1})
    if pj and pj.get("post_id"):
        return jsonify({"go": "#/posts/" + str(pj["post_id"])}), 200
    m = _re.search(r"discord(?:app)?\.com/channels/\d+/(\d+)", link)
    if m:
        t = discord_tickets_col.find_one({"$or": [{"channel_id": m.group(1)}, {"channel_id": int(m.group(1))}]}, {"_id": 1})
        if t:
            return jsonify({"go": "#/discord/" + str(t["_id"])}), 200
    m = _re.search(r"mod\.reddit\.com/mail/(?:[a-z]+/)?([a-z0-9]+)", link, _re.I)
    if m:
        return jsonify({"go": "#/modmail/" + m.group(1)}), 200
    m = _re.search(r"reddit\.com/r/[^/]+/comments/([a-z0-9]+)", link, _re.I)
    if m:
        return jsonify({"go": "#/posts/" + m.group(1)}), 200
    return jsonify({"go": ""}), 200


@console_state_bp.route("/discord-jira-link", methods=["POST"])
@perm_required("discord")      # same rule as the discord_jira_link action it queues
def add_discord_jira_link():
    """Link a Jira ticket to a Discord ticket (item W4): add the key to the ticket's
    jira_ticket_keys array (the console already reads jira_keys from there)."""
    data = request.get_json(silent=True) or {}
    ticket_id = (data.get("ticket_id") or "").strip()
    issue_key = _valid_issue_key(data.get("issue_key"))
    if not ticket_id or not issue_key:
        return jsonify({"error": "ticket_id and a valid issue_key are required"}), 400
    try:
        oid = ObjectId(ticket_id)
    except (InvalidId, Exception):
        return jsonify({"error": "bad ticket_id"}), 400
    if not discord_tickets_col.find_one({"_id": oid}, {"_id": 1}):
        return jsonify({"error": "ticket not found"}), 404
    now = datetime.utcnow()
    # Primary = the first Jira link of the ticket (the !jira command's first-key branch): the bot moves the
    # channel to the Jira category + posts the on-hold note only for it. Claimed atomically, so two links
    # at the same moment (two operators, or the console + !jira) never both become primary. A URG ticket
    # is never the primary link.
    primary = False
    if not issue_key.upper().startswith("URG-"):
        res = discord_tickets_col.update_one(
            {"_id": oid, "$and": [{"$or": [{"jira_ticket_key": {"$exists": False}}, {"jira_ticket_key": {"$in": [None, ""]}}]},
                                  {"$or": [{"jira_ticket_keys": {"$exists": False}}, {"jira_ticket_keys": {"$size": 0}}]}]},
            {"$set": {"jira_ticket_key": issue_key, "updated_at": now}, "$addToSet": {"jira_ticket_keys": issue_key}})
        primary = res.modified_count == 1
    if not primary:
        res = discord_tickets_col.update_one({"_id": oid, "jira_ticket_keys": {"$ne": issue_key}},
                                             {"$addToSet": {"jira_ticket_keys": issue_key}, "$set": {"updated_at": now}})
        if res.modified_count == 0:     # already linked: nothing new to tell Discord
            return jsonify({"ok": True, "issue_key": issue_key, "already": True}), 200
    # Parity with the in-channel `!jira` command: enqueue the bot to post the channel note + move the
    # channel to the Jira category + record the console transcript note. The Mongo write above already
    # made the console UI show the link; this adds the Discord-side effects that were missing.
    try:
        adoc = {
            "type": "discord_jira_link",
            "payload": {"ticket_id": ticket_id, "issue_key": issue_key, "primary": primary},
            "status": "pending", "result": None, "error": None,
            "created_at": datetime.utcnow(), "claimed_at": None, "finished_at": None,
        }
        adoc.update(_who())
        actions_col.insert_one(adoc)
    except Exception as e:
        logger.warning("[ConsoleState] could not enqueue discord_jira_link for %s: %s", ticket_id, e)
    return jsonify({"ok": True, "issue_key": issue_key}), 201


@console_state_bp.route("/jira-user-link", methods=["GET"])
@login_required
@live("juser", "/jira-user-link", ttl=15)
def list_jira_user_links():
    """{user_id: [issue_key, ...]} for every User ID linked to a ticket by hand."""
    out = {}
    for d in jira_user_col.find({}, {"user_id": 1, "issue_key": 1, "_id": 0}):
        if d.get("user_id") and d.get("issue_key"):
            out.setdefault(d["user_id"], []).append(d["issue_key"])
    return jsonify({"links": out}), 200


@console_state_bp.route("/jira-user-link", methods=["POST", "DELETE"])
@login_required
def set_jira_user_link():
    """Link (POST) or unlink (DELETE) a Boosteroid User ID and a Jira ticket. Console + DB only: nothing is
    written to Jira. When the ticket reaches L1 In Progress the user gets an "Update the user" To-Do card."""
    data = request.get_json(silent=True) or {}
    uid = re.sub(r"\D", "", str(data.get("user_id") or ""))
    issue_key = _valid_issue_key(data.get("issue_key"))
    if not uid or not issue_key:
        return jsonify({"error": "user_id (digits) and a valid issue_key are required"}), 400
    _id = "%s|%s" % (issue_key, uid)
    if request.method == "DELETE":
        jira_user_col.delete_one({"_id": _id})
        return jsonify({"ok": True}), 200
    doc = {"issue_key": issue_key, "user_id": uid, "label": str(data.get("label") or "")[:120],
           "updated_at": datetime.utcnow()}
    doc.update(_who())
    jira_user_col.update_one({"_id": _id}, {"$set": doc, "$setOnInsert": {"created_at": datetime.utcnow()}}, upsert=True)
    return jsonify({"ok": True, "issue_key": issue_key, "user_id": uid}), 201


@console_state_bp.route("/post-jira-link", methods=["GET"])
@login_required
@live("postjira", "/post-jira-link", ttl=15)
def list_post_jira():
    out = {}
    for d in post_jira_col.find({}, {"post_id": 1, "issue_keys": 1, "_id": 0}):
        pid = d.get("post_id")
        if pid:
            out[pid] = d.get("issue_keys", [])
    return jsonify({"links": out}), 200


@console_state_bp.route("/post-jira-link", methods=["POST"])
@login_required
def add_post_jira_link():
    """Link a Jira ticket to a Reddit post (item W4). Console-only mapping (posts have no bot-side
    Jira field), stored in console_post_jira."""
    data = request.get_json(silent=True) or {}
    post_id = (data.get("post_id") or "").strip()
    issue_key = _valid_issue_key(data.get("issue_key"))
    if not post_id or not issue_key:
        return jsonify({"error": "post_id and a valid issue_key are required"}), 400
    doc = {"post_id": post_id, "updated_at": datetime.utcnow()}
    doc.update(_who())
    post_jira_col.update_one({"post_id": post_id},
                             {"$addToSet": {"issue_keys": issue_key}, "$set": doc,
                              "$setOnInsert": {"created_at": datetime.utcnow()}}, upsert=True)
    return jsonify({"ok": True, "issue_key": issue_key}), 201
