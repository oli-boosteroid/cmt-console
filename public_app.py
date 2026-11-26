"""
Public Known Issues service: ONLY the no-login pages, separate from the console.

On the corporate VM the public Known Issues page runs as its own container from this entrypoint, so the
part of the system that anyone on the internet can reach holds nothing else:
  - no console pages and no console API (no login, no conversations, no admin);
  - its own MongoDB user that may only read the published Known Issues / Game List and add suggestions,
    feedback and rate-limit rows (see the role in docs/vm-deploy.md);
  - nothing is published until an admin approves it in the console.

Routes (all from api/routes/console_public.py): /knownissues[/<game id>], /knownissues.js,
/api/console/public/*, /cmthelper/terms, /cmthelper/privacy. Everything else answers 404.

Environment: MONGODB_URI (the public user), MONGODB_DATABASE, R2_* (screenshots), PORT.
"""
import os
import logging

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, request  # noqa: E402

from api.routes.console_public import console_public_bp  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("public_app")

app = Flask(__name__)
app.config.update(MAX_CONTENT_LENGTH=2 * 1024 * 1024)   # one screenshot + overhead; console_public caps further
app.register_blueprint(console_public_bp)

_CSP = ("default-src 'self'; img-src 'self' data: https:; "
        "style-src 'self' 'unsafe-inline'; font-src 'self'; "
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; "
        "form-action 'self'; object-src 'none'")


@app.after_request
def _security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()")
    if request.is_secure or request.headers.get("X-Forwarded-Proto", "").lower() == "https":
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if (resp.mimetype or "").startswith("text/html"):
        resp.headers.setdefault("Content-Security-Policy", _CSP)
    return resp


@app.route("/")
def _root():
    return "Not found", 404


if __name__ == "__main__":
    from waitress import serve
    port = int(os.getenv("PORT", "8081"))
    logger.info("[PublicKI] serving on 0.0.0.0:%s", port)
    serve(app, host="0.0.0.0", port=port, threads=int(os.getenv("PUBLIC_THREADS", "8")),
          connection_limit=200, channel_timeout=60)
