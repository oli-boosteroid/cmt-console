"""Local test harness for the CMT Console: runs the real Flask app against an in-memory mongomock
database with seeded data, so the live code path (auth, hydrate, polling) can be exercised in a
browser without touching Atlas. Usage: python run_console.py <path-to-console-repo> [port]"""
import os
import sys
import random
from datetime import datetime, timedelta

REPO = os.path.abspath(sys.argv[1])
PORT = int(os.environ.get("PORT") or (sys.argv[2] if len(sys.argv) > 2 else 8765))

# Never run against a real database: this stand signs every visitor in as admin.
for _k in ("MONGODB_URI", "SNAPSHOT_MONGODB_URI", "BLOB_MONGODB_URI"):
    _v = os.environ.get(_k, "")
    if _v and not _v.startswith("mongodb://localhost/"):
        sys.exit("harness refuses to start: %s points at a real database" % _k)

os.environ.setdefault("MONGODB_URI", "mongodb://localhost/harness")
os.environ.setdefault("SNAPSHOT_MONGODB_URI", "mongodb://localhost/harness-snap")
os.environ.setdefault("MONGODB_DATABASE", "main")
os.environ.setdefault("CONSOLE_SECRET_KEY", "harness-secret-key-not-for-production")
os.environ["CONSOLE_COOKIE_INSECURE"] = "1"
os.environ["CONSOLE_LEGACY_HOSTS"] = ""
os.environ.setdefault("DISCORD_GUILD_ID", "111111111111111111")
# A tiny fake Jira (comments + /myself only) served by this harness, so the L1 "Done -> Передано" reply can
# be exercised locally. Point JIRA_BASE_URL at a real instance only by exporting it before start.
if not os.getenv("JIRA_BASE_URL"):
    os.environ["JIRA_BASE_URL"] = "http://127.0.0.1:%s" % (sys.argv[2] if len(sys.argv) > 2 else "8765")
    os.environ.setdefault("JIRA_API_EMAIL", "harness@example.test")
    os.environ.setdefault("JIRA_API_TOKEN", "harness-token")

import mongomock

def _mm_bulk_write(self, requests, ordered=True, **kw):   # mongomock lacks newer pymongo bulk args (harness only)
    from pymongo import UpdateOne, ReplaceOne, InsertOne, DeleteOne
    for op in requests:
        f, d, up = getattr(op, "_filter", None), getattr(op, "_doc", None), getattr(op, "_upsert", False)
        if isinstance(op, UpdateOne):
            self.update_one(f, d, upsert=up)
        elif isinstance(op, ReplaceOne):
            self.replace_one(f, d, upsert=up)
        elif isinstance(op, InsertOne):
            self.insert_one(d)
        elif isinstance(op, DeleteOne):
            self.delete_one(f)


mongomock.collection.Collection.bulk_write = _mm_bulk_write
import pymongo

_clients = {}


def _client(uri=None, *a, **k):
    key = uri or "default"
    if key not in _clients:
        _clients[key] = mongomock.MongoClient()
    return _clients[key]


pymongo.MongoClient = _client
try:
    import waitress  # noqa: F401
except ImportError:   # not installed locally: the harness serves with Flask's own server instead
    import types
    _w = types.ModuleType("waitress")
    _w.serve = lambda *a, **k: None
    sys.modules["waitress"] = _w
sys.path.insert(0, REPO)
os.chdir(REPO)

import console_app  # noqa: E402  (imports blueprints, seeds bootstrap admin)
from api.routes.console_db import sync_db, snapshot_db  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

random.seed(7)
NOW = datetime.utcnow()


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- users -------------------------------------------------------------------------------------
PW = "harness-pass-1"
sync_db["console_users"].delete_many({})
ALL = ["reddit", "posts", "reddit_comments", "discord", "facebook", "telegram", "jira", "known",
       "gamecards", "maintenance", "wishlist", "actions", "schedule", "admin"]
week = {str(i): {"on": i < 5, "start": "09:00", "end": "18:00", "test_start": "", "test_end": ""} for i in range(7)}
team = [("lead@example.test", "Oleg T.", "admin"), ("anna@example.test", "Anna K.", "member"),
        ("max@example.test", "Max P.", "member"), ("ira@example.test", "Iryna S.", "member"),
        ("dan@example.test", "Danylo V.", "member")]
for _n, (email, name, role) in enumerate(team):
    sync_db["console_users"].insert_one({
        "_id": __import__("bson").ObjectId("%024x" % (1000 + _n)), "email": email, "name": name, "initials": "".join(p[0] for p in name.split()[:2]).upper(),
        "role": role, "title": "Community Team", "hours": "Mon-Fri 09:00-18:00 (Europe/Kiev)",
        "schedule": week, "permissions": ALL if role == "admin" else [p for p in ALL if p != "admin"],
        "perms_migrated": True, "perms_migrated_v2": True,
        "password_hash": generate_password_hash(PW), "created_at": NOW - timedelta(days=90)})

# ---- reddit modmail ----------------------------------------------------------------------------
SUBJ = ["Can't launch Fortnite after update", "Refund request for annual plan", "Black screen on LG TV app",
        "Session keeps disconnecting", "Rocket League stuck on loading", "Account email change",
        "Ultra plan - 4K not available?", "Payment charged twice", "Game missing from library: Dune: Awakening",
        "Controller not detected on Android", "Lag spikes in the evening", "Epic account link error 5003",
        "Subscription cancelled but still charged", "Keyboard layout wrong in session", "Xbox Game Pass sync issue",
        "Microphone not working in Rust", "Queue time over 20 minutes", "Steam Guard code loop",
        "Promo code does not apply", "Resolution stuck at 720p"]
USERS = ["frostbyte_91", "MangoLlama", "quiet_orbit", "ShadowPixel77", "noodle_knight", "retro_wave_x",
         "PixelPaladin", "lunar_tide", "CrispyByte", "velvet_static", "oak_and_iron", "Zer0Latency"]
BODY_U = ["Hi, since yesterday the game closes right after the launcher. Session ID 4f3a-91bc. I already reinstalled the app.",
          "Any update on this? It has been two days and I still can't play.",
          "Thanks, that worked. One more thing: the resolution is still capped.",
          "I tried another browser and the result is the same. Screenshot attached: https://i.redd.it/example1.png",
          "My email on the account is different from the one I'm writing from, is that a problem?"]
BODY_M = ["Hello! Thanks for reaching out. Could you send the session ID and the time the issue happened?",
          "We've passed this to the technical team. I'll update you here as soon as there is news.",
          "The fix is live now. Please restart the app and try again."]
