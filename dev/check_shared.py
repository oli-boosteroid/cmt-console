"""Check that the modules shared by the bot and the console are byte-identical.

usage: python dev/check_shared.py [path-to-cmt-boost-main]   (default: ../cmt-boost-main)
Exit code 1 when a shared file differs - copy the newer one to the other project before deploying.
blob_store.py and ensure_indexes.py exist in both but differ on purpose (each side has its own DB handles
and index list), so they are not checked here.
"""
import filecmp
import os
import sys

SHARED = [
    "services/testing_sessions.py",
    "services/jira_store.py",
    "services/issue_tags.py",
    "services/game_title.py",
    "utils/session_parser.py",
]

console = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bot = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(console), "cmt-boost-main")
bad = 0
for rel in SHARED:
    a, b = os.path.join(console, rel), os.path.join(bot, rel)
    if not (os.path.exists(a) and os.path.exists(b)):
        print("missing  %s" % rel)
        bad += 1
    elif not filecmp.cmp(a, b, shallow=False):
        print("DIFFERS  %s" % rel)
        bad += 1
    else:
        print("same     %s" % rel)
sys.exit(1 if bad else 0)
