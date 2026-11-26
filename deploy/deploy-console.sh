#!/usr/bin/env bash
#
# CMT Console - one-shot VM deploy (same flow as the bot's additional_scripts/deploy.sh).
#
#   pull latest from GitHub (token from a file, no prompt) -> rebuild -> restart -> show status
#
# FIRST-TIME SETUP on the VM:
#   1) git clone the console repo to ~/cmt-console
#   2) cp deploy/console.env.example deploy/console.env and deploy/knownissues.env.example deploy/knownissues.env,
#      fill them in, chmod 600 deploy/*.env   (option A also: deploy/cloudflared.env)
#   3) the bot must be deployed first: its docker-compose.yml creates the shared network "cmt-net"
#   4) cp deploy/deploy-console.sh ~/deploy-console.sh && chmod +x ~/deploy-console.sh
#   5) ~/deploy-console.sh            (CMT_TUNNEL=1 ~/deploy-console.sh to run Cloudflare Tunnel as well)
#
# Stop everything public in one command:  sudo docker compose -f docker-compose.vm.yml stop
#
set -euo pipefail

REPO_DIR="${CMT_CONSOLE_DIR:-$HOME/cmt-console}"
BRANCH="${CMT_BRANCH:-main}"
TOKEN_FILE="${CMT_TOKEN_FILE:-$HOME/.cmt_deploy_token}"
DOCKER="${CMT_DOCKER:-sudo docker}"
DC="$DOCKER compose -f docker-compose.vm.yml"
[ "${CMT_TUNNEL:-0}" = 1 ] && DC="$DC --profile tunnel"

c()   { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mx %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$REPO_DIR/.git" ] || die "no git repo at $REPO_DIR (set CMT_CONSOLE_DIR)"
[ -f "$TOKEN_FILE" ]    || die "token file $TOKEN_FILE missing"
cd "$REPO_DIR"
for f in deploy/console.env deploy/knownissues.env; do
  [ -f "$f" ] || die "$f missing - copy it from $f.example and fill it in"
done
$DOCKER network inspect cmt-net >/dev/null 2>&1 || die "network cmt-net not found - deploy the bot first"
# Mongo in Docker on its own network: join it (MONGO_NETWORK in deploy/console.env)
MONGO_NETWORK="${MONGO_NETWORK:-$(sed -n 's/^MONGO_NETWORK=//p' deploy/console.env | tr -d ' \r')}"
if [ -n "$MONGO_NETWORK" ]; then
  $DOCKER network inspect "$MONGO_NETWORK" >/dev/null 2>&1 || die "Docker network $MONGO_NETWORK not found"
  export MONGO_NETWORK
  DC="$DC -f docker-compose.mongo.yml"
fi

GIT_TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"; export GIT_TOKEN
c "Pulling $BRANCH"
git -c credential.helper='!f(){ echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f' \
    fetch --prune origin "$BRANCH"
git reset --hard FETCH_HEAD          # untracked deploy/*.env are kept
unset GIT_TOKEN

c "Building & starting"
$DC up -d --build
$DC ps
c "Last log lines"
$DC logs --tail=30
