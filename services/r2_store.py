"""
Cloudflare R2 (S3-compatible) object store for public Known Issues screenshots.

Images are NOT stored in Mongo (big blobs starved the main Atlas cluster before, see blob_store.py):
the console uploads the bytes to an R2 bucket and the public page loads them straight from the bucket's
public URL, so neither the console server nor Mongo carries the image traffic.

Env (all required to enable uploads; reads never need them):
  R2_ACCOUNT_ID         Cloudflare account ID (the <id>.r2.cloudflarestorage.com endpoint)
  R2_ACCESS_KEY_ID      R2 API token: Access Key ID   (Object Read & Write, this bucket only)
  R2_SECRET_ACCESS_KEY  R2 API token: Secret Access Key
  R2_BUCKET             bucket name
  R2_PUBLIC_BASE        public base URL of the bucket (r2.dev subdomain or a custom domain),
                        e.g. https://pub-xxxx.r2.dev  or  https://img.cmtconsole.xyz

Minimal AWS SigV4 signing over `requests` (PUT / DELETE only), so no boto3 dependency.
"""
import hashlib
import hmac
import os
from datetime import datetime, timezone
from urllib.parse import quote

import requests

_TIMEOUT = 30


def _env(name):
    return (os.getenv(name) or "").strip()


def configured() -> bool:
    return all(_env(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE"))


def public_url(key: str) -> str:
    return _env("R2_PUBLIC_BASE").rstrip("/") + "/" + quote(key, safe="/")


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _request(method: str, key: str, body: bytes = b"", content_type: str = ""):
    account, bucket = _env("R2_ACCOUNT_ID"), _env("R2_BUCKET")
    access, secret = _env("R2_ACCESS_KEY_ID"), _env("R2_SECRET_ACCESS_KEY")
    host = "%s.r2.cloudflarestorage.com" % account
    uri = "/" + quote(bucket, safe="") + "/" + quote(key, safe="/")
    now = datetime.now(timezone.utc)
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()

    headers = {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    if content_type:
        headers["content-type"] = content_type
    if method == "PUT":
        headers["cache-control"] = "public, max-age=31536000, immutable"   # keys are unique, never rewritten
    names = sorted(headers)
    canonical = "\n".join([
        method, uri, "",
        "".join("%s:%s\n" % (n, headers[n].strip()) for n in names),
        ";".join(names), payload_hash,
    ])
    scope = "%s/auto/s3/aws4_request" % day
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode("utf-8")).hexdigest()])
    k = _hmac(("AWS4" + secret).encode("utf-8"), day)
    k = _hmac(k, "auto")
    k = _hmac(k, "s3")
    k = _hmac(k, "aws4_request")
    sig = hmac.new(k, to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers["authorization"] = "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (access, scope, ";".join(names), sig)
    send = {n: v for n, v in headers.items() if n != "host"}
    return requests.request(method, "https://" + host + uri, data=body if method == "PUT" else None,
                            headers=send, timeout=_TIMEOUT)


def get_object(key: str):
    """(bytes, content-type) of a stored object, or (None, None). Used for PRIVATE objects (feedback
    screenshots) that the console proxies behind its login instead of linking the public URL."""
    try:
        r = _request("GET", key)
    except Exception:
        return None, None
    if r.status_code // 100 != 2:
        return None, None
    return r.content, r.headers.get("Content-Type") or "application/octet-stream"


def put_object(key: str, body: bytes, content_type: str) -> str:
    """Upload bytes; returns the public URL. Raises RuntimeError on failure."""
    r = _request("PUT", key, body, content_type)
    if r.status_code // 100 != 2:
        raise RuntimeError("R2 upload failed: HTTP %s %s" % (r.status_code, (r.text or "")[:200]))
    return public_url(key)


def delete_object(key: str) -> bool:
    try:
        r = _request("DELETE", key)
        return r.status_code // 100 == 2 or r.status_code == 404
    except Exception:
        return False
