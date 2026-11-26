"""
Numbered database migration steps for the shared Atlas (bot + console).

- Every step runs once; what it did is written to the log and to the `db_migrations` collection
  ({_id: step id, name, status, applied_at, applied_by, result}). Running a step again is safe.
- "auto" steps only add or move data without losing anything; they run at console start-up
  (run_auto, called from console_app.py) and are skipped once recorded.
- "manual" steps delete data: an admin sees the numbers first (Preview) and confirms (Apply) in
  Admin > Data > Database maintenance. Nothing manual ever runs by itself.
- Step 0 is a read-only report of every collection (count, last write, size, email fields), used to
  decide what happens to the remaining candidates.
"""
import logging
from datetime import datetime

logger = logging.getLogger(__name__)
_col_name = "db_migrations"


def _done(db, step_id):
    return db[_col_name].find_one({"_id": step_id, "status": "done"}) is not None


def _record(db, step, result, by):
    db[_col_name].update_one({"_id": step["id"]}, {"$set": {
        "name": step["name"], "status": "done", "applied_at": datetime.utcnow(), "applied_by": by,
        "result": result}}, upsert=True)
    logger.info("[DBMigrations] step %s (%s) applied by %s: %s", step["id"], step["name"], by, result)


# ── step 0: report ───────────────────────────────────────────────────────────────────────────────
# Collections the code reads or writes (main DB). Anything in the database that is not listed here
# shows up in the report as "not in code".
KNOWN = {
    "active_maintenances", "bans", "bans_meta", "console_actions", "console_activity", "console_config",
    "console_convo_replied", "console_convo_status", "console_fb_notes", "console_feedback",
    "console_forum_status", "console_handoffs", "console_jira_dismissed", "console_jira_handled",
    "console_jira_tickets", "console_leave_requests", "console_login_attempts", "console_notes",
    "console_notify_feed", "console_notify_links", "console_notify_prefs", "console_post_flags",
    "console_post_jira", "console_presence", "console_push_subs", "console_reads", "console_relay_state",
    "console_reminders_state", "console_reports", "console_templates", "console_users", "db_migrations",
    "devvit_chunks", "devvit_inbox", "discord_forum_posts", "discord_mentions", "discord_notifications",
    "discord_tickets", "fb_author_binds", "fb_dms", "fb_posts", "game_card_images",
    "game_card_meta", "game_cards", "game_list", "game_testing", "image_ratelimit_whitelist", "issues",
    "jira_l1_todo", "jira_so_index", "jira_tickets", "jira_tracked_users", "jira_user_links", "known_issues",
    "known_issues_suggestions", "maintenance_subscriptions", "mm_cursor", "mm_events", "posts",
    "public_feedback_rate", "public_suggest_rate", "reddit_convo_notes", "reddit_mod_notes",
    "reddit_reply_authors", "reply_log", "seen_facebook_posts", "seen_reddit_comments", "seen_reddit_modmail",
    "seen_reddit_posts", "slack_pins", "team_schedule", "telegram_images", "telegram_messages",
    "testing_sessions", "urg_dedup", "urg_own", "urg_recipients", "users_emails", "wishlist_counts",
    "wishlist_submissions", "wishlist_url_mappings",
}
_TIME_FIELDS = ("created_at", "updated_at", "ts", "timestamp", "at", "created", "finished_at", "last_updated")
_EMAIL_FIELDS = ("email", "email_hash", "emails", "email_enc", "payload.email", "metadata.email_or_session")


def _last_write(col):
    """Newest time we can see: the ObjectId time of the newest _id, or a time field."""
    best = None
    try:
        d = col.find_one({}, {"_id": 1}, sort=[("_id", -1)])
        gt = getattr((d or {}).get("_id"), "generation_time", None)
        if gt:
            best = gt.replace(tzinfo=None)
    except Exception as _e:
        logger.debug("ignored: %s", _e)
    for f in _TIME_FIELDS:
        try:
            d = col.find_one({f: {"$type": "date"}}, {f: 1}, sort=[(f, -1)])
        except Exception:
            continue
        v = (d or {}).get(f)
        if isinstance(v, datetime):
            v = v.replace(tzinfo=None)
            best = v if best is None or v > best else best
    return best.isoformat() + "Z" if best else None


