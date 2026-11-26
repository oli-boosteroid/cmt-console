"""
ONE collection for Jira tickets: `jira_tickets` (identical file in the bot and the console).

The bot's Slack / Discord state and the console's Jira list / To-Do fields live in one document per
ticket. Two console fields had a bot field of the same name but another meaning, so they are kept
under their own names:

  console value                      stored as        (bot field of the same old name)
  Jira `updated` string (cycle key)   jira_updated     status_since  - datetime of the last transition
  the ticket's real title             title            summary       - the bot's transition log line

`console: True` marks the tickets the console lists (team tickets from Sync + every ticket the bot
mirrors a transition for) - the same set console_jira_tickets held.
The console API keeps its old JSON shape (summary / status_since) through to_console().
"""
COLLECTION = "jira_tickets"
_CONSOLE_FIELDS = ("issue_key", "status", "url", "communication_link", "reporter", "reporter_id",
                   "cm_awaiting_reply", "synced_at")


def from_console(rec):
    """A console-shaped record {issue_key, summary, status_since, ...} -> fields to $set in jira_tickets."""
    out = {k: rec[k] for k in _CONSOLE_FIELDS if k in rec}
    if "summary" in rec:
        out["title"] = rec["summary"]
    if "status_since" in rec:
        out["jira_updated"] = rec["status_since"]
    out["console"] = True
    return out


def to_console(doc):
    """A jira_tickets document -> the console's record shape (what /jira-cache always returned)."""
    out = {k: doc[k] for k in _CONSOLE_FIELDS if k in doc}
    out["summary"] = doc.get("title") or ""
    out["status_since"] = doc.get("jira_updated") or ""
    return out


def cycle(db, issue_key):
    """The console's status cycle key for a ticket (what Forwarded / Dismiss markers match on)."""
    doc = db[COLLECTION].find_one({"issue_key": issue_key}, {"jira_updated": 1}) or {}
    return doc.get("jira_updated") or ""
