"""
One schema for tags in the `issues` collection (identical file in the bot and the console).

Every tag record - from Slack (Add Information / custom issue) or the console - carries the report
fields (tags[], platform, post_url / ticket_url, created_by, created_at: read by the daily reports and
the per-user stats) AND the chat it belongs to (context_type: post / convo / ticket, ref), so the console
can show and remove a tag on its chat without guessing the chat from the URL.

context_for() finds the chat from the URLs once, when the record is written (and once for old records:
console migration step 5).
"""
import re

_MODMAIL_RE = re.compile(r"/mail/[a-zA-Z]+/([A-Za-z0-9_-]+)")
_CHANNEL_RE = re.compile(r"discord(?:app)?\.com/channels/\d+/(\d+)", re.I)
_JIRA_RE = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")


def post_url_map(snapshot_db):
    """{post url: post_id} of every Reddit post snapshot (for bulk work like the migration)."""
    return {d["url"]: str(d.get("post_id")) for d in snapshot_db["reddit_posts_snapshot"].find(
        {"url": {"$nin": [None, ""]}}, {"url": 1, "post_id": 1, "_id": 0}) if d.get("post_id")}


def context_for(main_db, snapshot_db, post_url="", ticket_url="", platform="", url_map=None):
    """(context_type, ref) of the chat a tag record belongs to, or (None, None). `url_map` (from
    post_url_map) replaces the per-record snapshot lookup when many records are processed."""
    post_url = (post_url or "").strip()
    ticket_url = (ticket_url or "").strip()
    low = post_url.lower()
    if post_url and url_map is not None:
        if post_url in url_map:
            return "post", url_map[post_url]
    elif post_url and snapshot_db is not None:
        p = snapshot_db["reddit_posts_snapshot"].find_one({"url": post_url}, {"post_id": 1})
        if p and p.get("post_id"):
            return "post", str(p["post_id"])
    if "mod.reddit.com/mail/" in low:
        m = _MODMAIL_RE.search(post_url)
        if m:
            return "convo", m.group(1)
    if (platform or "").lower() == "discord" or "discord.com/channels/" in low:
        cm = _CHANNEL_RE.search(post_url)
        if cm:
            cid = cm.group(1)
            t = main_db["discord_tickets"].find_one({"channel_id": {"$in": [cid, int(cid)]}}, {"_id": 1},
                                                    sort=[("created_at", -1)])
            if t:
                return "ticket", str(t["_id"])
        jm = _JIRA_RE.search((ticket_url + " " + post_url).upper())
        if jm:
            k = jm.group(1)
            t = main_db["discord_tickets"].find_one({"$or": [{"jira_ticket_key": k}, {"jira_ticket_keys": k}]},
                                                    {"_id": 1}, sort=[("created_at", -1)])
            if t:
                return "ticket", str(t["_id"])
    return None, None


def add_context(main_db, snapshot_db, doc):
    """Set context_type / ref on a tag record (in place) when its chat can be found. Returns doc."""
    if doc.get("context_type") and doc.get("ref"):
        return doc
    ctx, ref = context_for(main_db, snapshot_db, doc.get("post_url"), doc.get("ticket_url"), doc.get("platform"))
    if ctx:
        doc["context_type"], doc["ref"] = ctx, ref
    return doc