def report(db):
    rows = []
    for name in sorted(db.list_collection_names()):
        if name.startswith("system."):
            continue
        col = db[name]
        row = {"name": name, "in_code": name in KNOWN}
        try:
            row["count"] = col.estimated_document_count()
        except Exception as e:
            row["count"] = None
            row["error"] = type(e).__name__
        try:
            st = db.command("collStats", name)
            row["size_mb"] = round((st.get("size") or 0) / 1048576, 2)
            row["indexes"] = st.get("nindexes")
        except Exception:
            row["size_mb"] = None
        row["last_write"] = _last_write(col)
        n_mail = 0
        for f in _EMAIL_FIELDS:
            try:
                n_mail += col.count_documents({f: {"$regex": "@"}}, limit=100000)
            except Exception as _e:
                logger.debug("ignored: %s", _e)
        row["with_email"] = n_mail
        rows.append(row)
    missing = sorted(KNOWN - {r["name"] for r in rows})
    return {"collections": rows, "in_code_but_absent": missing}


# ── auto steps (no data lost; moved here from import-time code) ──────────────────────────────────
def _auto_fb_binds(db):
    from api.routes import fb_ingest
    return fb_ingest.move_old_binds()


def _auto_fb_text_keys(db):
    from api.routes import fb_ingest
    return fb_ingest.backfill_text_keys()


def _auto_reply_log(db):
    from api.routes import console_state
    return console_state.reply_log_backfill()


def _auto_jira_merge(db):
    """Copy console_jira_tickets into the one jira_tickets collection (services/jira_store.py). Fields the
    bot already mirrored there are not overwritten; nothing is deleted (step 16 drops the old store)."""
    from services import jira_store
    if "console_jira_tickets" not in db.list_collection_names():
        return {"copied": 0, "note": "no old console store"}
    col = db[jira_store.COLLECTION]
    copied = filled = 0
    for d in db["console_jira_tickets"].find({}):
        rec = jira_store.from_console(d)
        cur = col.find_one({"issue_key": d.get("issue_key")}, {"jira_updated": 1})
        if cur is None:
            col.insert_one(rec)
            copied += 1
        elif not cur.get("jira_updated"):
            col.update_one({"_id": cur["_id"]}, {"$set": rec})
            filled += 1
        else:
            col.update_one({"_id": cur["_id"]}, {"$set": {"console": True}})
    return {"new_tickets": copied, "filled_existing": filled}


def _auto_tag_context(db):
    """Old Slack tag records in `issues` get context_type / ref (one schema with the console tags)."""
    from services import issue_tags
    from api.routes.console_db import snapshot_db
    done = skipped = 0
    url_map = issue_tags.post_url_map(snapshot_db)     # one pass over the snapshots, not a query per record
    for d in db["issues"].find({"context_type": {"$exists": False}, "tags.0": {"$exists": True}},
                               {"post_url": 1, "ticket_url": 1, "platform": 1}):
        ctx, ref = issue_tags.context_for(db, snapshot_db, d.get("post_url"), d.get("ticket_url"), d.get("platform"),
                                          url_map=url_map)
        if ctx:
            db["issues"].update_one({"_id": d["_id"]}, {"$set": {"context_type": ctx, "ref": ref}})
            done += 1
        else:
            skipped += 1
    return {"linked_to_chat": done, "no_chat_found": skipped}


# ── manual steps (delete data: Preview first, Apply on an admin's confirmation) ─────────────────
def _drop_preview(name):
    def f(db):
        return {"collection": name, "documents": db[name].estimated_document_count()}
    return f


def _drop_apply(name):
    def f(db):
        n = db[name].estimated_document_count()
        db[name].drop()
        return {"collection": name, "dropped_documents": n}
    return f




_BLOB_COLS = ("game_card_images", "telegram_images")


def _blob_stores():
    from services import blob_store
    return blob_store.SEPARATE, blob_store.blob_db, blob_store._main_db


def _blobs_preview(db):
    separate, blob_db, main_db = _blob_stores()
    if not separate:
        return {"skipped": "the blob store is the main database (no separate cluster configured)"}
    out = {}
    for c in _BLOB_COLS:
        ids = [d["_id"] for d in main_db[c].find({}, {"_id": 1})]
        have = {d["_id"] for d in blob_db[c].find({"_id": {"$in": ids}}, {"_id": 1})} if ids else set()
        out[c] = {"left_on_main": len(ids), "already_in_blob_store": len(have), "to_copy": len(ids) - len(have)}
    return out