snapshot_db["reddit_modmail_snapshot"].delete_many({})
for i in range(64):
    user = USERS[i % len(USERS)]
    age_min = int(3 + i ** 2.1)            # newest first, spreading out to weeks
    last = NOW - timedelta(minutes=age_min)
    n = 1 + (i * 7) % 5
    msgs, t = [], last - timedelta(hours=n * 3)
    for k in range(n):
        is_user = (k % 2 == 0)
        msgs.append({"id": "m%d_%d" % (i, k), "author": user if is_user else "BoosteroidSupport",
                     "is_internal": False, "date": iso(t),
                     "body": random.choice(BODY_U if is_user else BODY_M)})
        t += timedelta(hours=3)
    msgs[-1]["date"] = iso(last)
    if i % 9 == 4:
        msgs.append({"id": "m%d_n" % i, "author": "BoosteroidSupport", "is_internal": True, "date": iso(last),
                     "body": "[Console note] Waiting for L2 reply in SO-%d" % (4100 + i)})
    pub = [m for m in msgs if not m["is_internal"]]
    snapshot_db["reddit_modmail_snapshot"].insert_one({
        "convo_id": "cv%03d" % i, "subject": SUBJ[i % len(SUBJ)], "participant": user,
        "state": "archived" if i % 11 == 10 else ("inprogress" if i % 4 == 1 else "new"),
        "last_updated": iso(last), "last_activity": iso(last),
        "last_public_author": pub[-1]["author"], "mod_replied": any(m["author"] != user for m in pub),
        "num_messages": len(msgs), "num_public_messages": len(pub), "last_body": pub[-1]["body"],
        "messages": msgs})

# ---- reddit posts ------------------------------------------------------------------------------
TITLES = ["Is Boosteroid down right now?", "GTA V mod menu not loading - anyone else?", "PSA: new Nvidia drivers rolled out on EU servers",
          "Love the new 4K tier, quick review", "Marvel Rivals shader compile takes forever", "How do I use my own Steam saves?",
          "Input delay on Samsung TV 2023", "Feature request: per-game keyboard layouts", "Call of Duty anti-cheat kicks me every match",
          "Which server is best for Brazil?", "Stuck at 'connecting to session' since the patch", "Thanks support, issue solved in 10 minutes"]
snapshot_db["reddit_posts_snapshot"].delete_many({})
for i in range(42):
    created = NOW - timedelta(minutes=20 + i * 95)
    ncom = (i * 3) % 7
    comments = []
    for k in range(ncom):
        mod = (k == 1)
        comments.append({"id": "c%d_%d" % (i, k), "author": "BoosteroidSupport" if mod else USERS[(i + k) % len(USERS)],
                         "body": random.choice(BODY_M if mod else BODY_U), "created": iso(created + timedelta(minutes=12 * (k + 1))),
                         "is_submitter": k == 2, "distinguished": "moderator" if mod else None, "team": mod,
                         "reply_to_mod": k == 2, "parent_author": "BoosteroidSupport" if k == 2 else "",
                         "parent_body": BODY_M[0] if k == 2 else "", "permalink": "/r/BoosteroidCommunity/comments/p%d/_/c%d_%d" % (i, i, k)})
    snapshot_db["reddit_posts_snapshot"].insert_one({
        "post_id": "p%03d" % i, "subreddit": "BoosteroidCommunity", "title": TITLES[i % len(TITLES)],
        "author": USERS[(i * 5) % len(USERS)], "created": iso(created), "url": "https://www.reddit.com/r/BoosteroidCommunity/comments/p%03d/" % i,
        "num_comments": ncom, "flair": ["Help", "Discussion", "Feedback", ""][i % 4], "has_reply": ncom > 1,
        "last_comment_at": iso(created + timedelta(minutes=12 * ncom)) if ncom else None,
        "last_user_reply_to_mod_at": iso(created + timedelta(minutes=36)) if ncom > 2 else None,
        "body": random.choice(BODY_U), "images": [], "comments": comments})

# ---- discord tickets ---------------------------------------------------------------------------
sync_db["discord_tickets"].delete_many({})
TT = ["technical", "payment", "account", "other"]
for i in range(36):
    created = NOW - timedelta(minutes=9 + i * 140)
    user = USERS[(i * 3) % len(USERS)]
    n = 1 + (i * 5) % 6
    hist = []
    for k in range(n):
        hist.append({"author_name": user if k % 2 == 0 else "Anna K.", "content": random.choice(BODY_U if k % 2 == 0 else BODY_M),
                     "is_user": k % 2 == 0, "timestamp": created + timedelta(minutes=7 * k), "message_id": 9000000 + i * 10 + k})
    closed = i % 6 == 5
    sync_db["discord_tickets"].insert_one({
        "user_id": 400000000000000000 + i * 7919, "user_name": user, "channel_id": 500000000000000000 + i,
        "ticket_type": TT[i % 4], "ticket_number": 1 + i % 3, "status": "closed" if closed else ("in_progress" if n > 1 else "open"),
        "created_at": created, "first_response_at": (created + timedelta(minutes=7)) if n > 1 else None,
        "closed_at": (created + timedelta(hours=5)) if closed else None, "messages_count": n,
        "last_message": hist[-1]["content"], "last_message_is_user": hist[-1]["is_user"],
        "last_message_ts": hist[-1]["timestamp"],
        "metadata": {"email_or_session": "%s@mail.test" % user.lower(), "description": SUBJ[(i * 3) % len(SUBJ)]},
        "postponed_until": (NOW + timedelta(days=2)) if i % 8 == 3 else None,
        "jira_ticket_keys": ["SO-%d" % (4200 + i)] if i % 5 == 2 else [],
        "messages_history": hist, "conversation_html": ""})

sync_db["users_emails"].insert_one({"email": "", "cloud_user_id": "9444330", "platform": "Discord", "discord_user_id": 400000000000000000, "discord_username": "frostbyte_91"})
# ---- telegram / mentions / forum ---------------------------------------------------------------
sync_db["telegram_messages"].delete_many({})
for i in range(14):
    ts = NOW - timedelta(minutes=14 + i * 190)
    sync_db["telegram_messages"].insert_one({
        "chat_title": "Boosteroid Community", "user_name": USERS[(i * 2) % len(USERS)], "user_id": 70000 + i,
        "text": random.choice(BODY_U), "ts": iso(ts), "message_id": 3000 + i, "answered": i % 3 == 0,
        "reply": BODY_M[0] if i % 3 == 0 else "", "link": "https://t.me/c/123/%d" % (3000 + i)})
