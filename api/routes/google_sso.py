"""
Sign-in with the company Google account (OpenID Connect, authorization-code flow).

Flow: the login screen links to /api/console/sso/google/start -> Google -> /api/console/sso/google/callback.
The callback exchanges the one-time code for an ID token directly with Google's token endpoint over TLS
(server to server, with the client secret). Per OpenID Connect Core 3.1.3.7 a token received that way may be
validated by TLS instead of its signature; every claim is still checked:
  iss = Google, aud = our client ID, not expired, nonce = the one we sent, email_verified,
  hd (Workspace domain) in CONSOLE_GOOGLE_DOMAIN and the e-mail itself in that domain.
Only people who already have a console account (Admin > Users, same e-mail) get in; nobody is created here.

Environment:
  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   OAuth client (type "Web application", consent "Internal")
  CONSOLE_GOOGLE_DOMAIN       company Workspace domain(s), comma-separated (required: no domain = SSO off)
  CONSOLE_PUBLIC_URL          public base URL of the console, for the redirect URI (else the request host)
  CONSOLE_PASSWORD_LOGIN=0    turn e-mail + password sign-in off once Google sign-in works (console_auth.py)
Redirect URI to register in Google Cloud: <CONSOLE_PUBLIC_URL>/api/console/sso/google/callback
"""
import base64
import json
import logging
import os
import secrets
import time
from urllib.parse import urlencode

import requests
from flask import Blueprint, jsonify, redirect, request, session

logger = logging.getLogger(__name__)

google_sso_bp = Blueprint("google_sso", __name__, url_prefix="/api/console/sso")

_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
_STATE_TTL = 600   # seconds a started sign-in stays valid


def _auth_url():
    return os.getenv("GOOGLE_OAUTH_AUTH_URL") or _AUTH_URL     # override only for the local test stand


def _token_url():
    return os.getenv("GOOGLE_OAUTH_TOKEN_URL") or _TOKEN_URL


def _client_id():
    return (os.getenv("GOOGLE_OAUTH_CLIENT_ID") or "").strip()


def _domains():
    return [d.strip().lower() for d in (os.getenv("CONSOLE_GOOGLE_DOMAIN") or "").split(",") if d.strip()]


def google_enabled() -> bool:
    return bool(_client_id() and (os.getenv("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip() and _domains())


def password_login_enabled() -> bool:
    return os.getenv("CONSOLE_PASSWORD_LOGIN", "1") != "0"


def _redirect_uri():
    base = (os.getenv("CONSOLE_PUBLIC_URL") or request.host_url).rstrip("/")
    if base.startswith("http://") and "//localhost" not in base and "//127.0.0.1" not in base:
        base = "https://" + base[len("http://"):]   # behind a TLS-terminating proxy the request looks like http
    return base + "/api/console/sso/google/callback"


def _back(error=""):
    """Back to the console; an error code goes into the query so the login screen can explain it."""
    return redirect("/console/" + (("?sso_error=" + error) if error else ""), code=302)


def _jwt_claims(token: str) -> dict:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part.encode()).decode("utf-8"))
    except Exception:
        return {}


@google_sso_bp.route("/config", methods=["GET"])
def sso_config():
    """Public: which sign-in methods the login screen should offer."""
    return jsonify({"google": google_enabled(), "password": password_login_enabled()}), 200


@google_sso_bp.route("/google/start", methods=["GET"])
def google_start():
    if not google_enabled():
        return _back("not_configured")
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    session["sso"] = {"state": state, "nonce": nonce, "at": int(time.time())}
    params = {"client_id": _client_id(), "redirect_uri": _redirect_uri(), "response_type": "code",
              "scope": "openid email profile", "state": state, "nonce": nonce, "prompt": "select_account"}
    if len(_domains()) == 1:
        params["hd"] = _domains()[0]          # a hint for Google's account picker; enforced again below
    return redirect(_auth_url() + "?" + urlencode(params), code=302)


@google_sso_bp.route("/google/callback", methods=["GET"])
def google_callback():
    from api.routes.console_auth import users_col, _new_session_for
    started = session.pop("sso", None) or {}
    if not google_enabled():
        return _back("not_configured")
    if request.args.get("error"):
        return _back("cancelled")
    state = request.args.get("state") or ""
    if not started.get("state") or not secrets.compare_digest(state, started["state"]) \
            or int(time.time()) - int(started.get("at") or 0) > _STATE_TTL:
        return _back("expired")
    code = request.args.get("code") or ""
    if not code:
        return _back("failed")
    try:
        r = requests.post(_token_url(), data={
            "code": code, "client_id": _client_id(), "client_secret": os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", ""),
            "redirect_uri": _redirect_uri(), "grant_type": "authorization_code"}, timeout=15)
    except Exception as e:
        logger.warning("[GoogleSSO] token request failed: %s", type(e).__name__)
        return _back("failed")
    if r.status_code != 200:
        logger.warning("[GoogleSSO] token endpoint answered %s", r.status_code)
        return _back("failed")
    claims = _jwt_claims((r.json() or {}).get("id_token") or "")
    email = str(claims.get("email") or "").strip().lower()
    domain = email.rsplit("@", 1)[-1] if "@" in email else ""
    hd = str(claims.get("hd") or "").lower()
    checks = (
        claims.get("iss") in _ISSUERS,
        claims.get("aud") == _client_id(),
        int(claims.get("exp") or 0) > time.time(),
        bool(started.get("nonce")) and claims.get("nonce") == started.get("nonce"),
        claims.get("email_verified") is True,
    )
    if not all(checks):
        logger.warning("[GoogleSSO] ID token rejected (claims did not check out)")
        return _back("failed")
    if hd not in _domains() or domain not in _domains():
        logger.info("[GoogleSSO] sign-in refused for an account outside the company domain")
        return _back("domain")
    user = users_col.find_one({"email": email})
    if not user:
        logger.info("[GoogleSSO] %s has no console account", email)
        return _back("no_account")
    _new_session_for(user)
    users_col.update_one({"_id": user["_id"]}, {"$set": {"last_login_at": __import__("datetime").datetime.utcnow(),
                                                         "last_login_via": "google"}})
    logger.info("[GoogleSSO] %s signed in", email)
    return _back()
