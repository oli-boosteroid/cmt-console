# Running the console on the corporate VM

Target: the console and the public Known Issues page run on the same VM as the CMT bot, use the MongoDB
that already exists there, and add **no new inbound port**. People reach the console only after signing in
with their company Google account. The console holds **no Jira, Slack, Discord, Telegram or Reddit key**.

## What runs where

| Container | From | Reachable from outside | Mongo user | Secrets it holds |
|---|---|---|---|---|
| `cmt-boost` (bot) | bot repo `docker-compose.yml` | `:7000` for Slack only, as today | `cmt_bot` | all integration keys (in `.env`, mounted read-only, not in the image) |
| `cmt-console` | console repo `docker-compose.vm.yml` | only via the tunnel/proxy, after Google sign-in | `cmt_console` | session key, Google OAuth client, R2, Jira **gateway** token |
| `cmt-knownissues` | same image, `public_app.py` | public paths only | `cmt_public` (read published KI + add suggestions) | R2 |
| `cmt-cloudflared` (option A) | `--profile tunnel` | outbound connection only | — | tunnel token |

- `public_app.py` serves only `/knownissues*`, `/knownissues.js`, `/knownissues-fonts/*`, `/api/console/public/*`,
  `/cmthelper/*`; every other path answers 404.
- Jira: the console calls the bot's internal gateway `http://cmt-boost:7001/internal/jira` on the shared Docker
  network `cmt-net` (`services/jira_http.py` in the console, `services/jira_gateway.py` in the bot). Port 7001 is
  not published; only Jira API paths the console uses are allowed (no DELETE, no user/admin APIs), every call is
  logged with the console user. On Railway (no `JIRA_GATEWAY_URL`) the console still calls Jira directly.
- Fonts are served by the console itself (no Google Fonts).
- All containers: read-only filesystem, non-root, no Linux capabilities, memory/CPU limits, log rotation.

## Order of the first deployment

1. **DevOps / IT answers**: the admin login for the `mongodb` container (see "MongoDB" below), option A or B for
   access, a DNS name, OAuth client "Internal" in the company Google Cloud.
2. **Mongo users**: run the `mongosh` block below with an admin account.
3. **Data**: `cmt-boost-main/additional_scripts/migrate_to_vm_mongo.sh rehearse`, then `compare_counts.py`; in the
   maintenance window `... final` (bot and console stopped), `compare_counts.py` again.
4. **Bot**: put `JIRA_GATEWAY_TOKEN` (new random value) and the VM Mongo URIs (`cmt_bot`) into the bot's `.env`,
   `~/deploy.sh`. The bot's compose creates the network `cmt-net`.
5. **Console**: clone the console repo to `~/cmt-console`, fill `deploy/console.env` and `deploy/knownissues.env`
   from the `*.example` files (`chmod 600 deploy/*.env`), copy `deploy/deploy-console.sh` to `~/` and run it
   (`CMT_TUNNEL=1` for option A).
6. **Smoke test** (below). Then switch off Railway and, after 14 days, delete Atlas + the Railway Mongo.

## MongoDB

On our VM Mongo runs in Docker (container `mongodb`, `27017/tcp` not published on the host), so the containers join
its Docker network and use `mongodb` as the host:

```bash
sudo docker inspect mongodb --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'   # network name
sudo docker inspect mongodb --format '{{.Config.Cmd}}'          # --replSet <name> -> replica set (change streams)
```

- Bot: in its `.env` set `COMPOSE_FILE=docker-compose.yml:docker-compose.mongo.yml` and `MONGO_NETWORK=<network>`.
- Console: `MONGO_NETWORK=<network>` in `deploy/console.env`; `deploy-console.sh` then adds `docker-compose.mongo.yml`.
- Migration: in `~/.cmt_migrate.env` `DOCKER_NETWORK=<network>` and `DST_URI=mongodb://<admin>@mongodb:27017/?authSource=admin`.
- `mongosh` for the user setup: `sudo docker exec -it mongodb mongosh -u <admin> --authenticationDatabase admin`.

If Mongo ever moves to the host instead (bound to `127.0.0.1`), the containers need `network_mode: host` or DevOps
lets Mongo listen on the Docker bridge address (`172.17.0.1`).

Databases: `reddit_posts` (main) and `reddit_snapshots` (Reddit snapshots + images). If DevOps gives one database
only, point `MONGODB_DATABASE` and `SNAPSHOT_MONGODB_DATABASE` at the same name (collection names do not clash).

