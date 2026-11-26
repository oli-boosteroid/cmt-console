# CMT Console

Web console for the CMT team at cmtconsole.xyz. Flask + a dependency-free JS frontend served at
`/console/`, deployed on Railway from this folder (`Dockerfile`, `railway.json`).

The console and the bot (`cmt-boost-main`, runs on the VM in Docker) are one system: they share the
same MongoDB Atlas database and meet only there.

- The console reads and writes its own collections directly and talks to Jira over REST.
- Anything that needs the bot's live connections (Discord, Reddit, Telegram, Slack, the cloud admin
  API) is queued into `console_actions`; the bot's `services/console_actions_worker.py` runs it and
  writes the result back. Identical submits within 15 seconds are dropped (`dedup_key`).
- Slack and the console call the same functions for the same feature (for example SO / URG tickets
  are built only in the bot's `handlers/ticket_create.py`).

## Layout
- `console_app.py` - entry point (waitress, binds `$PORT`), registers the blueprints.
- `api/routes/console.py` - serves `web/` at `/console/` (minified, cached).
- `api/routes/console_api.py` - read API, Jira client (REST), URG.
- `api/routes/console_state.py` - team state: notes, tags, statuses, templates, schedule, leave,
  notifications, action queue.
- `api/routes/console_auth.py` - sign-in, sessions, users and permissions.
- `api/routes/console_live.py` - `/poll` version map and the shared response cache.
- `api/routes/console_public.py` - public pages (`/knownissues`, CMTHelper terms and privacy).
- `api/routes/fb_ingest.py` - Facebook extension intake. (Devvit events reach the bot through the Slack relay.)
- `api/routes/urg_settings.py` - Urgent Request form settings (Verification switch).
- `services/` - Mongo indexes, blob store, small shared helpers.
- `web/` - the frontend (`js/app.js`, `js/api.js`, `css/*`), `web/knownissues.*` public page.
- `fb-extension/` - the Chrome extension the admin downloads from the console.
- `dev/local_harness.py` - local test stand (mongomock, fake Jira, cloud API and Google sign-in, auto sign-in;
  `HARNESS_AUTOLOGIN=0` shows the real login screen). Refuses to start against a real database.
- `CHANGELOG-v3.0.md` - user-facing changes.

## Environment
`MONGODB_URI`, `MONGODB_DATABASE`, `SNAPSHOT_MONGODB_URI`, `CONSOLE_SECRET_KEY`, `JIRA_BASE_URL`,
`JIRA_API_EMAIL`, `JIRA_API_TOKEN`; `PORT` is injected by Railway.

Google sign-in (company Workspace accounts only; see `api/routes/google_sso.py`):
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (OAuth client "Web application", consent screen
"Internal"), `CONSOLE_GOOGLE_DOMAIN` (company domain, comma-separated if several), `CONSOLE_PUBLIC_URL`
(e.g. `https://cmtconsole.xyz`; the redirect URI to register is `<CONSOLE_PUBLIC_URL>/api/console/sso/google/callback`).
Once Google sign-in works for everyone, set `CONSOLE_PASSWORD_LOGIN=0` to turn e-mail + password sign-in off.

Sign-out ends all of a user's sessions (every device); a password change keeps only the current device.
There is no service token: every API call acts as a signed-in person. `EXTERNAL_RELAY_*`, `RELAY_SEND_HOUR`,
`DEVVIT_SECRET` and `CONSOLE_API_TOKEN` are no longer read and can be deleted from the service variables.

## Local test stand
```bash
python dev/local_harness.py . 8765
# open http://localhost:8765/console/  (add ?nc=N after a JS/CSS change to bypass the cache)
```
After changing JS or CSS, bump the cache keys in `web/index.html` (`app.js?v=3.0&b=N`, the css `?v=`).
