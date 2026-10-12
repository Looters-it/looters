# Looters

An online multiplayer conquest game played on real municipalities, Italy first and many other countries with it: each player leads an empire, annexes municipalities, gathers resources and attacks the neighbours, turn by turn.

This is the root repository: it holds `docker-compose.yml`, the shared documentation and the management scripts. The three services are separate repositories, to be cloned **inside** this folder:

```sh
git clone https://github.com/Looters-it/looters.git && cd looters
git clone https://github.com/Looters-it/looters-api.git api
git clone https://github.com/Looters-it/looters-jobs.git jobs
git clone https://github.com/Looters-it/looters-web.git web
```

| Folder | What is in it |
|---|---|
| `api/` | Node.js + TypeScript, Fastify, Prisma. Owns the database schema. |
| `jobs/` | Go. Background work: geographic data, turns, battle resolution. |
| `web/` | React + TypeScript, Vite, Tailwind v4, shadcn/ui. |
| `db/init/` | Script run when the database is first created. |
| `docs/ARCHITECTURE.md` | Technical contract between the services. |
| `docs/SPEC.md` | The rules of the game as they are implemented. |


## Running it

Only Docker is needed.

```sh
cp .env.example .env      # then set ADMIN_PASSWORD (at least 12 characters)
docker compose up --build
```

- Game: <http://localhost:8080>
- API: <http://localhost:3000/api/health/ready>
- PostgreSQL: `localhost:5433` (user, password and database `looters`)
- Kafka: `localhost:29092`

On start `api` applies the migrations and creates the platform admin; `jobs` starts once `api` is ready. The homepage shows the state of the services.

To start again from nothing, deleting database and queues: `docker compose down -v`.

## Development

Start only the supporting services and run the three projects on your machine:

```sh
docker compose up -d db kafka kafka-init
```