sync_db["discord_mentions"].delete_many({})
for i in range(9):
    ts = NOW - timedelta(minutes=30 + i * 260)
    sync_db["discord_mentions"].insert_one({
        "author_name": USERS[(i * 4) % len(USERS)], "author_id": str(400000000000000000 + i), "channel_name": ["general", "help", "bug-reports"][i % 3],
        "content": "@Moderator " + random.choice(BODY_U), "ts": iso(ts), "status": "new" if i % 2 == 0 else "replied",
        "jump_url": "https://discord.com/channels/1/2/%d" % i})
sync_db["discord_forum_posts"].delete_many({})
for i in range(11):
    ts = NOW - timedelta(minutes=50 + i * 310)
    sync_db["discord_forum_posts"].insert_one({
        "title": TITLES[(i + 3) % len(TITLES)], "author_name": USERS[(i * 5) % len(USERS)], "forum_name": ["game-requests", "tech-help"][i % 2],
        "ts": iso(ts), "created_at": iso(ts - timedelta(hours=2)), "tags": [],
        "messages": [{"author_name": USERS[(i * 5) % len(USERS)], "content": random.choice(BODY_U), "ts": iso(ts)}],
        "jump_url": "https://discord.com/channels/1/3/%d" % i})

# ---- maintenance / notes / handoffs / misc -----------------------------------------------------
sync_db["active_maintenances"].delete_many({})
for ent, typ, mins in [("Dune: Awakening", "game", 95), ("Marvel Rivals", "game", 22), ("Frankfurt-2", "server", 240)]:
    sync_db["active_maintenances"].insert_one({"entity": ent, "type": typ, "eta": "", "started_at": NOW - timedelta(minutes=mins)})
sync_db["console_notes"].delete_many({})
sync_db["console_notes"].insert_one({"context_type": "general", "ref": "", "refLabel": "", "text": "EU-West queue alert threshold moved to 15 min this week.",
                                     "author_name": "Anna K.", "author_email": "anna@example.test", "created_at": NOW - timedelta(hours=5)})
sync_db["console_notes"].insert_one({"context_type": "reddit", "ref": "cv002", "refLabel": "ModMail", "text": "User is on the old annual plan, check billing before promising a refund.",
                                     "author_name": "Max P.", "author_email": "max@example.test", "created_at": NOW - timedelta(hours=2)})
sync_db["users_emails"].delete_many({})
for i, u in enumerate(USERS):
    sync_db["users_emails"].insert_one({"email": "%s@mail.test" % u.lower(), "platform": "Reddit", "url": "https://www.reddit.com/user/%s" % u, "reddit_username": u})
for _e in [  # messy legacy rows for the "Check records" audit
        {"email": "Found.ByApi@mail.test", "cloud_user_id": "8123456", "cloud_user_id_status": "found", "platform": "Discord", "discord_user_id": 5},
        {"email": "01a1c132-ed8f-725a-9995-70b7ab6153dd", "platform": "Discord", "discord_user_id": 1},
        {"email": "7648744", "platform": "Discord", "discord_user_id": 2},
        {"email": "john@@mail", "platform": "Discord", "discord_user_id": 3},
        {"email": "gAAAAAbrokencipher", "platform": "Reddit", "reddit_username": "Ghost1"},
        {"email": "zer0latency@mail.test", "platform": "Discord", "discord_user_id": 4},
        {"email": "other@mail.test", "platform": "Reddit", "reddit_username": USERS[0]},
        {"email": "lonely@mail.test"},
        {"email": "fb.person@mail.test", "platform": "Facebook", "facebook_author": "Ana Silva"},
        {"email": "zer0latency@mail.test", "platform": "Discord", "discord_user_id": 4}]:
    sync_db["users_emails"].insert_one(_e)
sync_db["fb_author_binds"].delete_many({})
sync_db["fb_author_binds"].insert_one({"_id": "fb:100006918065621", "user_id": "5379709", "name": "Renan Feitoza"})   # old-style binding
from api.routes import fb_ingest as _fbi   # noqa: E402
from services import db_migrations as _dbm  # noqa: E402
import time as _tm; _tm.sleep(0.5)          # let the start-up thread of console_app finish first
sync_db["db_migrations"].delete_many({})    # harness only: the seed data above arrived after that run
_dbm.run_auto(sync_db)                      # what the real console does once at startup
sync_db["known_issues"].delete_many({})
sync_db["known_issues"].insert_one({"_id": "games", "category": "games", "has_entity": True, "synced_at": iso(NOW - timedelta(hours=3)), "rows": [
    {"entity": "Fortnite", "problem": "Crash after the 31.20 update", "solution": "Restart the session; fix is rolling out.", "link": "", "canned": "We are aware of the crash after the latest update..."},
    {"entity": "Dune: Awakening", "problem": "Stuck on shader compilation", "solution": "Wait up to 10 minutes on first launch.", "link": "", "canned": ""},
    {"entity": "Alan Wake 2", "problem": "Stutter in the forest area", "solution": "Lower volumetric lighting.", "link": "", "canned": ""},
    {"entity": "Alan Wake 2 (Epic)", "problem": "GPU error crash", "solution": "Disable Ray Tracing in game settings.", "link": "", "canned": ""},
    {"entity": "Alan Wake 2 (Epic)", "problem": "Epic overlay freeze", "solution": "Turn off the Epic overlay.", "link": "", "canned": ""},
    {"entity": "Rocket League", "problem": "Epic link error 5003", "solution": "Re-link the Epic account in settings.", "link": "https://example.test/kb/5003", "canned": ""}]})
sync_db["known_issues"].insert_one({"_id": "apps", "category": "apps", "has_entity": True, "synced_at": iso(NOW - timedelta(hours=3)), "rows": [
    {"entity": "LG TV", "problem": "Black screen on webOS 6", "solution": "Update the app to 1.9.4.", "link": "", "canned": ""},
    {"entity": "Desktop", "problem": "App does not start", "solution": "Reinstall the app.", "link": "", "canned": ""},
    {"entity": "Desktop", "problem": "Login loop", "solution": "Clear the app cache.", "link": "", "canned": ""},
    {"entity": "Desktop (Windows)", "problem": "Black window on launch", "solution": "Update the GPU driver.", "link": "", "canned": ""},
    {"entity": "Desktop (Windows Latest)", "problem": "Crash on exit", "solution": "Fixed in the next build.", "link": "", "canned": ""},
    {"entity": "Browser", "problem": "Safari: no sound", "solution": "Click the page once to allow audio.", "link": "", "canned": ""},
    {"entity": "Browser (Chrome)", "problem": "Stutter with extensions", "solution": "Disable ad blockers for the site.", "link": "", "canned": ""}]})
