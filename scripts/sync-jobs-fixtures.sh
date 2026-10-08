#!/bin/sh
# Regenerates what `jobs` copies from `api`: the database schema its tests run on and
# the default rules of a match. Run it after a new api migration or a change to the
# rules; with --check it changes nothing and fails if a copy is out of date.
set -eu
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

{
  echo "-- The database schema, as the api migrations build it: a copy for the tests of this"
  echo "-- repository, which has no migrations of its own. Regenerate it after every new api"
  echo "-- migration (see the README of the root repository); never edit it by hand."
  for file in api/prisma/migrations/*/migration.sql; do
    echo
    echo "-- $(basename "$(dirname "$file")")"
    cat "$file"
  done
} > "$tmp/schema.sql"

(cd api && pnpm exec tsx -e 'import {DEFAULT_MATCH_RULES} from "./src/rules/config.ts"; console.log(JSON.stringify(DEFAULT_MATCH_RULES,null,2))') > "$tmp/default-config.json"

status=0
sync() {
  if cmp -s "$1" "$2"; then return; fi
  if [ "${MODE:-}" = "--check" ]; then
    echo "out of date: $2" >&2
    status=1
  else
    cp "$1" "$2"
    echo "updated: $2"
  fi
}
MODE=${1:-}
sync "$tmp/schema.sql" jobs/testdata/schema.sql
sync "$tmp/default-config.json" jobs/internal/rules/testdata/default-config.json
exit $status
