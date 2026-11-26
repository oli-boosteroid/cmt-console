#!/usr/bin/env bash
# Deploy the console on the VM: pull from GitHub, rebuild, restart, show the log.
# First time: clone to ~/cmt-console, fill deploy/console.env from the example (chmod 600),
# cp deploy/deploy-console.sh ~/ and run ~/deploy-console.sh (CMT_TUNNEL=1 for Cloudflare Tunnel).
# Stop: sudo docker compose -f docker-compose.vm.yml stop
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
[ -f deploy/console.env ] || die "deploy/console.env missing - copy it from deploy/console.env.example and fill it in"
$DOCKER network inspect cmt-net >/dev/null 2>&1 || die "network cmt-net not found - deploy the bot first"
$DOCKER inspect cmt-mongo >/dev/null 2>&1 || die "container cmt-mongo not found - start the database first (bot repo deploy/mongo/init.sh)"

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