sync_db["known_issues"].insert_one({"_id": "session", "category": "session", "has_entity": False, "synced_at": iso(NOW - timedelta(hours=3)), "rows": [
    {"entity": "", "problem": "Content still encrypted", "solution": "The user gets this error if we have a DLC that the user does not own. Advise them to close this message and start the game in Steam again.", "link": "", "canned": "If you receive this error, it most likely means you do not have one of the DLCs installed on our service.\nYou can safely close the error and start the game again using your Steam library within the session."},
    {"entity": "", "problem": "Empty desktop kick", "solution": "Known platform issue, a fix is in testing.", "link": "https://example.test/browse/SO-1201", "canned": ""},
    {"entity": "", "problem": "Game's resolution is wrong", "solution": "Set the in-game resolution to 1920x1080 and restart the game.", "link": "", "canned": ""},
    {"entity": "", "problem": "Gamepad acts as mouse", "solution": "Disable Steam Input for the game in its properties.", "link": "", "canned": ""},
    {"entity": "", "problem": "Epic Games Launcher \"The connection for this site is not secure\" error", "solution": "Restart the session; the launcher certificate refresh fixes it.", "link": "", "canned": ""}]})
sync_db["known_issues"].insert_one({"_id": "account", "category": "account", "has_entity": False, "synced_at": iso(NOW - timedelta(hours=3)), "rows": [
    {"entity": "", "problem": "User is unable to select the promotional plan using the subscription change option", "solution": "The user may have a unique plan or may not meet the requirements for changing the subscription plan.\n\nIf the user meets all the requirements, the issue should be reported to the payments chat.", "link": "", "canned": ""},
    {"entity": "", "problem": "User does not see the option to subscribe via SafetyPay", "solution": "SafetyPay is only available in some regions.", "link": "", "canned": ""},
    {"entity": "", "problem": "Unable to link their Xbox account due to the error \"The resource principal named was not found\" (error code AADSTS500011)", "solution": "Ask the user to sign out of Microsoft in the browser and link again.", "link": "", "canned": "Please sign out of your Microsoft account in the browser and try linking again."}]})


# ---- simulation endpoints (harness only): mimic the bot / another operator changing data --------
app = console_app.app


# Events tab (Mattermost admin-service events): one of each kind, incl. paired + ongoing maintenances.
for i, ev in enumerate([
    {"category": "maintenance", "kind": "start", "game": "Dressmaker", "game_id": 3236, "status_from": "active", "status_to": "maintenance", "mins": 30},
    {"category": "server", "kind": "end", "server": "Sao Paulo", "status_to": "active", "mins": 75, "duration_s": 3660},
    {"category": "server", "kind": "start", "server": "Frankfurt", "status_to": "inactive", "mins": 12},
    {"category": "server", "kind": "start", "server": "Sao Paulo", "status_to": "inactive", "mins": 136, "duration_s": 3660, "ended": 75},
    {"category": "new_game", "game": "Fallout 2: A Post Nuclear Role Playing Game (Epic)", "game_id": 3222, "status_from": "disabled", "status_to": "enabled", "mins": 200},
    {"category": "game_card", "game": "Firefighting Simulator: Ignite (Xbox)", "mins": 260},
    {"category": "new_game", "game": "Fallout 2: A Post Nuclear Role Playing Game (Epic)", "game_id": 3222, "status_from": "disabled", "status_to": "enabled", "mins": 320},
    {"category": "new_game", "game": "Last Week Game", "game_id": 999, "status_from": "disabled", "status_to": "enabled", "mins": 8640},
    {"category": "regional", "kind": "end", "game": "REMATCH (Xbox)", "game_id": 2223, "region": "Brazil (BR)", "mins": 300, "duration_s": 8100},
    {"category": "regional", "kind": "start", "game": "Dune: Awakening (Xbox)", "game_id": 3166, "region": "Brazil (BR)", "mins": 420},
    {"category": "removed", "game": "Old Game", "game_id": 11, "status_from": "enabled", "status_to": "disabled", "mins": 600},
    {"category": "removed", "game": "Back Again", "game_id": 12, "status_from": "enabled", "status_to": "disabled", "mins": 900},
    {"category": "new_game", "game": "Back Again", "game_id": 12, "status_from": "disabled", "status_to": "enabled", "mins": 700},
]):
    mins = ev.pop("mins"); ended = ev.pop("ended", None)
    ev.update({"post_id": "mm%d" % i, "text": ev.get("game") or ev.get("server"), "created_at": NOW - timedelta(minutes=mins)})
    if ended is not None:
        ev["ended_at"] = NOW - timedelta(minutes=ended)
    sync_db["mm_events"].insert_one(ev)

# Game Cards: one week with an Install card (empty Description URL) + this week's new-card events.
sync_db["game_cards"].delete_many({})
sync_db["game_cards"].insert_one({"_id": "10-16 Nov", "week": "10-16 Nov", "order_index": 0, "synced_at": iso(NOW), "rows": [
    {"_row": 2, "title": "Dune: Awakening", "description": "Survival MMO on Arrakis.", "platform": "Xbox", "description_url": "",
     "pegi": "16", "release_date": "2025-06-10", "publisher": "Funcom", "developer": "Funcom", "app_link": "", "youtube": "", "related_apps": "MECCHA CHAMELEON, R.E.P.O., Party Animals, How to Fish, Party Animals (Xbox)"}]})
sync_db["game_cards"].insert_one({"_id": "17-23 Nov", "week": "17-23 Nov", "order_index": 1, "synced_at": iso(NOW), "rows": []})
# Reddit API blocked (reddit_gate down): ModMail on maintenance, Posts/Comments in RSS mode. Set
# HARNESS_REDDIT_DOWN=0 to see the normal mode.
if os.environ.get("HARNESS_REDDIT_DOWN", "1") == "1":
    sync_db["console_config"].update_one({"key": "reddit_status"}, {"$set": {"key": "reddit_status", "value": {
        "down": True, "since": iso(NOW - timedelta(days=2)), "checked_at": iso(NOW), "next_check_at": iso(NOW + timedelta(hours=1))}}}, upsert=True)
sync_db["bans"].delete_many({})
for i, (uid, sev, why, by, mins) in enumerate([
        ("10416938", "Critical", "Russia", "r.yevsenov", 30), ("4187980", "Critical", "BAN-02 use qbittorrent", "d.henda", 300),
        ("3304470", "High", "Multiple attempts to use the VM for other purposes.", "s.yeropunov", 60 * 30),
        (None, "Medium", "Crypto mining", "a.shastin", 60 * 24 * 20)]):
    sync_db["bans"].insert_one({"_id": "c:%d" % i, "channel_id": "c", "msg_id": i, "posted_at": NOW - timedelta(minutes=mins),
        "user_id": uid, "needs_user_id": uid is None, "severity": sev, "reason": why, "warned_by": [by],
        "sessions": ["01a1d62a-81ab-7087-871f-27d4e9c144a%d" % i],
        "warns": [{"n": 1, "date": "13 November, 2026 21:04:54", "severity": sev, "details": why, "warned_by": by,
                   "session": "01a1d62a-81ab-7087-871f-27d4e9c144a%d" % i}]})
