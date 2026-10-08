#!/bin/sh
# Takes a backup of the database and of the uploaded geo files, now, into ./backups.
set -eu
cd "$(dirname "$0")/.."
exec docker compose --profile backup run --rm -T backup once
