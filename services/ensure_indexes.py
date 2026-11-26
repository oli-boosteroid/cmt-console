"""
Create the indexes the console's hot read queries need, so growing collections stay fast instead of
doing full-collection scans + in-memory sorts on every hydrate/refresh.

Idempotent and safe: create_index is a no-op when the index already exists, every index is built in its
own try/except so one failure never blocks the rest or crashes startup. Only console_actions.dedup_key
is unique: it is a new sparse field, so there is no old duplicate data for it to clash with. Indexes are server-side, so running this from either
the bot or the console creates them for the whole shared cluster.

Called once at startup from main.py (bot) and console_app.py (console).
"""
import logging

logger = logging.getLogger(__name__)

# (handle_name, collection, keys, kwargs). handle_name picks the cluster: "sync" = main operational DB,
# "snapshot" = the reddit snapshot cluster, "blob" = the blob store.
_INDEXES = [
    # Main cluster - the lists the console pulls on every load, sorted/filtered by these fields.
    ("sync", "discord_tickets", [("status", 1), ("created_at", -1)], {}),
    ("sync", "discord_tickets", [("created_at", -1)], {}),
    ("sync", "reddit_reply_authors", [("convo_id", 1), ("created_at", 1)], {}),   # who sent a console reply
    ("sync", "jira_tickets", [("console", 1), ("jira_updated", -1)], {}),
    ("sync", "jira_tickets", [("status", 1)], {}),
    ("sync", "jira_tickets", [("issue_key", 1)], {}),
    ("sync", "telegram_messages", [("ts", -1)], {}),
    ("sync", "discord_mentions", [("ts", -1)], {}),
    ("sync", "discord_forum_posts", [("ts", -1)], {}),   # Forum tab sort (was an in-memory sort)
    ("sync", "discord_mentions", [("status", 1)], {}),
    ("sync", "users_emails", [("discord_user_id", 1)], {}),
    ("sync", "users_emails", [("reddit_username", 1)], {}),
    ("sync", "users_emails", [("facebook_author", 1)], {}),
    # The shared `issues` store is large and /tags scans it twice (console tags + Slack-tag merge).
    ("sync", "issues", [("source", 1), ("tag", 1)], {}),
    ("sync", "issues", [("created_at", -1)], {}),
    ("sync", "issues", [("context_type", 1), ("ref", 1)], {}),
    # Double-submit guard for the action queue. The one unique index here: dedup_key is a new field
    # (sparse, so older actions without it are skipped), so there is no old duplicate data to clash with.
    ("sync", "console_actions", [("dedup_key", 1)], {"unique": True, "sparse": True}),
    ("sync", "console_actions", [("dedup_fp", 1), ("created_at", -1)], {"sparse": True}),
    # Snapshot cluster - the reddit lists + the comments-that-reply-to-us query.
    ("snapshot", "reddit_posts_snapshot", [("created", -1)], {}),
    ("snapshot", "reddit_posts_snapshot", [("post_id", 1)], {}),
    ("snapshot", "reddit_posts_snapshot", [("url", 1)], {}),   # a Slack tag record finds its post by URL
    ("snapshot", "reddit_posts_snapshot", [("comments.reply_to_mod", 1), ("last_user_reply_to_mod_at", -1)], {}),
    ("snapshot", "reddit_modmail_snapshot", [("last_updated", -1)], {}),
    ("snapshot", "reddit_modmail_snapshot", [("convo_id", 1)], {}),
]


def ensure_indexes():
    try:
        from api.routes import console_db
        from services import blob_store
    except Exception as e:
        logger.warning("[Indexes] could not import DB handles, skipping: %s", e)
        return
    handles = {"sync": getattr(console_db, "sync_db", None),
               "snapshot": getattr(console_db, "snapshot_db", None),
               "blob": getattr(blob_store, "blob_db", None)}
    made = 0
    for handle_name, coll, keys, kwargs in _INDEXES:
        db = handles.get(handle_name)
        if db is None:
            continue
        try:
            # Modern MongoDB (Atlas 5+) builds indexes without blocking reads/writes; these collections
            # are small so the build is near-instant. create_index is a no-op if the index already exists.
            db[coll].create_index(keys, **kwargs)
            made += 1
        except Exception as e:
            logger.warning("[Indexes] %s.%s %s failed: %s", handle_name, coll, keys, e)
    logger.info("[Indexes] ensured %d/%d indexes", made, len(_INDEXES))
