#!/bin/sh
# Replaces the database and the uploaded geo files with a backup from ./backups.
#
#   scripts/restore.sh latest                 the newest backup
#   scripts/restore.sh gioco-<ts>.dump        a given one
#   scripts/restore.sh --verify latest        only checks that it restores, changes nothing
#
# The game is stopped while it runs: api and jobs are stopped and started again.
set -eu
cd "$(dirname "$0")/.."
run() { docker compose --profile backup run --rm -T backup "$@"; }

if [ "${1:-}" = "--verify" ]; then
  run verify "${2:?which backup?}"
  exit 0
fi
backup=${1:?which backup? a file name in ./backups or 'latest'}

if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  printf 'This replaces the whole game with the backup "%s". Type "yes" to go on: ' "$backup"
  read -r answer
  [ "$answer" = "yes" ] || { echo "nothing done"; exit 1; }
fi

docker compose stop api jobs
run restore "$backup"
docker compose up -d api jobs
echo "done: api and jobs are running on the restored data"
