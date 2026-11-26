"""
Standalone entrypoint for the CMT Console.

Runs ONLY the console - the static site at /console/ plus the read API and auth at
/api/console/* - against the same Atlas MongoDB the bot uses. It starts NO Discord/
Reddit/Slack/Telegram loops, so it can run as its own small service (e.g. on Railway)
without ever touching the bot's machine. Console and bot rendezvous only through the
shared Atlas database.

Environment (set these as Railway service Variables):
  MONGODB_URI          - same Atlas connection string the bot uses
  MONGODB_DATABASE     - same database name (default: reddit_posts)
  CONSOLE_SECRET_KEY   - random secret so sessions survive restarts
  PORT                 - injected by Railway; the app binds to it
  CONSOLE_COOKIE_INSECURE=1  - optional, only for plain-HTTP local testing
"""
import os
import logging
from datetime import timedelta

from dotenv import load_dotenv

# Load env BEFORE importing the console modules (they read MONGODB_URI at import
# time). On Railway the Variables are already in the environment; load_dotenv does
# not override them, it only fills in from a local .env during development.
load_dotenv()

from flask import Flask, redirect, request
from waitress import serve

from api.routes.console import console_bp
from api.routes.console_api import console_api_bp
from api.routes.console_auth import console_auth_bp, ensure_bootstrap
from api.routes.console_state import console_state_bp
from api.routes.console_public import console_public_bp
from api.routes.fb_ingest import fb_ingest_bp
from api.routes.urg_settings import urg_settings_bp
from api.routes.admin_db import admin_db_bp
from api.routes.google_sso import google_sso_bp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("console_app")

app = Flask(__name__)

_secret = os.getenv("CONSOLE_SECRET_KEY")
if not _secret:
    logger.warning("[Console] CONSOLE_SECRET_KEY not set - sessions reset on restart. Set it in Railway Variables.")
app.secret_key = _secret or os.urandom(32)

app.permanent_session_lifetime = timedelta(days=2)   # signed out after 2 days WITHOUT a visit (see REFRESH below)
app.config.update(
    MAX_CONTENT_LENGTH=55 * 1024 * 1024,   # reject oversized bodies before buffering (attach cap is 50MB)
    # SLIDING expiry: every request re-issues the cookie, so an active user is never signed out mid-work;
    # only 2 full days without visiting the console requires a new login.
    SESSION_REFRESH_EACH_REQUEST=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Railway serves over HTTPS, so the session cookie must be Secure. Set
    # CONSOLE_COOKIE_INSECURE=1 only if you ever run this over plain HTTP locally.
    SESSION_COOKIE_SECURE=os.getenv("CONSOLE_COOKIE_INSECURE") != "1",
)

app.register_blueprint(console_bp)        # /console/ static site
app.register_blueprint(console_api_bp)    # /api/console/* read API
app.register_blueprint(console_auth_bp)   # /api/console/* auth + user management
app.register_blueprint(console_state_bp)  # /api/console/* notes + tags (shared, team-wide)
app.register_blueprint(console_public_bp)  # PUBLIC (no auth): /knownissues + /api/console/public/*
app.register_blueprint(fb_ingest_bp)     # Facebook feed from the CMT browser extension: /api/fb/* + /api/console/fb-*
app.register_blueprint(urg_settings_bp)  # Urgent Request form: Verification switch
app.register_blueprint(admin_db_bp)      # admin: numbered database migration steps (Preview / Apply)
app.register_blueprint(google_sso_bp)    # sign-in with the company Google account: /api/console/sso/*

# One-time data moves that lose nothing run once at start-up (services/db_migrations.py, "auto" steps).
try:
    from services import db_migrations as _dbm
    from api.routes.console_db import sync_db as _sync_db
    import threading as _th
    _th.Thread(target=_dbm.run_auto, args=(_sync_db,), daemon=True, name="db-migrations").start()
except Exception as _e:
    logging.getLogger(__name__).error("[DBMigrations] could not start: %s", _e)


# Baseline security headers + a strict Content-Security-Policy for the console page. The console is a
# self-contained vanilla-JS app (no CDNs), so 'self' works; images may come from Reddit/Discord over
# https, and inline style attributes need 'unsafe-inline' for styles only (scripts stay locked to 'self').
_CSP = ("default-src 'self'; img-src 'self' data: https:; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; "
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; "
        "form-action 'self'; object-src 'none'")


