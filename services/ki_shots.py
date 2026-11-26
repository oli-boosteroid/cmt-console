"""
Screenshots attached to Known Issues rows (stored in R2, see services/r2_store.py).

Known Issues rows come from the Google Sheet and have no ID, so a screenshot is bound to its row by a
content key: category + entity + problem (lowercased, whitespace collapsed). The key is computed here
only (server side), both when uploading and when serving rows, so the console and the public page always
agree. Editing a row's Problem/Game text in the sheet detaches its screenshots (they stay in the
collection and come back if the text is restored).

Collection `known_issue_shots`: {_id: issue key, category, entity, problem,
                                 shots: [{id, key (R2 object key), url, by, at}]}
"""
import hashlib
import re

MAX_PER_ISSUE = 6


def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def issue_key(category, entity, problem) -> str:
    raw = "%s|%s|%s" % (_norm(category), _norm(entity), _norm(problem))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def shots_map(db) -> dict:
    """issue key -> [{id, url}] for every issue that has screenshots (a small collection)."""
    out = {}
    for d in db["known_issue_shots"].find({"shots.0": {"$exists": True}}, {"shots.id": 1, "shots.url": 1}):
        out[d["_id"]] = [{"id": s.get("id"), "url": s.get("url")} for s in (d.get("shots") or []) if s.get("url")]
    return out


def attach(category, rows, smap) -> list:
    """Copies of `rows` with a `shots` list on the rows that have screenshots."""
    out = []
    for r in rows or []:
        r2 = dict(r)
        s = smap.get(issue_key(category, r.get("entity"), r.get("problem")))
        if s:
            r2["shots"] = s
        out.append(r2)
    return out


def sniff_image(head: bytes):
    """(extension, content-type) from the file's magic bytes, or None for anything that isn't a
    PNG / JPEG / WebP (the extension/MIME the browser sends is not trusted)."""
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", "image/png"
    if head[:3] == b"\xff\xd8\xff":
        return "jpg", "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


# --- screenshots on SUGGESTIONS (anyone who suggests; private until an admin approves) --------------
# Limits: 3 per suggestion, 1 MB each (the browser already shrinks to 1920px WebP, ~100-400 KB), uploads
# only with the one-time token returned when the suggestion was created (valid 30 min), and a per-IP
# hourly cap so the public page can't be used as free image hosting. Stored under sug/ in R2; the admin
# sees them through an authed proxy; Approve moves them onto the issue, Reject deletes them.
SUG_MAX = 3
SUG_MAX_BYTES = 1024 * 1024
SUG_TOKEN_MIN = 30
SUG_IP_HOURLY = 12


def new_upload_token(doc, now):
    import secrets
    from datetime import timedelta
    doc["upload_token"] = secrets.token_urlsafe(24)
    doc["upload_until"] = now + timedelta(minutes=SUG_TOKEN_MIN)
    return doc["upload_token"]


def store_suggestion_shot(db, sid, token, fileobj, ip=""):
    """Validate + upload one suggestion screenshot. Returns (http_status, json_dict)."""
    import hmac
    import uuid
    from datetime import datetime, timedelta
    from bson import ObjectId
    from services import r2_store
    if not r2_store.configured():
        return 200, {"ok": False, "error": "Screenshots are not available right now"}
    try:
        oid = ObjectId(sid)
    except Exception:
        return 400, {"ok": False, "error": "bad id"}
    col = db["known_issues_suggestions"]
    doc = col.find_one({"_id": oid}, {"upload_token": 1, "upload_until": 1, "shots": 1})
    if not doc or not doc.get("upload_token") or not hmac.compare_digest(str(token or ""), doc["upload_token"]):
        return 403, {"ok": False, "error": "upload not allowed"}
    now = datetime.utcnow()
    if doc.get("upload_until") and doc["upload_until"] < now:
        return 403, {"ok": False, "error": "upload window expired"}
    if len(doc.get("shots") or []) >= SUG_MAX:
        return 200, {"ok": False, "error": "max %d screenshots" % SUG_MAX}
    rate = db["public_shot_rate"]
    if ip:
        try:
            if rate.count_documents({"ip": ip, "at": {"$gte": now - timedelta(hours=1)}}) >= SUG_IP_HOURLY:
                return 429, {"ok": False, "error": "Too many screenshots. Please try again later."}
        except Exception:
            pass
    if not fileobj:
        return 200, {"ok": False, "error": "no file"}
    data = fileobj.read(SUG_MAX_BYTES + 1)
    if len(data) > SUG_MAX_BYTES:
        return 200, {"ok": False, "error": "image is too big (max 1 MB)"}
    kind = sniff_image(data[:16])
    if not kind:
        return 200, {"ok": False, "error": "only PNG, JPEG or WebP images"}
    shot_id = uuid.uuid4().hex
    key = "sug/%s.%s" % (uuid.uuid4().hex, kind[0])   # storage name != the id admins see in links
    try:
        r2_store.put_object(key, data, kind[1])
    except Exception:
        return 200, {"ok": False, "error": "upload failed, please try again"}
    col.update_one({"_id": oid}, {"$push": {"shots": {"id": shot_id, "key": key, "at": now}}})
    if ip:
        try:
            rate.insert_one({"ip": ip, "at": now})
        except Exception:
            pass
    return 200, {"ok": True, "shot": {"id": shot_id}}


def delete_suggestion_shots(shots):
    from services import r2_store
    if not r2_store.configured():
        return
    for x in shots or []:
        if x.get("key"):
            r2_store.delete_object(x["key"])
