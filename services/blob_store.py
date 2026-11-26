"""
Blob storage for the CMT bot and console.

Large base64 blobs - game-card screenshot ZIPs (`game_card_images`) and Telegram photos
(`telegram_images`) - are kept OFF the main operational Atlas cluster. Multi-MB documents there bloat
the cluster's RAM working set, which evicts hot data and slows EVERY query (image downloads were taking
tens of seconds, and the whole console degraded as cards accumulated). These blobs are read only on
demand (a Download button, a photo preview), never in the hydrate hot path, so they belong on a separate
store.

By default they live on the snapshot cluster (SNAPSHOT_MONGODB_URI, the same separate Atlas the reddit
snapshots already use); set BLOB_MONGODB_URI / BLOB_MONGODB_DATABASE to place them elsewhere. When
neither is set the store collapses onto the main DB and everything behaves exactly as before (so this is
safe to deploy before the URIs are configured).

Reads fall back to the main DB for any blob written before the migration, so nothing breaks while blobs
are being moved (additional_scripts/migrate_blobs_to_snapshot.py). Sync pymongo + os only, no bot
imports, so both the bot and the standalone console can import it.
"""
import os

from pymongo import MongoClient

_BLOB_URI = os.getenv("BLOB_MONGODB_URI") or os.getenv("SNAPSHOT_MONGODB_URI") or os.getenv("MONGODB_URI")
_BLOB_DB = os.getenv("BLOB_MONGODB_DATABASE") or os.getenv("SNAPSHOT_MONGODB_DATABASE", "reddit_snapshots")

# MongoClient does not connect at construction (it is lazy), so importing this module never blocks and
# never fails on a bad host - only an actual query would.
blob_db = MongoClient(_BLOB_URI)[_BLOB_DB]

# The legacy location on the main operational cluster, used as a read-only fallback for blobs written
# before the migration moved them here.
_main_db = MongoClient(os.getenv("MONGODB_URI"))[os.getenv("MONGODB_DATABASE", "reddit_posts")]

# True only when the blob store is a genuinely separate cluster from the main DB (the whole point). When
# the BLOB/SNAPSHOT URIs are unset the store IS the main DB, so the fallback read and the migration are
# pointless no-ops and are skipped.
SEPARATE = bool(os.getenv("BLOB_MONGODB_URI") or os.getenv("SNAPSHOT_MONGODB_URI"))


def read_blob(collection, doc_id):
    """One blob document by _id: the blob store first, then the legacy main DB (pre-migration). Returns
    None if neither has it."""
    doc = blob_db[collection].find_one({"_id": doc_id})
    if doc is None and SEPARATE:
        doc = _main_db[collection].find_one({"_id": doc_id})
    return doc


def list_blob_ids(collection):
    """Union of blob _ids across the blob store and the legacy main DB, so a card whose image has not
    been migrated yet is still listed as downloadable. Only _ids are fetched (covered by the _id index),
    so this stays cheap; after the migration the main collection is empty and its query returns instantly."""
    ids = {d["_id"] for d in blob_db[collection].find({}, {"_id": 1})}
    if SEPARATE:
        ids |= {d["_id"] for d in _main_db[collection].find({}, {"_id": 1})}
    return list(ids)


def delete_blobs(collection, query):
    """Delete matching blobs from the blob store AND (when separate) the legacy main DB, so retention
    stays effective wherever a given blob still lives. Returns the number deleted."""
    n = blob_db[collection].delete_many(query).deleted_count
    if SEPARATE:
        n += _main_db[collection].delete_many(query).deleted_count
    return n
