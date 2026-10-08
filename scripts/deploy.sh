#!/bin/sh
# Releases what is checked out in this directory and in api/, jobs/, web/ to the
# production stack on this machine: backup, build, restart, check.
#
#   scripts/deploy.sh             backup first, then release
#   scripts/deploy.sh --no-backup first installation, when there is nothing to save
set -eu
cd "$(dirname "$0")/.."
compose() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

[ -f .env ] || { echo "no .env: copy .env.prod.example to .env and fill it in" >&2; exit 1; }
for repo in api jobs web; do
  [ -d "$repo" ] || { echo "missing ./$repo: clone the three repositories here" >&2; exit 1; }
done
compose config -q

if [ "${1:-}" != "--no-backup" ]; then
  echo "== backup"
  compose run --rm -T backup once
fi

echo "== build"
compose build

echo "== start"
compose up -d --remove-orphans

echo "== check"
tries=0
until compose exec -T api wget -qO- http://127.0.0.1:3000/api/health/ready > /dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "the api is not ready after two minutes; its last lines:" >&2
    compose logs --tail 40 api >&2
    exit 1
  fi
  sleep 2
done
compose exec -T api wget -qO- http://127.0.0.1:3000/api/health/ready
echo
compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "released: api $(git -C api rev-parse --short HEAD), jobs $(git -C jobs rev-parse --short HEAD), web $(git -C web rev-parse --short HEAD)"