# leftover email fields for the "Remove all emails" cleanup test
sync_db["bans"].update_one({"_id": "c:0"}, {"$set": {"email_hash": "deadbeef"}})
sync_db["reddit_mod_notes"].delete_many({})
sync_db["reddit_mod_notes"].insert_one({"reddit_user": "Ghost1", "email": "ghost@mail.test", "email_note_id": "n1"})
sync_db["jira_tracked_users"].delete_many({})
sync_db["jira_tracked_users"].insert_many([{"issue_key": "SO-1", "email": "old@mail.test", "email_hash": "x"},
                                           {"issue_key": "SO-2", "email": "User ID 123"}])
sync_db["discord_mentions"].update_one({}, {"$set": {"email": "Email: mention@mail.test"}})
sync_db["telegram_messages"].update_one({}, {"$set": {"email": "tg@mail.test"}})
sync_db["urg_recipients"].delete_many({})
sync_db["urg_recipients"].insert_many([{"_id": "URG-1|main", "key": "URG-1", "email": "urg@mail.test"},
                                       {"_id": "URG-1|c1", "key": "URG-1", "email": "User ID 789"}])
sync_db["console_actions"].insert_one({"type": "maintenance_notify", "status": "done", "payload": {"target": "email", "email": "maint@mail.test"}})
sync_db["game_card_meta"].delete_many({})
sync_db["game_card_meta"].insert_one({"key": "10-16 Nov||dune: awakening", "section": "Install"})
for i, g in enumerate(["REMATCH (Xbox)", "Fallout (Epic)", "Totally Unknown Game Xyz (Xbox)", "Dune: Awakening (Xbox)"]):
    sync_db["mm_events"].insert_one({"post_id": "gc%d" % i, "category": "game_card", "game": g, "text": "New game card: " + g,
                                     "created_at": NOW - timedelta(minutes=5 + i)})


# Wishlist (shape written by the bot's services/wishlist_store.py)
for c in ("wishlist_games", "wishlist_requests", "wishlist_weekly"):
    sync_db[c].delete_many({})
_wl = [("Hollow Knight: Silksong", "Steam", 41, 6, "open", ""), ("Elden Ring Nightreign", "Steam", 33, 9, "open", ""),
       ("Forza Horizon 5", "Xbox", 27, 2, "problematic", "Publisher does not allow cloud play yet"),
       ("Valorant", "Other", 19, 1, "rejected", "Kernel anti-cheat, not possible on cloud"),
       ("Hades II", "Epic", 12, 3, "open", ""), ("Stardew Valley", "Steam", 8, 0, "added", "Found in the Boosteroid catalog"),
       ("Peak", "Steam", 1, 1, "open", "")]
for i, (t, p, total, week, st, note) in enumerate(_wl):
    key = "%s|%s" % (t.lower(), p.lower())
    first = NOW - timedelta(days=2 if total == 1 else 60 + i)
    sync_db["wishlist_games"].insert_one({"key": key, "title": t, "platform": p, "status": st, "status_note": note,
        "status_by": "lead" if st != "open" else "", "status_at": NOW - timedelta(days=1) if st != "open" else None,
        "requests": total, "by_source": {"discord": total - 2, "slack": 1, "console": 1} if total > 2 else {"discord": total},
        "first_requested_at": first, "last_requested_at": NOW - timedelta(hours=3 + i), "created_at": first})
    for j in range(week):
        sync_db["wishlist_requests"].insert_one({"game_key": key, "title": t, "platform": p, "source": ["discord", "slack", "console"][j % 3],
            "requestor": "gamer_%d" % j if j % 3 == 0 else "", "author": "" if j % 3 == 0 else "lead",
            "url": "https://store.steampowered.com/app/%d/" % (1000 + i) if j % 3 == 0 else "", "created_at": NOW - timedelta(hours=3 + i + j)})
for w in range(3):
    ws = NOW - timedelta(days=7 * (w + 1))
    sync_db["wishlist_weekly"].insert_one({"_id": (ws.date()).isoformat(), "week_start": ws, "week_end": ws + timedelta(days=7),
        "requests": 25 - w * 6, "games": 9 - w, "new_games": 3 - w, "by_source": {"discord": 18 - w * 5, "slack": 4, "console": 3 - w},
        "top": [{"key": "hollow knight: silksong|steam", "title": "Hollow Knight: Silksong", "platform": "Steam", "requests": 7, "total": 35, "status": "open"},
                {"key": "forza horizon 5|xbox", "title": "Forza Horizon 5", "platform": "Xbox", "requests": 4, "total": 25, "status": "problematic"}],
        "problematic": [{"key": "forza horizon 5|xbox", "title": "Forza Horizon 5", "platform": "Xbox", "requests": 4}],
        "created_at": ws, "slack": True})

@app.before_request
def _demo_auto_login():   # harness only: every visitor is signed in as the seeded admin, no login form
    from flask import session as _s
    if os.environ.get("HARNESS_AUTOLOGIN") == "0":
        return                 # real sign-in flow (auth tests)
    if not _s.get("uid"):
        from bson import ObjectId as _Oid
        _u = sync_db["console_users"].find_one({"_id": _Oid("%024x" % 1000)}) or {}
        _s["uid"] = "%024x" % 1000
        _s["sv"] = int(_u.get("session_version") or 0)
        _s.permanent = True


@app.after_request
def _no_asset_cache(resp):   # harness only: always serve the files as they are on disk now
    from flask import request as _rq
    if _rq.path.startswith("/console/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/__sim/modmail")
def _sim_modmail():
    i = snapshot_db["reddit_modmail_snapshot"].count_documents({})
    now = iso(datetime.utcnow())
    snapshot_db["reddit_modmail_snapshot"].insert_one({
        "convo_id": "cv%03d" % i, "subject": "SIM new conversation %d" % i, "participant": "sim_user_%d" % i, "state": "new",
        "last_updated": now, "last_activity": now, "last_public_author": "sim_user_%d" % i, "mod_replied": False,
        "num_messages": 1, "num_public_messages": 1, "last_body": "Simulated incoming message %d" % i,
        "messages": [{"id": "s%d" % i, "author": "sim_user_%d" % i, "is_internal": False, "date": now, "body": "Simulated incoming message %d" % i}]})
    return "ok modmail cv%03d" % i


