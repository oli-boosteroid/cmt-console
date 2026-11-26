"""
Lightweight Mongo access for the CMT Console.

Deliberately has NO bot dependencies (no Slack, no Reddit, no Motor): importing
this module must not require any credentials beyond `MONGODB_URI`. That lets the
console run as its own small service (e.g. on Railway) against the same Atlas DB
the bot uses, without dragging in the bot's heavy import chain
(`services.mongo_db_service` pulls slack_sdk + reddit_service and requires
SLACK_TOKEN just to import).

`console_api.py` and `console_auth.py` import their Mongo handles from here, so
they work both inside the bot process and in the standalone console service.
"""
import os
from pathlib import Path

from pymongo import MongoClient
from dotenv import load_dotenv

# Local dev reads .env; on Railway the values come from service Variables (already
# in the environment, so load_dotenv without override leaves them untouched).
load_dotenv(Path(__file__).parent.parent.parent / ".env")

_client = MongoClient(os.getenv("MONGODB_URI"))
sync_db = _client[os.getenv("MONGODB_DATABASE", "reddit_posts")]

# Separate DB for the heavy Reddit snapshots (modmail/posts) so they never bloat the main
# Atlas. Falls back to the main DB when SNAPSHOT_MONGODB_URI is unset. The bot writes here
# (services/reddit_snapshot.py); the console only reads.
_snap_client = MongoClient(os.getenv("SNAPSHOT_MONGODB_URI") or os.getenv("MONGODB_URI"))
snapshot_db = _snap_client[os.getenv("SNAPSHOT_MONGODB_DATABASE", "reddit_snapshots")]

# Collections the console reads (same names as services/mongo_db_service.py).
sync_discord_tickets_collection = sync_db["discord_tickets"]
sync_users_emails_collection = sync_db["users_emails"]
sync_reddit_mod_notes_collection = sync_db["reddit_mod_notes"]


# Helper queries - mirror services/mongo_db_service.py exactly so the console
# sees the same data whether it runs in the bot or standalone.
def get_all_reddit_mod_notes_sync() -> list:
    return list(sync_reddit_mod_notes_collection.find({}))

