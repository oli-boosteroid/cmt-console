"""Shared parser for the client-provided "session info" text.

A single parser used by the Jira Create-Ticket flow, the Create Urgent Request
flow, the Testing Sessions feature (Slack + Telegram) and anywhere else session
text is read, so every entry point accepts the same formats:

Minimal (legacy)::

    ID: 03d7005e-a318-4eb6-9230-3a060fc10bb1
    Application: Crimson Desert

Extended (current client)::

    ID: 4a6a8afd-1fcd-4477-8d22-75a603475463
    Application: Cyberpunk 2077 (Steam) [ID: 682]
    Playground: Ploiesti

    Device: Desktop
    Client: BoosteroidWindowsClient v.1.11.23 (Beta)

Multiple sessions are simply pasted back to back. An optional header (e.g. an
email and a "User ID:" line) may precede the first session.
"""

import re

# Strips the trailing "[ID: 682]" application-id suffix.
_APP_ID_SUFFIX_RE = re.compile(r'\s*\[ID:\s*\d+\]', re.IGNORECASE)
_APP_ID_CAPTURE_RE = re.compile(r'\[ID:\s*(\d+)\]', re.IGNORECASE)


def clean_game_name(application: str) -> str:
    """Returns the application name without the trailing "[ID: n]" suffix."""
    return _APP_ID_SUFFIX_RE.sub('', application or '').strip()


def _new_session() -> dict:
    return {
        "session_id": "",
        "application": "",   # raw, e.g. "Cyberpunk 2077 (Steam) [ID: 682]"
        "game": "",          # application with "[ID: n]" stripped
        "app_id": None,      # the "n" from "[ID: n]", as str, or None
        "playground": "",
        "device": "",
        "client": "",
    }


def parse_session_blocks(text: str) -> tuple[list[str], list[dict]]:
    """Parse one or more session blocks out of ``text``.

    Returns ``(header_lines, sessions)``:

    - ``header_lines`` - non-empty lines appearing before the first ``ID:`` line
      (e.g. an email, ``User ID: 7436618``).
    - ``sessions`` - one dict per ``ID:`` line (see ``_new_session`` for keys).

    A new session starts at a line whose stripped/lowercased text starts with
    ``id:`` exactly - ``user id:`` does NOT start a new session. Blank lines
    inside a block are ignored, so the extended format (blank line before
    ``Device:``/``Client:``) stays a single session.
    """
    header_lines: list[str] = []
    sessions: list[dict] = []
    current: dict | None = None

    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        low = line.lower()

        if low.startswith("id:"):
            current = _new_session()
            current["session_id"] = line[3:].strip()
            sessions.append(current)
            continue

        if current is None:
            # Anything before the first "ID:" line is header (email, User ID, ...)
            header_lines.append(line)
            continue

        if low.startswith("application:"):
            app = line[len("application:"):].strip()
            current["application"] = app
            current["game"] = clean_game_name(app)
            m = _APP_ID_CAPTURE_RE.search(app)
            if m:
                current["app_id"] = m.group(1)
        elif low.startswith("playground:"):
            current["playground"] = line[len("playground:"):].strip()
        elif low.startswith("device:"):
            current["device"] = line[len("device:"):].strip()
        elif low.startswith("client:"):
            current["client"] = line[len("client:"):].strip()
        # Unknown lines inside a block are ignored.

    return header_lines, sessions