@app.route("/__sim/modmail-msg/<cid>")
def _sim_modmail_msg(cid):
    now = iso(datetime.utcnow())
    d = snapshot_db["reddit_modmail_snapshot"].find_one({"convo_id": cid})
    msg = {"id": "x" + now, "author": d["participant"], "is_internal": False, "date": now, "body": "Simulated follow-up at " + now}
    snapshot_db["reddit_modmail_snapshot"].update_one({"convo_id": cid}, {
        "$push": {"messages": msg}, "$inc": {"num_messages": 1, "num_public_messages": 1},
        "$set": {"last_updated": now, "last_activity": now, "last_public_author": d["participant"], "last_body": msg["body"]}})
    return "ok msg"


@app.route("/__sim/peek/<col>")
def _sim_peek(col):
    """Dev only: the email-ish fields of a collection (to check the "Remove all emails" result)."""
    from flask import jsonify
    rows = []
    for d in sync_db[col].find({}).limit(200):
        rows.append({k: str(v) for k, v in d.items() if "email" in k or k in ("_id", "cloud_user_id", "payload")})
    return jsonify(rows)


@app.route("/__sim/note")
def _sim_note():
    sync_db["console_notes"].insert_one({"context_type": "general", "ref": "", "refLabel": "", "text": "Simulated note from another operator",
                                         "author_name": "Max P.", "author_email": "max@example.test", "created_at": datetime.utcnow()})
    return "ok note"


@app.route("/__sim/ticket")
def _sim_ticket():
    now = datetime.utcnow()
    i = sync_db["discord_tickets"].count_documents({})
    sync_db["discord_tickets"].insert_one({
        "user_id": 400000000000000000 + i * 7919, "user_name": "sim_discord_%d" % i, "channel_id": 500000000000000000 + i,
        "ticket_type": "technical", "ticket_number": 1, "status": "open", "created_at": now, "first_response_at": None,
        "messages_count": 1, "last_message": "Simulated ticket message", "last_message_is_user": True, "last_message_ts": now,
        "metadata": {"email_or_session": "", "description": "SIM ticket %d" % i},
        "messages_history": [{"author_name": "sim_discord_%d" % i, "content": "Simulated ticket message", "is_user": True, "timestamp": now, "message_id": 1}]})
    return "ok ticket"


# ---- fake cloud Operations API + a stand-in for the bot worker (harness only) --------------------
# The real client (cmt-boost-main/services/cloud_api.py) is loaded by path and pointed at the two fake
# endpoints below, so the console -> queue -> worker -> API round trip can be exercised locally.
import importlib.util
import threading
import time as _time
import uuid as _uuid
from flask import request as _req, jsonify as _jsonify

_BOT = os.path.abspath(os.path.join(REPO, "..", "cmt-boost-main", "services", "cloud_api.py"))
cloud_api = None
if os.path.exists(_BOT):
    os.environ["CLOUD_API_KEY"] = "harness-key"
    os.environ["CLOUD_API_BASE_URL"] = "http://127.0.0.1:%d" % PORT
    _spec = importlib.util.spec_from_file_location("cloud_api", _BOT)
    cloud_api = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(cloud_api)

sync_db["console_users"].update_one({"email": "lead@example.test"}, {"$set": {"cloud_user_id": "9444330"}})
# Jira title index (bot: services/jira_so_index.py) + L1 In Progress follow-ups (services/jira_l1_followups.py)
sync_db["jira_so_index"].delete_many({})
for _n, _t, _s in [(14210, "Fortnite black screen after the launcher update", "Backlog"),
                   (14205, "Steam overlay not opening in Cyberpunk 2077", "Backlog"),
                   (14199, "Black screen on LG TV app after login", "Backlog"),
                   (14150, "Account email change does not save", "CM In Progress")]:
    sync_db["jira_so_index"].insert_one({"_id": "SO-%d" % _n, "key": "SO-%d" % _n, "project": "SO", "num": _n,
                                         "summary": _t, "summary_lc": _t.lower(), "status": _s, "source": "jira"})
sync_db["jira_l1_todo"].delete_many({})
for _kind, _val, _by, _cid in [("uid", "5379709", "Oleh T.", "10001"), ("discord", str(500000000000000000), "linked chat", ""),
                         ("reddit", "cv001", "Anna K.", "10002"), ("session", "0b1c2d3e-aaaa-bbbb-cccc-000000000001", "Oleh T.", "10001")]:
    sync_db["jira_l1_todo"].insert_one({"_id": "SO-14150|%s|%s" % (_kind, _val), "issue_key": "SO-14150",
                                        "summary": "Account email change does not save", "url": "", "kind": _kind,
                                        "value": _val, "label": ("User ID " + _val) if _kind == "uid" else _val, "added_by": _by,
                                        "comment_id": _cid, "comment_author": "acc-oleh" if _cid else "",
                                        "entered_at": NOW, "done": False})
sync_db["game_list"].delete_many({})
for _gid, _title, _plat in [("682", "Cyberpunk 2077 (Steam)", "steam"), ("1204", "Dune: Awakening", "steam"), ("77", "Fortnite", "epic"),
                            ("3104", "How to Fish", "steam"), ("2950", "R.E.P.O.", "steam"), ("1410", "Party Animals", "steam"),
                            ("1411", "Party Animals", "xbox"), ("1417", "Alan Wake 2", "steam"), ("1418", "Alan Wake 2", "epic")]:
    from services.game_title import norm_game_title as _ngt
    sync_db["game_list"].insert_one({"_id": _gid, "id": _gid, "title": _title, "platform": _plat, "norm": _ngt(_title)})
_API_HITS = {}
_FAKE_SESSIONS = [{"streamingSessionId": str(_uuid.UUID(int=1000 + i)), "userId": 9444330,
                   "applicationId": [682, 1204, 77, 9999][i % 4],
                   "createdAt": (NOW - timedelta(hours=3 * i + 1)).strftime("%Y-%m-%d %H:%M:%S"),
                   "startedAt": (NOW - timedelta(hours=3 * i + 1)).strftime("%Y-%m-%d %H:%M:%S"),
                   "length": 600 + i * 1900, "country": "Ukraine", "countryIsoCode": "UA", "ip": "203.0.113.7",
                   "playground": {"id": 42, "title": ["Frankfurt", "Amsterdam", "Ploiesti"][i % 3]},
                   "terminationReason": {"code": "seeyou"}} for i in range(8)]