```javascript
// mongosh, as an admin
const main = "reddit_posts", snap = "reddit_snapshots";
db.getSiblingDB("admin").createUser({ user: "cmt_bot", pwd: passwordPrompt(),
  roles: [{ role: "readWrite", db: main }, { role: "readWrite", db: snap }] });

// Console: for now the same rights as today (it still writes its own state and some bot data).
// Narrowed step by step as those writes move to the bot.
db.getSiblingDB("admin").createUser({ user: "cmt_console", pwd: passwordPrompt(),
  roles: [{ role: "readWrite", db: main }, { role: "read", db: snap }] });

// Public Known Issues page: read the published data, add suggestions/feedback, nothing else.
db.getSiblingDB(main).createRole({ role: "cmtPublic", roles: [], privileges: [
  { resource: { db: main, collection: "known_issues" },   actions: ["find"] },
  { resource: { db: main, collection: "game_list" },      actions: ["find"] },
  { resource: { db: main, collection: "known_issue_shots" }, actions: ["find"] },
  { resource: { db: main, collection: "console_config" }, actions: ["find"] },
  { resource: { db: main, collection: "known_issues_suggestions" }, actions: ["find", "insert", "update"] },
  { resource: { db: main, collection: "console_feedback" }, actions: ["insert"] },
  { resource: { db: main, collection: "console_notify_feed" }, actions: ["insert"] },
  { resource: { db: main, collection: "console_actions" }, actions: ["insert"] },
  { resource: { db: main, collection: "public_suggest_rate" }, actions: ["find", "insert", "createIndex"] },
  { resource: { db: main, collection: "public_feedback_rate" }, actions: ["find", "insert", "createIndex"] },
  { resource: { db: main, collection: "public_shot_rate" }, actions: ["find", "insert", "createIndex"] }
]});
db.getSiblingDB("admin").createUser({ user: "cmt_public", pwd: passwordPrompt(),
  roles: [{ role: "cmtPublic", db: main }] });

// Backups (only if DevOps does not back this Mongo up): additional_scripts/backup_mongo.sh in the bot repo
db.getSiblingDB("admin").createUser({ user: "cmt_backup", pwd: passwordPrompt(), roles: [{ role: "backup", db: "admin" }] });
```

The public user's `console_actions` insert is only the admin bell push for a new suggestion; the bot refuses any
other action without a signed-in author (`cmt-boost-main/services/action_policy.py`). Check the log after the first
day for `not authorized` lines in case a collection is missing from the role.

Connection strings: `mongodb://<user>:<password>@<host>:27017/<db>?authSource=admin` (+ `&replicaSet=<name>` if it is
a replica set; without one the bot's action worker falls back to polling every 3 s).

## Routing

Option A, Cloudflare Tunnel (company Cloudflare account) - public hostname rules:

| Path (regex) | Service |
|---|---|
| `^/(knownissues.*|api/console/public/.*|cmthelper/.*)$` | `http://cmt-knownissues:8081` |
| everything else | `http://cmt-console:8080` |

Cloudflare Access: one application for the hostname with policy **Allow - emails ending in @<company domain>**,
identity provider **Google Workspace**; a second application for the public paths above with policy **Bypass**.
The Facebook extension posts to `/api/fb/*` with its own key: add that path to the Bypass application or give the
extension an Access service token. The console still does its own Google sign-in and lets in only people who have
a console account.

Option B, DevOps reverse proxy: the same two path rules to `127.0.0.1:8081` / `127.0.0.1:8080` (both are published
on 127.0.0.1 only).

## Google sign-in

1. Company Google Cloud project: OAuth consent screen **Internal**; Credentials -> OAuth client ID -> **Web
   application**; authorized redirect URI `https://<host>/api/console/sso/google/callback`.
2. `deploy/console.env`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CONSOLE_GOOGLE_DOMAIN`,
   `CONSOLE_PUBLIC_URL=https://<host>`.
3. Everyone signs in with Google once (their console account e-mail must be the company e-mail), then
   `CONSOLE_PASSWORD_LOGIN=0`.

## Smoke test after deploy

1. `https://<host>/console/` -> Google sign-in -> console opens; Admin -> "Ping bot worker" -> OK.
2. Open a Jira ticket in the console (description + comments load) - this goes through the gateway; the bot log shows
   `[JiraGateway] GET /rest/api/2/issue/... -> 200 (console user ...)`.
3. `https://<host>/knownissues` opens without sign-in; `https://<host>/api/console/notes` without sign-in -> 401 or the
   Access login page.
4. On the VM: `ss -tlnp` shows 8080/8081 only on 127.0.0.1 and nothing on 7001 outside Docker.
5. Stop switch: `sudo docker compose -f docker-compose.vm.yml stop` in `~/cmt-console` - the bot keeps working.