def _gzip_response(resp):
    """Compress text responses (JS/CSS/JSON/HTML/SVG) when the client accepts gzip. Biggest win is
    the ~single large app.js; API JSON benefits too. Skips small bodies and already-encoded ones."""
    import gzip as _gz
    try:
        if "gzip" not in (request.headers.get("Accept-Encoding") or "").lower():
            return resp
        if resp.status_code < 200 or resp.status_code >= 300 or resp.headers.get("Content-Encoding"):
            return resp
        ctype = resp.mimetype or ""
        ok = (ctype.startswith("text/") or ctype in ("application/javascript", "application/json",
              "image/svg+xml", "application/manifest+json") or ctype.endswith("+json"))
        if not ok:
            return resp
        resp.direct_passthrough = False   # load file/stream bodies into memory so we can compress them
        data = resp.get_data()
        if len(data) < 1024:
            return resp
        comp = _gz.compress(data, 6)
        resp.set_data(comp)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Content-Length"] = str(len(comp))
        resp.headers["Vary"] = "Accept-Encoding"
    except Exception as _e:
        logger.debug("ignored: %s", _e)
    return resp


# The console moved from beta.cmtconsole.xyz to cmtconsole.xyz: every request to an old host is sent
# to the same path on the new one. 308 keeps the method and body, so even an API call from a tab left
# open on the old address lands correctly (sign-in is needed once, cookies are per-domain).
_LEGACY_HOSTS = {h.strip().lower() for h in os.getenv("CONSOLE_LEGACY_HOSTS", "beta.cmtconsole.xyz").split(",") if h.strip()}
_CANONICAL_HOST = os.getenv("CONSOLE_CANONICAL_HOST", "cmtconsole.xyz").strip()


@app.before_request
def _redirect_legacy_host():
    host = (request.headers.get("X-Forwarded-Host") or request.host or "").split(",")[0].split(":")[0].strip().lower()
    if host in _LEGACY_HOSTS and _CANONICAL_HOST:
        qs = request.query_string.decode("utf-8", "ignore")
        return redirect("https://" + _CANONICAL_HOST + request.path + ("?" + qs if qs else ""), code=308)


@app.after_request
def _security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()")
    # HSTS only over HTTPS (Railway prod). Never when the console is deliberately run over plain HTTP.
    if os.getenv("CONSOLE_COOKIE_INSECURE") != "1" and (request.is_secure or
            request.headers.get("X-Forwarded-Proto", "").lower() == "https"):
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if (resp.mimetype or "").startswith("text/html"):
        resp.headers.setdefault("Content-Security-Policy", _CSP)
    return _gzip_response(resp)


@app.route("/")
def _root():
    # The bare domain must NOT auto-forward to the console; only the direct /console/ link opens it (same
    # as /knownissues). Return a plain 404 so the root reveals nothing.
    return "Not found", 404


# Seed the bootstrap admin if the user collection is empty (a fresh database). Idempotent.
try:
    ensure_bootstrap()
except Exception as e:  # never crash startup on a transient Mongo hiccup
    logger.error("[Console] ensure_bootstrap failed at startup: %s", e)

# Ensure the read-query indexes exist (idempotent, non-blocking) so growing collections stay fast.
try:
    from services.ensure_indexes import ensure_indexes
    ensure_indexes()
except Exception as e:
    logger.error("[Console] ensure_indexes failed at startup: %s", e)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    # The console SPA fires ~40 parallel requests on every page load (hydrate). Waitress defaults to only
    # 4 threads, so those serialise and the task queue backs up (queue-depth warnings + slow loads). These
    # requests are almost entirely Mongo-I/O-bound, so the threads sit idle waiting - a larger pool costs
    # little CPU/RAM and lets a full hydrate (and several concurrent users) be served without queueing.
    threads = int(os.getenv("CONSOLE_THREADS", "32"))
    logger.info("[Console] serving on 0.0.0.0:%s (threads=%s)", port, threads)
    serve(app, host="0.0.0.0", port=port, threads=threads, connection_limit=400, channel_timeout=120)
