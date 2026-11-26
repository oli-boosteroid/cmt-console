"""
Serves the CMT Console static site (the `web/` folder) from the bot's own Flask
app, so the console is hosted on the same server the bot already runs on (no
separate Railway service). The console is a dependency-free static site, so this
is just static file serving under `/console/`.

Served JS/CSS/HTML is MINIFIED at serve time (comments + whitespace stripped) so nothing readable
lands in DevTools; the source files keep their comments. Set CONSOLE_MINIFY_ASSETS=0 to disable.
"""
import os
import zlib
from pathlib import Path

from flask import Blueprint, request, send_from_directory

# api/routes/console.py -> parents: routes -> api -> project root, then /web
WEB_DIR = Path(__file__).parent.parent.parent / 'web'

console_bp = Blueprint('console', __name__)

_MINIFY = os.getenv("CONSOLE_MINIFY_ASSETS", "1") != "0"
_min_cache = {}   # (filename, size, crc32) -> minified bytes


def minify_asset(filename, data):
    """Strip comments/whitespace from a served .js/.css/.html body so DevTools shows nothing readable.
    Cached by (filename, size, crc32). Any failure (minifier missing, parse issue) falls back to the original
    bytes, so this can never break serving."""
    if not _MINIFY:
        return data
    low = (filename or "").lower()
    if not low.endswith((".js", ".css", ".html", ".htm")):
        return data
    key = (filename, len(data), zlib.crc32(data))   # content-keyed: a same-length edit must not hit a stale entry
    hit = _min_cache.get(key)
    if hit is not None:
        return hit
    out = data
    try:
        text = data.decode("utf-8")
        if low.endswith(".js"):
            import rjsmin
            out = rjsmin.jsmin(text).encode("utf-8")
        elif low.endswith(".css"):
            import rcssmin
            out = rcssmin.cssmin(text).encode("utf-8")
        else:
            import re as _re
            import rcssmin
            text = _re.sub(r"(?is)<style[^>]*>(.*?)</style>",
                           lambda m: "<style>" + rcssmin.cssmin(m.group(1)) + "</style>", text)
            text = _re.sub(r"(?s)<!--(?!\[if).*?-->", "", text)   # drop HTML comments (keep IE conditionals)
            out = text.encode("utf-8")
    except Exception:
        out = data
    _min_cache[key] = out
    return out


def _served(resp, filename):
    low = (filename or "").lower()
    if low.endswith((".js", ".css", ".html", ".htm")):
        try:
            resp.direct_passthrough = False
            resp.set_data(minify_asset(filename, resp.get_data()))
        except Exception:
            pass
    return resp


@console_bp.route('/console/')
def console_index():
    """Serve the console entry page. The trailing slash is required so the page's
    relative asset paths (css/..., js/...) resolve under /console/. Flask
    auto-redirects /console -> /console/."""
    return _served(send_from_directory(WEB_DIR, 'index.html'), 'index.html')


@console_bp.route('/console/<path:filename>')
def console_asset(filename):
    """Serve CSS/JS/other assets. send_from_directory is confined to WEB_DIR, so
    it cannot serve files outside the console folder (e.g. .env)."""
    return _served(send_from_directory(WEB_DIR, filename), filename)


@console_bp.after_request
def _console_static_cache(resp):
    """Caching for the static console: index.html must always revalidate so a new deploy's
    ?v= bump is fetched immediately, while the versioned assets (js/css/icons, requested as
    file?v=N) can cache hard - a new deploy changes N, which is a fresh URL."""
    p = request.path or ""
    # index.html and sw.js are loaded WITHOUT a ?v cache-buster, so they must revalidate every time or
    # a new deploy would never be picked up. Everything else is requested as file?v=N (versioned URL).
    if p == "/console/" or p.endswith("/index.html") or p.endswith("/sw.js"):
        resp.headers["Cache-Control"] = "no-cache"
    else:
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    return resp