def _fake_auth():
    if _req.headers.get("X-Api-Key") != "harness-key" or not _req.headers.get("User-Agent"):
        return _jsonify({"error": {"message": "Unauthorized."}, "error_code": 740102, "error_number": 28000013}), 401
    return None


@app.route("/api/v1/operations/users/search", methods=["POST"])
def _fake_users_search():
    bad = _fake_auth()
    if bad:
        return bad
    d = _req.get_json(silent=True) or {}
    if str(d.get("userEmail") or "").endswith("@mail.test") or d.get("userId") == 9444330:
        return _jsonify({"data": {"userId": 9444330, "userEmail": "known@mail.test", "userName": "Known",
                                  "userIsActive": True, "userIsBlocked": False, "userCategoryName": "Premium",
                                  "userCountryIsoCode": "UA"}})
    return _jsonify({"error": {"message": "User not found."}, "error_code": 740404, "error_number": 28000017}), 404


@app.route("/api/v1/operations/streaming/streaming-sessions/search", methods=["POST"])
def _fake_sessions_search():
    _API_HITS["sessions"] = _API_HITS.get("sessions", 0) + 1
    bad = _fake_auth()
    if bad:
        return bad
    d = _req.get_json(silent=True) or {}
    rows = [s for s in _FAKE_SESSIONS if (not d.get("userId") or s["userId"] == d["userId"])
            and (not d.get("streamingSessionId") or s["streamingSessionId"] == d["streamingSessionId"])]
    return _jsonify({"data": rows[: int(d.get("perPage") or 10)], "meta": {"total": len(rows), "page": 1, "perPage": 25}})


def _fake_worker():
    col = sync_db["console_actions"]
    while True:
        _time.sleep(1)
        for a in list(col.find({"status": "pending", "type": "known_issues_add"})):   # pretend the sheet took the row
            sync_db["harness_ki_rows"].insert_one(dict(a.get("payload") or {}))
            _pl = a.get("payload") or {}   # ...and show it like the bot's sheet sync would a few minutes later
            sync_db["known_issues"].update_one({"_id": _pl.get("category")}, {"$push": {"rows": {
                k: _pl.get(k, "") for k in ("entity", "problem", "solution", "link", "canned")}}})
            try:
                from api.routes import console_live as _cl, console_public as _cp
                _cl.bust("known"); _cp._ki_public_cache["payload"] = None
            except Exception:
                pass
            col.update_one({"_id": a["_id"]}, {"$set": {"status": "done", "result": {}, "finished_at": datetime.utcnow()}})
        for a in list(col.find({"status": "pending", "type": "known_issues_update"})):   # what the bot + Apps Script do
            _pl = a.get("payload") or {}
            _d = sync_db["known_issues"].find_one({"_id": _pl.get("category")}) or {}
            _rows = _d.get("rows") or []
            for _r in _rows:
                if _r.get("problem", "").strip().lower() == _pl.get("problem", "").strip().lower() and                         _r.get("entity", "").strip().lower() == _pl.get("entity", "").strip().lower():
                    _r.update({k: v for k, v in (_pl.get("set") or {}).items() if k in ("problem", "solution", "canned")})
            sync_db["known_issues"].update_one({"_id": _pl.get("category")}, {"$set": {"rows": _rows}})
            col.update_one({"_id": a["_id"]}, {"$set": {"status": "done", "result": {}, "finished_at": datetime.utcnow()}})
            try:
                from api.routes import console_live as _cl, console_public as _cp
                _cl.bust("known"); _cp._ki_public_cache["payload"] = None
            except Exception:
                pass
        for a in list(col.find({"status": "pending", "type": "known_issues_set_canned"})):
            _pl = a.get("payload") or {}
            _d = sync_db["known_issues"].find_one({"_id": _pl.get("category")}) or {}
            _rows = _d.get("rows") or []
            for _r in _rows:
                if _r.get("problem", "").strip().lower() == _pl.get("problem", "").strip().lower() and \
                        _r.get("entity", "").strip().lower() == _pl.get("entity", "").strip().lower() and not _r.get("canned"):
                    _r["canned"] = _pl.get("canned", "")
            sync_db["known_issues"].update_one({"_id": _pl.get("category")}, {"$set": {"rows": _rows}})
            col.update_one({"_id": a["_id"]}, {"$set": {"status": "done", "result": {}, "finished_at": datetime.utcnow()}})
            try:
                from api.routes import console_live as _cl, console_public as _cp
                _cl.bust("known"); _cp._ki_public_cache["payload"] = None
            except Exception:
                pass
        for a in list(col.find({"status": "pending", "type": "jira_todo"})):   # what services/jira_todo.py writes
            pl = a.get("payload") or {}
            key, op = pl.get("key", ""), pl.get("op", "")
            if op == "dismiss":
                sync_db["console_jira_dismissed"].update_one({"key": key}, {"$set": {"key": key, "status_since": pl.get("since", "")}}, upsert=True)
            else:
                sync_db["console_jira_handled"].update_one({"key": key}, {"$set": {"key": key, "status_since": pl.get("since", "")}}, upsert=True)
                if op in ("close", "stale_close", "urg_done"):
                    sync_db["jira_tickets"].update_one({"issue_key": key}, {"$set": {"status": "Done"}})
            col.update_one({"_id": a["_id"]}, {"$set": {"status": "done", "result": {"ok": True, "left": 0, "status": "Done"},
                                                         "finished_at": datetime.utcnow()}})
        for a in list(col.find({"status": "pending", "type": {"$in": ["cloud_sessions", "cloud_user_lookup"]}})):
            pl, res, err = a.get("payload") or {}, None, None
            try:
                if a["type"] == "cloud_sessions":
                    rows, err = cloud_api.recent_sessions(pl.get("user_id"), limit=pl.get("limit") or 5, force=bool(pl.get("force")))
                    if not err:
                        for r in rows:
                            g = sync_db["game_list"].find_one({"_id": str(r["application_id"])})
                            r["application"] = (g or {}).get("title") or "Application #%s" % r["application_id"]
                            r["launcher"] = str((g or {}).get("platform") or "")
                        res = {"sessions": rows}
                elif pl.get("session_id") and not pl.get("email"):
                    uid, err = cloud_api.session_owner(pl["session_id"])
                    res = None if err else {"user_id": uid}
                else:
                    res, err = cloud_api.find_user(email=pl.get("email") or "", user_id=pl.get("user_id"))
            except Exception as e:   # noqa: BLE001
                err = "harness worker: %s" % e
            col.update_one({"_id": a["_id"]}, {"$set": {"status": "error" if err else "done", "result": res,
                                                         "error": err, "finished_at": datetime.utcnow()}})


