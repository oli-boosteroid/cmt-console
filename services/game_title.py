"""
Shared game-title normalization for matching Known Issues entities <-> the Game List sheet.

The Game List sheet never carries a trademark symbol (eFootball, not eFootball(TM)) and never puts the
launcher in the title (the launcher lives in its own column), whereas a Known Issues game can be written
"Fortnite (Epic)" or "eFootball(TM)". So to match the two we strip:
  - trademark / copyright symbols (TM, R, C, SM, P),
  - a single trailing "(...)" launcher tag,
then collapse whitespace and lowercase.

Kept tiny and dependency-free; the SAME logic is mirrored in JS (normGameTitle) in web/js/app.js and
web/knownissues.js - keep the three in sync.
"""
import re

_TM_RE = re.compile("[™®©℠℗]")   # TM, (R), (C), (SM), (P)
_LAUNCHER_SUFFIX_RE = re.compile(r"\s*\(([^)]*)\)\s*$")     # a trailing "(Epic)" / "(Steam)" / "(Xbox)" tag


def split_launcher(s):
    """(base, launcher) from a game name. 'Ghost (Xbox)' -> ('ghost', 'xbox'); 'Ghost' -> ('ghost', '').
    The launcher (from the trailing paren) is matched against the Game List's Platform column."""
    s = _TM_RE.sub("", str(s or "").strip())
    launcher = ""
    m = _LAUNCHER_SUFFIX_RE.search(s)
    if m:
        launcher = m.group(1).strip().lower()
        s = s[:m.start()]
    base = re.sub(r"\s{2,}", " ", s).strip().lower()
    return base, launcher


def norm_game_title(s) -> str:
    return split_launcher(s)[0]


def game_match_key(s) -> str:
    """Key used to map a Known Issues entity to its Game-List IDs: base title + launcher, so a launcher-
    tagged name ('Foo (Xbox)') is distinct from the plain name ('Foo') and each resolves to its own IDs."""
    base, launcher = split_launcher(s)
    return base + "|" + launcher