| Project | Setup | Run | Checks |
|---|---|---|---|
| `api` | `cp .env.example .env && pnpm install && pnpm db:deploy && pnpm seed` | `pnpm dev` | `pnpm lint && pnpm typecheck && pnpm test` |
| `jobs` | `cp .env.example .env`, with the same `UPLOAD_DIR` as `api` (absolute path) | `set -a; . ./.env; set +a; go run ./cmd/jobs` | `go vet ./... && go test ./...` |
| `web` | `pnpm install` | `pnpm dev` (<http://localhost:5173>) | `pnpm lint && pnpm typecheck && pnpm test` |

The scripts of `api` read the `.env` file by themselves; `jobs` reads environment variables only, which is why they are exported before running it.

### Integration tests

The tests that use the database and Kafka are switched on by `TEST_DATABASE_URL` and `TEST_KAFKA_BROKERS` (see the `.env.example` files); without these variables they are skipped. The `looters_test` database is created by `db/init/`, and is migrated once:

```sh
cd api && DATABASE_URL=postgresql://looters:looters@localhost:5433/looters_test pnpm db:deploy
```

### Test with the whole of Italy

The test of `jobs` on every Italian municipality is switched on by pointing it at a GeoJSON with their boundaries, for example the one of [openpolis/geojson-italy](https://github.com/openpolis/geojson-italy) (`geojson/limits_IT_municipalities.geojson`):

```sh
cd jobs && GEO_ITALY_FILE=/path/to/municipalities.geojson TEST_DATABASE_URL=postgresql://looters:looters@localhost:5433/looters_test go test -run TestRealBoundariesOfItaly ./internal/geoprocess
```

The same file can be uploaded from the admin dashboard (<http://localhost:8080/admin>, tab "Dati geografici") after creating the area "Italia".

### Changing the schema

The schema is changed only in `api/prisma/schema.prisma`, then `pnpm db:migrate`. Constraints Prisma cannot express (CHECK, partial indexes) are added by hand to the SQL file of the migration. `jobs` never changes the schema.

When `api` adds a key to the configuration of a match, the field is added to `jobs/internal/rules/config.go`.

`jobs` keeps two copies of things that belong to `api`: the database schema its tests run on (`jobs/testdata/schema.sql`, the sum of the migrations) and the default configuration of a match (`jobs/internal/rules/testdata/default-config.json`). After a new migration or a change to the rules they are generated again together, and `--check` verifies that they are up to date:

```sh
./scripts/sync-jobs-fixtures.sh          # generates them again
./scripts/sync-jobs-fixtures.sh --check  # fails if a copy was left behind
```

## Production

Putting the game on a server and updating it: [`docs/RILASCIO.md`](docs/RILASCIO.md). In short, `cp .env.prod.example .env`, fill it in, and `./scripts/deploy.sh`.

## Load test

`cd api && pnpm load` simulates 100 players on the whole of Italy against the running stack, and fails if the game slows down beyond the thresholds or if a turn closes late. How it works, its variables and its results are in [`docs/LOAD.md`](docs/LOAD.md).

## Backup and restore

A backup is a pair of files in `./backups` with the same time (UTC): `looters-<date>-<time>.dump` (the database, in `pg_dump -Fc` format) and `looters-<date>-<time>.uploads.tgz` (the geographic files uploaded by the admin). Together they are enough to rebuild everything: Kafka is not saved, because a battle whose request is lost is resolved anyway when the turn closes.

| What | Command |
| --- | --- |
| A backup now | `./scripts/backup.sh` |
| Periodic backups | `docker compose --profile backup up -d backup` (every `BACKUP_INTERVAL_HOURS`, 24 unless set; the last `BACKUP_KEEP`, 14, are kept) |
| Checking that a backup restores, without touching anything | `./scripts/restore.sh --verify latest` |
| Restoring | `./scripts/restore.sh latest` or `./scripts/restore.sh looters-<date>-<time>.dump` |

**What a restore does.** It asks for confirmation, stops `api` and `jobs`, rebuilds the backup in a new database and only if that succeeds puts it in place of the one in use; then it puts the uploaded files back and restarts the services. The previous database is **not deleted**: it stays as `looters_before_restore_<date>`, and is removed by hand once you are sure:

```sh
docker compose exec db psql -U looters -d postgres -c 'DROP DATABASE "looters_before_restore_<date>"'
```

**After a restore** the game starts again from the state of the backup: the moves made after it are lost, the sessions of the players stay valid, and the turns that expired in the meantime are closed by `jobs` as soon as it starts.

**To remember.** `./backups` is on the same machine as the database: copy it elsewhere (another server, an object store) with the tool you prefer, or it does not protect against losing the disk. Run `--verify` now and then: a backup never tried is not a backup. On a new machine: `docker compose up -d db`, copy the two files into `./backups`, then `./scripts/restore.sh <file>`.

### End-to-end tests on a phone

`e2e/` tries the running stack with a real browser at the size of a phone (two screens: 412×915 and 360×640): homepage, sign-in, every page of the match panel, searching and annexing a municipality, touching the map, the board, English. Every screen is checked so that nothing spills sideways and the controls are large enough for a finger; the images stay in `e2e/test-results/`.

```sh
docker compose up -d
cd e2e && pnpm install && pnpm exec playwright install chromium   # the first time
pnpm test
```

The tests load the province of Milan by themselves (if it is missing), create two users and a test match, and delete them at the end. **Every change to the interface comes with its test here.**

### Continuous integration

Every repository has its own `.github/workflows/ci.yml` (GitHub Actions), which runs on every push to `main` and on every pull request:

| Repository | What it checks |
| --- | --- |
| `api` | formatting, lint, types, tests (with real PostGIS and Kafka, migrated from nothing), build |
| `jobs` | `gofmt`, `go vet`, tests (with real PostGIS and Kafka, schema from `testdata/schema.sql`), build |
| `web` | formatting, lint, types, tests, build |

This repository also has `.github/workflows/e2e.yml`, which builds the stack from the four repositories and runs the end-to-end tests on a phone.

In CI the integration tests are not skipped: `TEST_DATABASE_URL` and `TEST_KAFKA_BROKERS` are always set. The `--check` of the copies kept by `jobs` cannot run in CI, because the repositories are separate: run it by hand before a commit that touches migrations or rules.
