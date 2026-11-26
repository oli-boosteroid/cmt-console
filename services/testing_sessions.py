"""
Testing sessions - ONE implementation for Slack and the console.

This file is identical in both projects (cmt-boost-main/services and cmt-console/services); each side
passes its own handle of the shared `testing_sessions` collection. The 08:00 daily report reads these
documents (Slack schema: session_id, game, result, ticket_url, environment, issue, created_by,
testing_tags, created_at [, updated_at, updated_by]).
"""
from datetime import datetime

from bson import ObjectId
from bson.errors import InvalidId

FORMAT_ERROR = ("Invalid format in one or more sessions. Each session needs an ID: line and an "
                "Application: line.")
EMPTY_ERROR = "Enter at least one session (ID: + Application:)."


def parse(session_raw):
    """Pasted session text -> ([(session_id, game), ...], error). The whole paste is refused when any
    session is malformed (all-or-nothing, same on both sides)."""
    from utils.session_parser import parse_session_blocks
    _header, sessions = parse_session_blocks((session_raw or "").strip())
    if not sessions:
        return [], EMPTY_ERROR
    out = []
    for s in sessions:
        if not s.get("session_id") or not s.get("game"):
            return [], FORMAT_ERROR
        out.append((s["session_id"], s["game"]))
    return out, None


def _fields(environment, issue, result, ticket_url, tags):
    return {"result": (result or "").strip(), "ticket_url": (ticket_url or "").strip(),
            "environment": (environment or "").strip(), "issue": (issue or "").strip(),
            "testing_tags": [t for t in (tags or []) if t]}


def add(col, session_raw, environment, issue, result, ticket_url, tags, created_by):
    """Save every pasted session. Returns (inserted ids, error)."""
    sessions, err = parse(session_raw)
    if err:
        return [], err
    base = _fields(environment, issue, result, ticket_url, tags)
    ids = []
    for sid, game in sessions:
        doc = dict(base, session_id=sid, game=game, created_by=created_by, created_at=datetime.utcnow())
        ids.append(str(col.insert_one(doc).inserted_id))
    return ids, None


def update(col, mongo_id, session_raw, environment, issue, result, ticket_url, tags, updated_by, only_author=None):
    """Edit one saved session (the first session of the pasted text). `only_author` limits the edit to
    that author's own sessions (None = anyone, e.g. an admin). Returns (doc, error)."""
    try:
        oid = ObjectId(str(mongo_id))
    except (InvalidId, TypeError):
        return None, "bad id"
    sessions, err = parse(session_raw)
    if err:
        return None, err
    sid, game = sessions[0]
    q = {"_id": oid}
    if only_author is not None:
        q["created_by"] = only_author
    upd = dict(_fields(environment, issue, result, ticket_url, tags), session_id=sid, game=game,
               updated_at=datetime.utcnow(), updated_by=updated_by)
    res = col.find_one_and_update(q, {"$set": upd}, return_document=True)
    if not res:
        return None, "not found (or not your session)"
    return res, None