def _blobs_apply(db):
    separate, blob_db, main_db = _blob_stores()
    if not separate:
        return {"skipped": "the blob store is the main database"}
    out = {}
    for c in _BLOB_COLS:
        copied = removed = 0
        for d in main_db[c].find({}):
            if not blob_db[c].find_one({"_id": d["_id"]}, {"_id": 1}):
                blob_db[c].insert_one(d)
                copied += 1
            main_db[c].delete_one({"_id": d["_id"]})
            removed += 1
        out[c] = {"copied_to_blob_store": copied, "removed_from_main": removed}
    return out


STEPS = [
    {"id": 1, "name": "Facebook: old author bindings into the user directory", "kind": "auto", "run": _auto_fb_binds},
    {"id": 2, "name": "Facebook: text keys for old posts", "kind": "auto", "run": _auto_fb_text_keys},
    {"id": 3, "name": "Reply log: copy replies still in the action queue", "kind": "auto", "run": _auto_reply_log},
    {"id": 4, "name": "Jira: one jira_tickets collection (copy console_jira_tickets into it)", "kind": "auto", "run": _auto_jira_merge},
    {"id": 5, "name": "Tags: Slack tag records get their chat (one schema with console tags)", "kind": "auto", "run": _auto_tag_context},
    {"id": 10, "name": "Drop the unused 'posts' collection (old Reddit posts writer, removed)", "kind": "manual",
     "preview": _drop_preview("posts"), "apply": _drop_apply("posts")},
    {"id": 11, "name": "Drop 'jira_tracked_users' (tracked Jira users feature removed; holds emails)", "kind": "manual",
     "preview": _drop_preview("jira_tracked_users"), "apply": _drop_apply("jira_tracked_users")},
    {"id": 13, "name": "Move Game Cards / Telegram images left on the main cluster to the blob store", "kind": "manual",
     "preview": _blobs_preview, "apply": _blobs_apply},
    {"id": 14, "name": "Drop 'seen_facebook_posts' (the rss.app webhook is gone; the report counts fb_posts)", "kind": "manual",
     "preview": _drop_preview("seen_facebook_posts"), "apply": _drop_apply("seen_facebook_posts")},
    {"id": 15, "name": "Drop 'discord_notifications' (the report counts discord_mentions + discord_forum_posts)", "kind": "manual",
     "preview": _drop_preview("discord_notifications"), "apply": _drop_apply("discord_notifications")},
    {"id": 16, "name": "Drop 'console_jira_tickets' (copied into jira_tickets by step 4)", "kind": "manual",
     "preview": _drop_preview("console_jira_tickets"), "apply": _drop_apply("console_jira_tickets")},
]
_BY_ID = {s["id"]: s for s in STEPS}


def run_auto(db):
    """Run every auto step that has not run yet. Called once at start-up; never raises."""
    for step in STEPS:
        if step["kind"] != "auto":
            continue
        try:
            if _done(db, step["id"]):
                continue
            _record(db, step, step["run"](db), "startup")
        except Exception as e:
            logger.error("[DBMigrations] auto step %s (%s) failed: %s", step["id"], step["name"], e, exc_info=True)


def status(db):
    recs = {d["_id"]: d for d in db[_col_name].find({})}
    out = []
    for s in STEPS:
        r = recs.get(s["id"]) or {}
        out.append({"id": s["id"], "name": s["name"], "kind": s["kind"], "status": r.get("status") or "pending",
                    "applied_at": r["applied_at"].isoformat() + "Z" if isinstance(r.get("applied_at"), datetime) else None,
                    "applied_by": r.get("applied_by"), "result": r.get("result")})
    return out


def run_manual(db, step_id, apply, by):
    """Preview (counts only) or Apply one manual step. Returns (result, error)."""
    step = _BY_ID.get(step_id)
    if not step or step["kind"] != "manual":
        return None, "unknown step"
    if not apply:
        return {"preview": step["preview"](db), "done_before": _done(db, step_id)}, None
    result = step["apply"](db)
    _record(db, step, result, by)
    return {"applied": result}, None
