"""
Jira HTTP for the console, with or without the Jira key.

Two modes, chosen by environment:
  - JIRA_GATEWAY_URL set (console on the corporate VM): the console holds NO Jira credentials. Every call to
    the Jira host is forwarded to the bot's internal Jira gateway (cmt-boost-main/services/jira_gateway.py)
    on the Docker network, which adds the credentials, allows only the Jira API paths the console uses and
    logs who asked. Auth to the gateway: JIRA_GATEWAY_TOKEN (useless outside the VM network).
  - otherwise (today on Railway): direct calls with JIRA_API_EMAIL / JIRA_API_TOKEN, as before.

The module mirrors the parts of `requests` the console uses (get / post / put / request, and any other
attribute such as RequestException is delegated), so console_api.py imports it as `requests` and every call
site stays the same. Calls to other hosts (e.g. the Steam store search) go straight to `requests`.
"""
import logging
import os

import requests as _requests

logger = logging.getLogger(__name__)


def gateway_url() -> str:
    return (os.getenv("JIRA_GATEWAY_URL") or "").rstrip("/")


def base_url() -> str:
    return (os.getenv("JIRA_BASE_URL") or "").rstrip("/")


def credentials():
    """(base, email, token) for the console's Jira code. In gateway mode email/token are placeholders: the
    real ones live only on the bot, and the Authorization header built from them is dropped before sending."""
    base = base_url()
    if gateway_url():
        return base, "via-gateway", "via-gateway"
    return base, os.getenv("JIRA_API_EMAIL", ""), os.getenv("JIRA_API_TOKEN", "")


def _who():
    try:
        from api.routes.console_auth import current_user
        return (current_user() or {}).get("email", "")
    except Exception:
        return ""


def request(method, url, **kw):
    gw, base = gateway_url(), base_url()
    if not (gw and base and isinstance(url, str) and (url == base or url.startswith(base + "/"))):
        return _requests.request(method, url, **kw)
    timeout = kw.pop("timeout", 30)
    stream = kw.pop("stream", False)
    kw.pop("allow_redirects", None)                     # the gateway never follows redirects
    headers = {k: v for k, v in (kw.pop("headers", None) or {}).items() if k.lower() != "authorization"}
    prepared = _requests.Request(method.upper(), url, headers=headers, params=kw.pop("params", None),
                                 json=kw.pop("json", None), data=kw.pop("data", None),
                                 files=kw.pop("files", None)).prepare()
    if kw:
        logger.debug("[JiraHTTP] ignored request options in gateway mode: %s", sorted(kw))
    fwd = {"X-Gateway-Token": os.getenv("JIRA_GATEWAY_TOKEN", ""),
           "X-Jira-Method": prepared.method,
           "X-Jira-Path": prepared.url[len(base):] or "/",
           "X-Console-User": _who()}
    for h in ("Content-Type", "Accept", "X-Atlassian-Token"):
        if prepared.headers.get(h):
            fwd["X-Jira-" + h] = prepared.headers[h]
    return _requests.post(gw + "/internal/jira", data=prepared.body or b"", headers=fwd,
                          timeout=timeout, stream=stream)


def get(url, **kw):
    return request("GET", url, **kw)


def post(url, **kw):
    return request("POST", url, **kw)


def put(url, **kw):
    return request("PUT", url, **kw)


def __getattr__(name):            # RequestException, exceptions, ... -> the real requests module
    return getattr(_requests, name)
