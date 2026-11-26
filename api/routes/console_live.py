"""
Shared short-lived cache for the list endpoints the console polls, plus the version map behind
GET /api/console/poll.

Why: without it every open console would re-request ~17 lists on a timer, and each request would re-read
its collection from Mongo even when nothing changed (an ETag saves only the response body, not the query).

How it works:
  * A list view is wrapped with @live("key", ...). Its JSON body is built at most once per TTL and
    shared by every user; the ETag is the body hash.
  * GET /poll returns {key: etag} for every registered list the caller may see. The client polls that
    one small endpoint every few seconds and re-fetches only the lists whose etag changed.
  * A console write that changes a list calls bust("key") so the writer sees it on the next poll
    instead of after the TTL.

Only the plain list form of an endpoint is shared (the exact query string given at registration).
Any other query (paging, search, per-user lookups) falls through to the view untouched.
"""
import hashlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import wraps

from flask import Response, current_app, request

API_PREFIX = "/api/console"

_REG = {}        # key -> {"perm", "path", "query", "ttl", "fn"}
_ENTRIES = {}    # key -> (built_at, body_bytes, etag)
_LOCKS = {}      # key -> Lock (one rebuild at a time per list)
_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="console-live")


def _lock(key):
    lk = _LOCKS.get(key)
    if lk is None:
        lk = _LOCKS.setdefault(key, threading.Lock())
    return lk


def _body_of(rv):
    """Bytes of a view's return value ((response, status) tuple or a bare response). None when the
    view did not answer 200, so an error is never cached."""
    status = 200
    resp = rv
    if isinstance(rv, tuple):
        resp = rv[0]
        if len(rv) > 1 and isinstance(rv[1], int):
            status = rv[1]
    if status != 200 or not hasattr(resp, "get_data"):
        return None
    return resp.get_data()


def _fresh(key):
    ent = _ENTRIES.get(key)
    spec = _REG.get(key)
    if ent and spec and (time.time() - ent[0]) < spec["ttl"]:
        return ent
    return None


def _build(app, key):
    """Return a fresh (built_at, body, etag) for `key`, rebuilding it when the TTL has passed.
    Runs the wrapped view inside its own request context so it sees exactly the registered query."""
    ent = _fresh(key)
    if ent:
        return ent
    spec = _REG[key]
    with _lock(key):
        ent = _fresh(key)
        if ent:
            return ent
        url = API_PREFIX + spec["path"] + (("?" + spec["query"]) if spec["query"] else "")
        with app.test_request_context(url):
            body = _body_of(spec["fn"]())
        if body is None:
            return _ENTRIES.get(key)   # keep serving the previous copy if the rebuild failed
        ent = (time.time(), body, hashlib.sha1(body).hexdigest())
        _ENTRIES[key] = ent
        return ent


def bust(*keys):
    """Drop cached lists after a write so the next read or poll rebuilds them."""
    for k in keys:
        _ENTRIES.pop(k, None)


def live(key, path, perm=None, query="", ttl=6):
    """Decorator for a list view. Place it UNDER the auth decorator: auth still runs per request,
    only the body is shared. `path` is the route path under /api/console, `query` the exact query
    string of the shared form ("" for none), `perm` the section permission /poll checks."""
    def deco(fn):
        _REG[key] = {"perm": perm, "path": path, "query": query, "ttl": ttl, "fn": fn}

        @wraps(fn)
        def wrapper(*args, **kwargs):
            if request.method != "GET" or (request.query_string or b"").decode("utf-8", "ignore") != query:
                return fn(*args, **kwargs)
            try:
                ent = _build(current_app._get_current_object(), key)
            except Exception:
                ent = None
            if not ent:
                return fn(*args, **kwargs)
            resp = Response(ent[1], mimetype="application/json")
            resp.set_etag(ent[2])
            return resp, 200
        return wrapper
    return deco


def paths(can_see):
    """{key: "/path?query"} of every registered list `can_see(perm)` allows (static, nothing is built)."""
    return {k: spec["path"] + (("?" + spec["query"]) if spec["query"] else "")
            for k, spec in _REG.items() if can_see(spec["perm"])}


def versions(can_see):
    """{key: etag} for every registered list `can_see(perm)` allows. Stale lists are rebuilt in
    parallel; a list that fails to build is left out (the client keeps what it has)."""
    app = current_app._get_current_object()
    keys = [k for k, spec in _REG.items() if can_see(spec["perm"])]
    out = {}
    stale = []
    for k in keys:
        ent = _fresh(k)
        if ent:
            out[k] = ent[2]
        else:
            stale.append(k)
    if stale:
        def run(k):
            try:
                return k, _build(app, k)
            except Exception:
                return k, None
        for k, ent in _POOL.map(run, stale):
            if ent:
                out[k] = ent[2]
    return out


# Console writes -> the lists they change. Matched on the path under /api/console (prefix match), so a
# successful write drops the affected cache and the next poll shows it to everyone at once.
_WRITE_BUSTS = [
    ("/convo-status", ("cstatus",)), ("/post-flags", ("flags",)), ("/tags", ("tags",)), ("/reads", ("reads",)),
    ("/convo-replied", ("replied",)), ("/forum-status", ("fstatus",)), ("/telegram-status", ("tg",)),
    ("/mention-status", ("mentions",)), ("/presence", ("presence",)), ("/notes", ("notes",)),
    ("/handoffs", ("handoffs",)), ("/activity", ("activity",)), ("/feedback", ("feedback",)),
    ("/post-jira-link", ("postjira",)), ("/jira-user-link", ("juser",)), ("/templates", ("templates",)), ("/fb-notes", ("fbnotes",)),
    ("/fb-group-check", ("fbcheck",)), ("/history-cutoff", ("cutoff",)), ("/jira-handled", ("jhandled",)),
    ("/jira-dismissed", ("jdismissed",)), ("/jira-l1-todo", ("jl1",)), ("/jira-sync", ("jira",)), ("/jira-transition", ("jira",)),
    ("/reddit-jira-link", ("modnotes",)), ("/discord-jira-link", ("tickets",)), ("/users", ("roster",)),
]


def after_write(resp):
    """Blueprint after_request hook: bust the lists a successful write touched."""
    try:
        if request.method != "GET" and 200 <= resp.status_code < 300:
            p = (request.path or "")
            if p.startswith(API_PREFIX):
                p = p[len(API_PREFIX):]
                for prefix, keys in _WRITE_BUSTS:
                    if p == prefix or p.startswith(prefix + "/"):
                        bust(*keys)
    except Exception:
        pass
    return resp
