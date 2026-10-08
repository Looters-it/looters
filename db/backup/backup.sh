#!/bin/sh
# Runs inside the `backup` service of docker compose (same image as the database, so
# pg_dump and pg_restore match the server). Usage:
#
#   backup.sh once            one backup now
#   backup.sh loop            one backup every BACKUP_INTERVAL_HOURS, forever
#   backup.sh verify <name>   restores a backup into a scratch database and drops it
#   backup.sh restore <name>  replaces the database (and the uploads) with a backup
#
# A backup is two files in /backups with the same timestamp: `gioco-<ts>.dump`
# (pg_dump custom format) and `gioco-<ts>.uploads.tgz` (the geo files of the admin).
set -eu

DB=${PGDATABASE:-gioco}
DIR=/backups
UPLOADS=/data/uploads
KEEP=${BACKUP_KEEP:-14}
INTERVAL_HOURS=${BACKUP_INTERVAL_HOURS:-24}

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
sql() { psql -v ON_ERROR_STOP=1 -q -d postgres "$@"; }

backup() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  dump="$DIR/$DB-$stamp.dump"
  # Written under another name and renamed when complete and readable: a file called
  # *.dump is always a whole backup.
  pg_dump -d "$DB" -Fc -f "$dump.partial"
  pg_restore --list "$dump.partial" > /dev/null
  tar -czf "$DIR/$DB-$stamp.uploads.tgz.partial" -C "$UPLOADS" .
  mv "$DIR/$DB-$stamp.uploads.tgz.partial" "$DIR/$DB-$stamp.uploads.tgz"
  mv "$dump.partial" "$dump"
  log "backup written: $(basename "$dump") ($(du -h "$dump" | cut -f1))"

  # Keep the newest $KEEP backups.
  ls -1 "$DIR"/"$DB"-*.dump 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" "${old%.dump}.uploads.tgz"
    log "old backup removed: $(basename "$old")"
  done
}

# Restores a dump into a new database and prints what it holds.
restore_into() {
  dump=$1
  target=$2
  [ -f "$dump" ] || { echo "no such backup: $dump" >&2; exit 1; }
  sql -c "DROP DATABASE IF EXISTS \"$target\"" -c "CREATE DATABASE \"$target\""
  pg_restore -d "$target" --no-owner --exit-on-error "$dump"
  psql -v ON_ERROR_STOP=1 -At -d "$target" -c "
    SELECT 'users: ' || (SELECT count(*) FROM \"User\")
      || ', matches: ' || (SELECT count(*) FROM \"Match\")
      || ', municipalities: ' || (SELECT count(*) FROM \"GeoUnit\")
      || ', events: ' || (SELECT count(*) FROM \"GameEvent\")
      || ', migrations: ' || (SELECT count(*) FROM _prisma_migrations)"
}

resolve() {
  case "$1" in
    latest) ls -1 "$DIR"/"$DB"-*.dump 2>/dev/null | sort | tail -n 1 ;;
    */*) echo "$1" ;;
    *) echo "$DIR/$1" ;;
  esac
}

case "${1:-}" in
  once)
    backup
    ;;
  loop)
    log "a backup every $INTERVAL_HOURS hours, keeping $KEEP"
    while true; do
      backup || log "BACKUP FAILED"
      sleep $((INTERVAL_HOURS * 3600))
    done
    ;;
  verify)
    dump=$(resolve "${2:?which backup? a file name or 'latest'}")
    log "verifying $(basename "$dump")"
    restore_into "$dump" "${DB}_verify"
    sql -c "DROP DATABASE \"${DB}_verify\""
    tar -tzf "${dump%.dump}.uploads.tgz" > /dev/null
    log "the backup restores cleanly"
    ;;
  restore)
    dump=$(resolve "${2:?which backup? a file name or 'latest'}")
    log "restoring $(basename "$dump")"
    # Into a new database first: the one in use is replaced only if the restore succeeds,
    # and it is kept under another name rather than dropped.
    restore_into "$dump" "${DB}_restoring"
    aside="${DB}_before_restore_$(date -u +%Y%m%d_%H%M%S)"
    sql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()" > /dev/null
    sql -c "ALTER DATABASE \"$DB\" RENAME TO \"$aside\"" -c "ALTER DATABASE \"${DB}_restoring\" RENAME TO \"$DB\""
    find "$UPLOADS" -mindepth 1 -delete
    tar -xzf "${dump%.dump}.uploads.tgz" -C "$UPLOADS"
    log "restored. The previous database is kept as \"$aside\": drop it when you are sure."
    ;;
  *)
    sed -n '2,12p' "$0" >&2
    exit 2
    ;;
esac