if cloud_api is not None:
    threading.Thread(target=_fake_worker, daemon=True).start()


_SLOW = {"s": 0}


@app.before_request
def _sim_slow_lists():   # harness only: /__sim/slow/<sec> delays the big first-load lists (a slow Atlas)
    from flask import request as _rq
    if _SLOW["s"] and _rq.path in ("/api/console/reddit-modmail", "/api/console/discord-tickets", "/api/console/reddit-posts"):
        _time.sleep(_SLOW["s"])


@app.route("/__sim/slow/<int:sec>")
def _sim_slow(sec):
    _SLOW["s"] = sec
    return {"slow": sec}


@app.route("/__sim/reddit-down/<int:flag>")
def _sim_reddit_down(flag):
    now = datetime.utcnow()
    sync_db["console_config"].update_one({"key": "reddit_status"}, {"$set": {"key": "reddit_status", "value": {
        "down": bool(flag), "since": iso(now - timedelta(hours=5)) if flag else "", "checked_at": iso(now),
        "next_check_at": iso(now + timedelta(minutes=55)) if flag else ""}}}, upsert=True)
    return "reddit down=%s" % bool(flag)


_FAKE_JIRA_COMMENTS = {}   # issue key -> [comment]


@app.route("/rest/api/2/myself")
def _fake_jira_myself():
    return {"accountId": "acc-harness-bot", "displayName": "CMT bot"}


@app.route("/rest/api/2/issue/<key>/comment", methods=["GET", "POST"])
def _fake_jira_comments(key):
    from flask import request as _rq
    lst = _FAKE_JIRA_COMMENTS.setdefault(key, [])
    if _rq.method == "POST":
        _d = _rq.get_json(silent=True) or {}
        c = {"id": str(20000 + len(lst)), "body": _d.get("body", ""),
             "author": {"accountId": _d.get("_as") or "acc-harness-bot"}}   # _as: harness-only, fake a human author
        lst.append(c)
        return c, 201
    newest_first = (_rq.args.get("orderBy") or "") == "-created"
    out = list(reversed(lst)) if newest_first else list(lst)
    start = int(_rq.args.get("startAt") or 0)
    return {"comments": out[start: start + int(_rq.args.get("maxResults") or 50)], "startAt": start, "total": len(out)}


@app.route("/__sim/api-hits")
def _sim_hits():
    return _jsonify(_API_HITS)


# ---- fake Google sign-in (OpenID Connect) for the SSO flow --------------------------------------------
# /__sim/google-as?email=..&hd=..&verified=1 chooses who "signs in at Google" next; the fake authorize page
# sends the browser straight back with a code, and the fake token endpoint returns an (unsigned) ID token.
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_ID", "harness-client")
os.environ.setdefault("GOOGLE_OAUTH_CLIENT_SECRET", "harness-secret")
os.environ.setdefault("CONSOLE_GOOGLE_DOMAIN", "example.test")
os.environ["GOOGLE_OAUTH_AUTH_URL"] = "http://127.0.0.1:%d/__fake_google/auth" % PORT
os.environ["GOOGLE_OAUTH_TOKEN_URL"] = "http://127.0.0.1:%d/__fake_google/token" % PORT
_GOOGLE = {"as": {"email": "lead@example.test", "hd": "example.test", "verified": True}, "codes": {}}


@app.route("/__sim/google-as")
def _sim_google_as():
    _GOOGLE["as"] = {"email": _req.args.get("email", ""), "hd": _req.args.get("hd", ""),
                     "verified": _req.args.get("verified", "1") == "1",
                     "aud": _req.args.get("aud", ""), "nonce": _req.args.get("nonce", "")}
    return _jsonify(_GOOGLE["as"])


@app.route("/__fake_google/auth")
def _fake_google_auth():
    from flask import redirect as _redir
    import secrets as _sec
    from urllib.parse import urlencode as _ue
    code = _sec.token_urlsafe(8)
    _GOOGLE["codes"][code] = dict(_GOOGLE["as"], nonce_sent=_req.args.get("nonce", ""),
                                  client_id=_req.args.get("client_id", ""))
    return _redir(_req.args["redirect_uri"] + "?" + _ue({"code": code, "state": _req.args.get("state", "")}))


@app.route("/__fake_google/token", methods=["POST"])
def _fake_google_token():
    import base64 as _b64, json as _js, time as _t
    c = _GOOGLE["codes"].pop(_req.form.get("code", ""), None)
    if not c or _req.form.get("client_secret") != os.environ["GOOGLE_OAUTH_CLIENT_SECRET"]:
        return _jsonify({"error": "invalid_grant"}), 400
    claims = {"iss": "https://accounts.google.com", "aud": c.get("aud") or c["client_id"],
              "exp": int(_t.time()) + 3600, "nonce": c.get("nonce") or c["nonce_sent"],
              "email": c["email"], "email_verified": c["verified"]}
    if c.get("hd"):
        claims["hd"] = c["hd"]
    enc = lambda o: _b64.urlsafe_b64encode(_js.dumps(o).encode()).decode().rstrip("=")
    return _jsonify({"id_token": enc({"alg": "none"}) + "." + enc(claims) + ".", "access_token": "x"})


# ---- fake Cloudflare R2 (screenshots): objects kept in memory, served at /__r2/<key> ------------
from services import r2_store as _r2  # noqa: E402
_R2_OBJECTS = {}
os.environ.update({"R2_ACCOUNT_ID": "harness", "R2_ACCESS_KEY_ID": "x", "R2_SECRET_ACCESS_KEY": "x",
                   "R2_BUCKET": "harness", "R2_PUBLIC_BASE": "http://localhost:%d/__r2" % PORT})


def _r2_put(key, body, ctype):
    _R2_OBJECTS[key] = (body, ctype)
    return _r2.public_url(key)


_r2.put_object = _r2_put
_r2.delete_object = lambda key: _R2_OBJECTS.pop(key, None) is not None or True
_r2.get_object = lambda key: _R2_OBJECTS.get(key, (None, None))


@app.route("/__r2/<path:key>")
def _fake_r2(key):
    from flask import Response, abort
    if key not in _R2_OBJECTS:
        abort(404)
    body, ctype = _R2_OBJECTS[key]
    return Response(body, mimetype=ctype)


@app.route("/__sim/r2")
def _sim_r2():
    return _jsonify(sorted(_R2_OBJECTS))


if __name__ == "__main__":
    print("harness: http://localhost:%d/console/  (login lead@example.test / see PW in this file)" % PORT, flush=True)
    app.run(host="127.0.0.1", port=PORT, threaded=True, debug=False, use_reloader=False)
