# Running the console on the corporate VM

Target: the console (with the public Known Issues page) runs on the same VM as the CMT bot, next to our own
MongoDB container, and adds **no new inbound port**. People reach the console only after signing in with their
company Google account. The console holds **no Jira, Slack, Discord, Telegram or Reddit key**.

Status: the bot already runs on the VM from `~/cmt-boost` (still on the old database). The console is cloned to
`~/cmt-console` but not started. Our own MongoDB is ready in the bot repo (`deploy/mongo/`), not started yet.

## What runs where

| Container | From | Reachable from outside | Mongo user | Secrets it holds |
|---|---|---|---|---|
| `cmt-boost` (bot) | bot repo `docker-compose.yml` | `:7000` for Slack only | `cmt_bot` | all integration keys (in `.env`, mounted read-only, not in the image) |
| `cmt-mongo` | bot repo `deploy/mongo/`, its own compose project | no (Docker network only) | - | admin password, replica-set key |
| `cmt-console` | console repo `docker-compose.vm.yml` | only via the tunnel/proxy; console pages after Google sign-in, Known Issues pages public | `cmt_console` | session key, Google OAuth client, R2, Jira **gateway** token |
| `cmt-cloudflared` (option A) | `--profile tunnel` | outbound connection only | - | tunnel token |

- The console serves the public Known Issues page itself: `/knownissues*`, `/knownissues.js`, `/knownissues-fonts/*`,
  `/api/console/public/*`, `/cmthelper/*` answer without sign-in; every other path needs a console session.
  `public_app.py` (public paths only) is kept so the page can run in its own container with a read-mostly
  Mongo user if the VM gets more memory or a stricter split is required.
- Jira: the console calls the bot's internal gateway `http://cmt-boost:7001/internal/jira` on the shared Docker
  network `cmt-net` (`services/jira_http.py` in the console, `services/jira_gateway.py` in the bot). Port 7001 is
  not published; only Jira API paths the console uses are allowed (no DELETE, no user/admin APIs), every call is
  logged with the console user. Without `JIRA_GATEWAY_URL` the console calls Jira directly (Railway).
- Fonts are served by the console itself (no Google Fonts).
- All containers: read-only filesystem where possible, non-root, no Linux capabilities, memory/CPU limits, log rotation.

## Memory budget (VM: 3.8 GB RAM, 8 CPU)

| Container | Limit |
|---|---|
| bot | ~0.7 GB in use |
| console | 512 MB |
| MongoDB | WiredTiger cache 0.5 GB, container limit 1.2 GB |
| cloudflared (option A) | 128 MB |

About 1 GB stays free for the system. Data today: ~0.17 GB main (Atlas) + ~0.75 GB snapshots (Railway), so the
whole database is under 1 GB and the hot part fits the cache. Heavy data (images) belongs in R2, not in Mongo.

## Order of the first deployment

1. **Answers / setup**: option A or B for access, a DNS name, OAuth client "Internal" in the company Google Cloud.
2. **MongoDB**: `cd ~/cmt-boost/deploy/mongo && ./init.sh` (section below).
3. **Data**: `cmt-boost-main/additional_scripts/migrate_to_vm_mongo.sh rehearse`, then `compare_counts.py`; in the
   maintenance window `... final` (bot and console stopped), `compare_counts.py` again.
4. **Bot**: put `JIRA_GATEWAY_TOKEN` (new random value) and the `cmt_bot` URIs printed by `init.sh` into the bot's
   `.env` (`MONGODB_URI`, `SNAPSHOT_MONGODB_URI`; `MONGODB_DATABASE=reddit_posts`), `~/deploy.sh`.
5. **Console**: fill `deploy/console.env` from `deploy/console.env.example` (`chmod 600 deploy/*.env`), run
   `~/deploy-console.sh` (`CMT_TUNNEL=1` for option A).
6. **Smoke test** (below). Then switch off Railway and, after 14 days, delete Atlas + the Railway Mongo.

## MongoDB

Our own MongoDB container, defined in the bot repo `deploy/mongo/`:

- `mongo:4.4.6` (MongoDB 5+ needs AVX, which this VM lacks), container `cmt-mongo` on the Docker network
  `cmt-net`; port 27017 is not published. The image has the legacy `mongo` shell, not `mongosh`.
- A compose project of its own: `~/deploy.sh` and `~/deploy-console.sh` never stop or recreate the database;
  `restart: unless-stopped` brings it back after a VM reboot. Data lives in the Docker volume `cmt-mongo-data`
  (outside the git checkout). Never run `docker compose down -v` in `deploy/mongo` (it deletes the volume).
- Single-node replica set `rs0` (change streams: console actions run at once), auth on, replica-set key file,
  `--wiredTigerCacheSizeGB 0.5`, memory limit 1.2 GB, log rotation.
- Databases: `reddit_posts` (main) and `reddit_snapshots` (Reddit snapshots + images).

First start (once):

```bash
cd ~/cmt-boost/deploy/mongo && ./init.sh
```

It checks the network, creates the key file and random passwords
(`deploy/mongo/mongo.env`, chmod 600, ignored by git), starts the container, sets up `rs0` and creates the users:

| User | Rights |
|---|---|
| `admin` | root, for maintenance and the data move only |
| `cmt_bot` | readWrite on `reddit_posts` and `reddit_snapshots` |
| `cmt_console` | readWrite on `reddit_posts`, read on `reddit_snapshots` (narrowed later as console writes move to the bot) |
| `cmt_backup` | backup role, used by `dump.sh` |

At the end it prints the connection strings for the bot `.env` and `deploy/console.env`.

Manual dump onto the same VM: `sudo ~/cmt-boost/deploy/mongo/dump.sh` writes a gzip archive to
`/var/backups/cmt-mongo` and keeps the newest 3. Restore: see the header of `dump.sh`.

The bot refuses any queued console action without a signed-in author, except the few system actions listed in
`cmt-boost-main/services/action_policy.py`.

Data move (Atlas + Railway -> `cmt-mongo`): `~/.cmt_migrate.env` (chmod 600) with `SRC_MONGODB_URI`,
`SRC_SNAPSHOT_URI` and `DST_URI=mongodb://admin:<MONGO_ADMIN_PASSWORD>@cmt-mongo:27017/?authSource=admin&replicaSet=rs0`,
then `additional_scripts/migrate_to_vm_mongo.sh rehearse` (copies into `*_rehearsal` databases) and the printed
`compare_counts.py` command; in the maintenance window `... final` with the bot stopped, then the new URIs in the
bot `.env`, `~/deploy.sh`.

## Routing

Option A, Cloudflare Tunnel (company Cloudflare account): one public hostname, service `http://cmt-console:8080`.
Cloudflare Access: one application for the hostname with policy **Allow - emails ending in @<company domain>**,
identity provider **Google Workspace**; a second application with policy **Bypass** for the public paths
`/knownissues*`, `/api/console/public/*`, `/cmthelper/*`. The Facebook extension posts to `/api/fb/*` with its own
key: add that path to the Bypass application or give the extension an Access service token. The console still does
its own Google sign-in and lets in only people who have a console account.

Option B, DevOps reverse proxy: everything to `127.0.0.1:8080` (published on 127.0.0.1 only).

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
4. On the VM: `ss -tlnp` shows 8080 only on 127.0.0.1, nothing on 7001 or 27017 outside Docker;
   `sudo docker ps` shows `cmt-mongo` as healthy.
5. Stop switch: `sudo docker compose -f docker-compose.vm.yml stop` in `~/cmt-console` - the bot keeps working.
