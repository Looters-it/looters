# Architecture contract

This file is the contract between the three services. Game rules live in `../../PROMPT.md` (§2, §9); the validated UI in `../../PROMPT.md` §11 and `../../prototipo/`. If code and this file disagree, fix one of them in the same change.

## Services

| Service | Stack | Port | Owns |
|---|---|---|---|
| `db` | PostgreSQL 16 + PostGIS 3.5 with GEOS 3.13 (`imresamu/postgis:16-3.5-alpine`: the multi-architecture build, the official image is amd64 only and ships an older GEOS without `ST_CoverageSimplify`) | 5432 (5433 on the host) | data |
| `kafka` | Apache Kafka 4.1, single node, KRaft (`apache/kafka:4.1.0`) | 9092 (29092 on the host) | battle resolution queue |
| `api` | Node 22, TypeScript, Fastify 5, Prisma 6, zod, argon2id (`@node-rs/argon2`), kafkajs, vitest | 3000 | schema and migrations, auth, REST, WebSocket, validation of every game action |
| `jobs` | Go 1.26, `pgx/v5`, `franz-go` | none | geo processing, match start, turn close, **battle resolution** |
| `web` | Vite 8, React 19, TypeScript, Tailwind v4, shadcn/ui (Radix), react-router, i18next; MapLibre GL JS from M4 | 5173 (dev), 8080 (container, nginx) | UI |

- Each of `api`, `jobs`, `web` is its own git repository; this root folder (compose, `docs/`, `db/`) is a fourth one that ignores them.
- `api` is the only service that runs migrations (`prisma migrate deploy` on start, then the admin seed). `jobs` reads and writes the same database and never changes the schema; it waits for the `Job` table before starting.
- In containers `web` (nginx) proxies `/api` and `/ws` to `api:3000`, so the browser uses one origin. In dev, Vite proxies the same paths.
- Uploaded geo files are stored on a volume shared by `api` and `jobs`, mounted at `/data/uploads` (`UPLOAD_DIR`).
- Prisma stores `DateTime` as `timestamp without time zone` in UTC. `jobs` therefore compares and writes times as `now() AT TIME ZONE 'UTC'` and passes Go times as `.UTC()`.

## Environment variables

Each service ships a `.env.example` that documents its own variables.

- `api`: `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_BATTLE_TOPIC` (default `battle.resolve`), `PORT`, `HOST`, `LOG_LEVEL`, `UPLOAD_DIR`, `UPLOAD_MAX_MB` (300; the web proxy has the same limit in `nginx.conf.template`), `TILE_CACHE_MB` (128), `SESSION_COOKIE_NAME` (default `sid`), `SESSION_TTL_HOURS` (720), `COOKIE_SECURE` (false; true in production), `TRUST_PROXY` (false; true behind the web proxy), `LOGIN_RATE_MAX` (10), `LOGIN_RATE_WINDOW_SEC` (300), `REGISTER_RATE_MAX` (10), `REGISTER_RATE_WINDOW_SEC` (3600); seed only: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (at least 12 characters), `ADMIN_EMAIL`; tests: `TEST_DATABASE_URL`, `TEST_KAFKA_BROKERS`.
- `jobs`: `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_BATTLE_TOPIC`, `KAFKA_GROUP_ID` (default `looters-jobs`), `UPLOAD_DIR`, `JOBS_POLL_MS` (1000), `JOBS_WORKERS` (4), `JOBS_MAX_ATTEMPTS` (5), `JOBS_STALE_AFTER_SEC` (300), `GEO_SIMPLIFY_TOLERANCE_M` (50), `GEO_ADJACENCY_GAP_M` (5), `GEO_ADJACENCY_MIN_BORDER_M` (50); tests: `GEO_ITALY_FILE` (path of a GeoJSON with every Italian municipality, enables the whole-country test), `TEST_DATABASE_URL`, `TEST_KAFKA_BROKERS`.
- `web`: `API_PROXY_TARGET` (dev server only), `VITE_BASE_TILES_URL` (build time: background map tiles, default the public OpenStreetMap server).
- root `.env` (read by compose): `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`, optional `KAFKA_BATTLE_TOPIC`, `KAFKA_BATTLE_PARTITIONS` (6).

## Queues and notifications

There are two channels from `api` to `jobs`, and one back.

### Job table (scheduled and one-off work)

- Table `Job` (see schema). `api` inserts rows (`src/queue/jobs.ts`), inside the same transaction as the change that needs the job when there is one. `jobs` claims them with `UPDATE ... WHERE id = (SELECT ... WHERE status='PENDING' AND "runAt" <= now ORDER BY "runAt" FOR UPDATE SKIP LOCKED LIMIT 1)`, sets `RUNNING`, then `DONE` or, after `JOBS_MAX_ATTEMPTS`, `FAILED` with `lastError`. Failed attempts are retried with backoff (5s, 10s, 20s… up to 5 min) by pushing `runAt` forward. While a handler runs, the worker renews `lockedAt`; a job `RUNNING` whose claim is older than `JOBS_STALE_AFTER_SEC` belonged to a worker that died and is put back in the queue.
- `Job.dedupeKey` is unique: enqueueing the same key twice keeps one job (for example `turn.close:<matchId>:<turn>`).
- Job types and payloads:
  - `system.ping` `{ "sentAt": string }` sent by `api` at startup; `jobs` answers with the `system.pong` notification
  - `geo.process` `{ "uploadId": string }` enqueued in the transaction that records the upload
  - `match.start` `{ "matchId": string }` scheduled at `Match.startAt` when registrations open, and again (dedupe key `match.start:<id>:<startAt>`) whenever the owner moves the date; a job that finds the date moved later does nothing
  - `turn.close` `{ "matchId": string, "turn": number }` scheduled at `Match.turnEndsAt` with dedupe key `turn.close:<matchId>:<turn>`: by `match.start` for turn 1, then by each closing for the next turn, always inside the transaction that opens that turn
- Every job must be idempotent: `turn.close` for a turn that is not the match's `currentTurn` is a no-op; all its effects happen in one transaction that also advances `currentTurn`.

### Kafka (battle resolution)

- Battles are resolved **only in `jobs`**, so the formula exists in one language. `api` validates and records the declaration and the defender's response in the database, then asks for the resolution on Kafka.
- Topic `battle.resolve` (`KAFKA_BATTLE_TOPIC`), created by the `kafka-init` service of compose with `KAFKA_BATTLE_PARTITIONS` partitions (default 6); topic auto-creation is disabled.
- Message: key = `matchId`, value = `{ "battleId": string, "matchId": string }`. Ids only: `jobs` reads the battle and `Battle.response` from the database.
- The key keeps the battles of one match in order on one partition; `jobs` processes partitions in parallel, so the number of partitions is the number of battles resolved at the same time.
- Delivery is at-least-once (idempotent producer with `acks=all`; offsets committed after processing). Resolution must be idempotent: it locks the battle row and does nothing unless `status = 'OPEN'`.
- A message that fails 5 times is skipped and logged. Nothing is lost: `turn.close` resolves every battle still open, honouring a recorded `response` and treating a missing one as `DEFEND`. The same safety net covers a message that never reached Kafka after the database commit.
- The message is published by `api` when the defender answers. `jobs` resolves the battle if it has an answer and is still open; anything else (already resolved, not answered, match not running) is skipped.

### Notifications back to the api

- After committing, `jobs` runs `SELECT pg_notify('game_events', json)` with `{ "matchId": string|null, "kind": string }` (`kind`: `system.pong`, `geo.progress`, `match.started`, `turn.closed`, `battle.resolved`, `match.finished`). `api` LISTENs on `game_events` (`src/queue/notifications.ts`) and fans out over WebSocket.
- Notifications sent while the api is disconnected are lost: they are hints to re-read state, never the state itself.

## Health

- `GET /api/health` → `{status:"ok"}`: the process is up (used by the compose healthcheck).
- `GET /api/health/ready` → `{status, database, jobs:{lastPongAt}, battleQueue}`; 503 when the database does not answer. `jobs.lastPongAt` is the time of the last reply to a ping, `battleQueue` whether the Kafka producer is connected.

## Geographic data

- **Folders**: `GeoArea` is a tree. A root is a geographic area (Italy, France…), its descendants are the folders that split it. Names are unique among siblings, ignoring case. Deleting a folder deletes everything inside it (folders, uploads, files on disk, municipalities, their adjacencies) and is refused with `409 AREA_IN_USE` when a match uses any of it.
- **Upload** (`api`): multipart, one file, at most `UPLOAD_MAX_MB`. Accepted extensions `.kml`, `.json`, `.geojson`; the first bytes must look like XML or like a JSON object. The file is streamed to `UPLOAD_DIR/<uploadId>.<kml|geojson>`; `GeoUpload.storagePath` holds that file name only, so `api` and `jobs` each resolve it against their own `UPLOAD_DIR`.
- **Processing** (`jobs`, `geo.process`), all in one transaction, so a refused file leaves nothing behind:
  1. Parse in Go (`internal/geo`), streaming, into one internal form: name, optional official code, GeoJSON MultiPolygon in WGS84. GeoJSON must be a `FeatureCollection` of `Polygon`/`MultiPolygon` features; KML contributes its `Placemark`s with `Polygon` or `MultiGeometry`. Name and code are read from the first matching property, ignoring case (`name, nome, comune, denominazione, com_name`; `com_istat_code, pro_com_t, pro_com, cod_istat, istat, code`); in KML the name is `<name>`. One invalid feature refuses the whole file.
  2. Refuse the file when a municipality with the same code already exists in the same geographic area (root folder).
  3. Insert each `GeoUnit`: `geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(...), 3))`, centroid from `ST_PointOnSurface`, `areaKm2` from the geography area.
  4. `geomSimple` with `ST_CoverageSimplify` over the whole upload: municipalities form a coverage, so a shared border is simplified once and stays shared (no gaps or overlaps on the map). Falls back to `ST_SimplifyPreserveTopology` per polygon if the data is not a clean coverage.
  5. Adjacency between the new municipalities and with every municipality already in the same geographic area, so regions uploaded one by one join up. Two municipalities are adjacent when their borders run within `GEO_ADJACENCY_GAP_M` of each other for at least `GEO_ADJACENCY_MIN_BORDER_M`: a corner contact is not adjacency. Stored once and never recomputed during a match.
- **Result**: `GeoUpload.status` `PENDING → PROCESSING → DONE | FAILED`, `progress` 0–100 (updated outside the transaction so the admin sees it), `unitCount`, `adjacencyCount`. On `FAILED`, `error` is a JSON string `{code, detail?, problems?: [{feature, name?, code}], total?, names?}` that the web interface translates. Codes: `INVALID_FILE`, `NOT_FEATURE_COLLECTION`, `FILE_MISSING`, `NO_UNITS`, `FEATURE_PROBLEMS` (per feature: `MISSING_NAME`, `NO_POLYGON`, `BAD_COORDINATES`, `RING_TOO_SHORT`, `DUPLICATE_CODE`), `ALREADY_LOADED`, `EMPTY_GEOMETRY`, `INTERNAL`. A failed upload is not retried: the admin uploads a corrected file.
- **Manual adjacency**: the admin adds pairs the geometry cannot find (islands, exclaves) with `manual = true`; only manual pairs can be removed.
- **Other countries** (`api/scripts`): `pnpm areas:fetch [country …]` (the countries are the keys of `COUNTRIES` in `fetch-countries.ts`) downloads the municipalities from their open sources and writes, in `api/geodata/` (not versioned), `<country>.geojson` as the upload takes it (`name`, `code`; a name that comes more than once says where it is) and `<country>.regions.json` (`{region: [code, …]}`). The country is uploaded whole into its area, then `pnpm areas:split "<area>" geodata/<country>.regions.json` moves the municipalities into one folder for each region (Italy keeps `pnpm regions`, by ISTAT code). Sources: Switzerland, swisstopo swissBOUNDARIES3D via Opendatasoft (2,115 municipalities; lakes left out); France, IGN ADMIN EXPRESS via Etalab at 100 m (34,851 communes of the mainland and Corsica, 13 regions; overseas left out); United Kingdom, ONS wards and electoral divisions via Opendatasoft (8,396, in the 9 English regions, Scotland, Wales and Northern Ireland).; Denmark, the 99 municipalities of DAGI in a copy of 2015 (unchanged since 2007), 5 regions; Norway, Kartverket's 357 municipalities of 2024, cut along the coast, 13 areas (the 15 counties, with Oslo joined to Akershus and Vestfold to Telemark), plus Svalbard and Jan Mayen as a fourteenth: ten territories, the larger islands as Natural Earth draws them, each with the small ones around it.; Faroe Islands (29 municipalities), Iceland (61) and Greenland (5), as drawn in OpenStreetMap (ODbL), asked to Overpass, whose public servers are often busy and are tried in turn. Greenland's municipalities are drawn there with straight lines out at sea: they are cut along the coast of Natural Earth (`polygon-clipping`), and the land none of them has, the national park of the north-east, is added as a sixth territory.; Sweden (290, 21 counties), Germany (10,949 with the land that has no municipality, 13 areas: the city states go with the state around them), Belgium (565, its 3 regions), the Netherlands (352 of 2021, 12 provinces), Spain (8,212, 18 areas: Ceuta and Melilla together) and Portugal (308 municipalities, 18 districts and the two archipelagos) from Opendatasoft; Finland (308, 19 regions) from Statistics Finland; Luxembourg (102 communes of 2018, 12 cantons) and the microstates, which stay whole (Andorra 7, Liechtenstein 11, San Marino 9, Monaco 9 quarters, the Vatican 1), from geoBoundaries, as are Austria (2,097 municipalities of 2017, 8 areas: Vienna goes with Lower Austria), Poland (2,478 gminy of 2017, 16 voivodeships) and Ireland (166 local electoral areas, 4 provinces); the heavier of these are rounded to four decimals. Every country is split into regions; where the source does not name the region of a municipality (Finland, Luxembourg, Iceland, the Faroe Islands) it is the region whose shape holds most of the municipality's border. Each asks to be credited. Land that only a bridge or the sea joins (the Danish islands, the Norwegian ones) has no adjacency until the admin adds it by hand.
- Measured on the openpolis dataset: 7,896 Italian municipalities, 36 MB, processed in about 20 seconds; 22,811 adjacencies; the only municipalities without neighbours are Campione d'Italia and thirteen island municipalities.

## Map

- **Tiles** (`api`, `src/modules/geo/public-routes.ts`): Mapbox Vector Tiles generated by PostGIS (`ST_AsMVT`), zoom 4–12 (the client overzooms beyond). Layer `units`: polygons, feature id = `GeoUnit.id`, property `name`. Layer `labels` (from zoom 9): one point inside each municipality, with `name` and `area`. Below zoom 9 borders are simplified to one screen pixel; from zoom 11 the full geometry replaces `geomSimple`.
- **Nothing in a tile depends on a match.** Owner colours, selection and highlights are MapLibre *feature state* set by the client per municipality id, so a change of ownership touches one feature and reloads no geometry.
- **Caching**: `GET /geo/areas/:id/map` returns the tile address with a data version (`?v=`) that changes when the municipalities under the folder change. A tile requested with the current version is `immutable` for a year; the api also keeps generated tiles in an LRU cache (`TILE_CACHE_MB`), and one cached under the requested version is served without a database query. The web proxy gzips tiles and JSON.
- Measured with all 7,896 Italian municipalities: the heaviest tile (zoom 4, the whole country) takes 0.4 s to generate and weighs 143 kB compressed; zoom 6 0.14 s and 66 kB; any cached tile about 5 ms.
- **Client** (`web`, `src/features/map`): MapLibre GL JS, loaded lazily because it is most of the bundle. `GameMap` takes the area, a map of municipality id → colour, empire labels, the selection and highlighted ids; it diffs each against what is applied (`feature-state.ts`). Background: raster OpenStreetMap tiles, muted (`VITE_BASE_TILES_URL` to change provider: the public OSM server is for development only). Labels are drawn from the theme's own font files in `web/public/fonts` (style property `font-faces`), with no glyph server. Empire names show below zoom 9, municipality names from zoom 9.
- The selected municipality gets a box anchored to it; on a phone (under 768 px) a sheet rises from the bottom instead. An embedded map (homepage, admin preview) uses cooperative gestures: one finger scrolls the page, two move the map.
- Not done yet, arriving with matches: the thicker outer border of each empire, emblems in the labels, state icons (capital, protected, under attack…).

## Authentication and sessions

- Registration takes `username`, `email`, `password`; the body is strict, so a `role` (or any other extra field) is rejected and no route can create an admin. Usernames: 3–20 characters among letters, digits and underscore, **unique regardless of case** (unique index on `lower(username)`); the spelling chosen at registration is kept for display. Emails are not unique. Passwords: 8–200 characters, hashed with argon2id.
- Login is by username (any case) and password only; an email is never an identifier. A wrong password and an unknown username give the same `401 INVALID_CREDENTIALS`, and both verify a hash so they take the same time.
- A login creates a `Session` row. The client receives a random 256-bit token in an httpOnly, `SameSite=Lax` cookie (`Secure` when `COOKIE_SECURE=true`); the database stores only its SHA-256, so database access does not allow reusing sessions. A session is valid while `revokedAt` is null and `expiresAt` is in the future; `lastSeenAt` is refreshed at most once a minute.
- Logout revokes the caller's session. An admin revokes any session with `DELETE /api/admin/sessions/:id`. Either way the session stops being accepted at once and its sockets are closed (below).
- Rate limiting (`src/auth/rate-limit.ts`, fixed windows in memory): failed logins count against the client address and against the username, so a username under attack is protected from any address; a successful login clears both. Registrations count against the client address. Over the limit: `429 RATE_LIMITED` with `Retry-After`. The counters live in the api process: with more than one api instance they must move to a shared store.
- The client address comes from `X-Forwarded-For` only when `TRUST_PROXY=true`. The web proxy overwrites that header with the real peer address, and compose publishes the api port on `127.0.0.1` only, so it cannot be forged from outside.
- Guards (`src/auth/guard.ts`): `optional`, `user` (401), `admin` (401, then 403 unless `role = ADMIN`).

## Data model

Authoritative definition: `api/prisma/schema.prisma`. Key ideas:

- `GeoUnit` is a real municipality with geometry. `Territory` is a game territory inside one match and groups one or more `GeoUnit` through `TerritoryUnit`; a merged area is a `Territory` with several units. Ownership, resources, battles and structures all refer to `Territory`.
- **Match adjacency is derived, not copied**: two territories of a match are adjacent when any of their units are adjacent, i.e. `TerritoryUnit → GeoAdjacency → TerritoryUnit`. A merged area inherits the union of its units' borders with no extra work. `GeoAdjacency` is undirected: one row per pair with `aId < bId` (CHECK), flag `manual` for the admin's additions.
- `Territory.resources` is the real amount and is never sent to a viewer who is neither the owner nor an ally. Free territories hold their hidden starting resources in the same column. `CHECK (resources >= 0)` guarantees balances never go negative.
- `BattleLock` has one row per territory involved in an open battle (the target and every source), deleted at resolution. Its primary key (`territoryId`) is the database-level guarantee that a territory is in at most one open battle, in either role.
- `Battle.response` (`DEFEND` / `SURRENDER`) is written by `api` when the defender answers; `outcome`, forces, rolls and `resolver` (name of the formula used) are written by `jobs`.
- `Structure.type` is a string key of the structure catalogue in code and `Structure.data` holds type-specific state: adding a structure needs no migration. The second capital is a `Structure` row (its own last-move turn in `data`).
- `Empire.allocationMode` (`EQUAL` / `WEIGHTED`) with `Territory.weight` is the permanent split rule applied to each turn's income.
- Alliances: `Alliance`, `AllianceMember` (primary key `empireId`: one alliance per empire; `leavesAtTurn` for the notice period), `AllianceInvite`, `AllianceMessage`.
- `GameEvent` is the append-only log: it feeds the board, the per-turn history and the map replay. `TurnSnapshot` stores ownership at each turn close.
- `Match.status`: `DRAFT → OPEN → RUNNING → FINISHED`.
- Geometry columns are `Unsupported("geometry")` in Prisma and are read and written with raw SQL; `GeoUnit.geom` has a GiST index.

## Rules configuration

`Match.config` is a JSON object holding **every** key below: `api` completes the owner's choices with the defaults when the match is created (`api/src/rules/config.ts`, the only place where defaults live), so changing a default never alters an existing match. `jobs` reads the stored object (`jobs/internal/rules/config.go`) and rejects keys it does not know.

```json
{
  "minPlayersToStart": 2, "lateJoin": true,
  "startResources": 200,
  "hiddenMin": 10, "hiddenMax": 100, "hiddenMean": 55, "hiddenSd": 17,
  "incomeBase": 50, "incomePerUnit": 10,
  "annexCost": 50, "annexPerTurn": 1,
  "attackPct": 50, "attackStepPct": 10, "attackMaxPct": 100,
  "defensePct": 50, "surrenderRefundPct": 50, "battleSpoilsPct": 70,
  "capitalMoveEveryTurns": 3,
  "accumAlertPct": 50, "accumAlertMinTerritories": 3,
  "mergeCostTurns": 0.5, "mergeMaxUnits": 5,
  "secondCapitalCostTurns": 20,
  "blockCost": 150, "blockTurns": 5, "blockCooldownTurns": 5,
  "allianceMaxMembers": 3, "allianceLeaveNoticeTurns": 1,
  "boardMaxChars": 500, "boardMessageIntervalSec": 20
}
```

"Value of one turn" = `incomeBase + incomePerUnit * (number of GeoUnits the empire controls)`.

## Matches

- **Life cycle**: `DRAFT → OPEN → RUNNING → FINISHED`. A draft exists only for its owner (404 for everyone else) and is fully editable. `POST /matches/:id/open` turns it `OPEN`: from then on map, turn length and rules are locked; name, start, maximum days, maximum players and invite code can still change.
- **Territories** are created when registrations open, in the same transaction: one `Territory` per municipality of the chosen folders (each municipality once, even if folders overlap), each with its hidden starting resources. With 7,896 municipalities it takes under a second.
- **Hidden starting resources** (`src/rules/hidden-resources.ts`): a normal(`hiddenMean`, `hiddenSd`) drawn with the system's secure generator, rejected and redrawn outside [`hiddenMin`, `hiddenMax`], rounded. They sit in `Territory.resources` and are never sent to a client while the territory is free: `GET /matches/:id/state` lists owned territories only.
- **Start** (`jobs`, `match.start`): if the match is `OPEN`, its `startAt` has come and it has at least `minPlayersToStart` active empires, one transaction sets `RUNNING`, `currentTurn = 1`, `turnEndsAt = startAt + turnHours` (counted from the scheduled start, not from when the job ran), protects every capital through turn 1, records `MATCH_STARTED` and notifies `match.started`. Otherwise it does nothing: a match with too few players stays `OPEN` until the owner sets a new date. The closing of turn 1 is queued in the same transaction.
- **Join** (`POST /matches/:id/join`): allowed while `OPEN`, and while `RUNNING` if `lateJoin`. The match row is locked `FOR UPDATE`, so joins of one match run one at a time: invite code, one empire per user, free seats, name (ignoring case) and colour unique in the match. The territory is taken with a conditional update (`ownerEmpireId IS NULL`): of two players choosing the same municipality the second gets `409 TERRITORY_TAKEN` and nothing of theirs is saved. The territory becomes the capital, gains `startResources` on top of its hidden resources, and is protected until the end of the current turn (turn 1 before the start).
- **Empire identity**: name 3–40 characters, colour from `EMPIRE_COLORS` (120 generated colours, also the upper limit of players per match), emblem from `EMPIRE_EMBLEMS` (ten drawings), motto up to 80 characters. Changeable only while the match is `OPEN`.
- **Viewer filter** (`MatchService.state`): `resources` is the number only on the viewer's own territories and `null` on everyone else's; free territories are absent. Events carry names and ids, never amounts.
- **Map of a match**: `GET /matches/:id/map`, `/units` and `/tiles/...` mirror the folder routes, restricted to the match's municipalities; the set never changes after opening, so tiles are immutable.

## Turns and immediate actions

- **Locking**: every action of a player (`src/modules/game/service.ts`) runs in a transaction that takes the match row `FOR SHARE` and the player's empire row `FOR UPDATE`. The turn close takes the match row `FOR UPDATE`. So actions of different players run in parallel, two actions of one player never overlap, and no action straddles a turn: the close waits for the actions in flight, and actions wait for the close.
- **Turn of the action**: the body of every action carries `turn`, the turn the player was looking at. If it is not the current one the action is refused with `409 TURN_CHANGED`.
- **Annex** (`POST /matches/:id/annex {geoUnitId, payFromTerritoryId, turn}`): the target must be free; the payer must be an own territory adjacent to it and not in a battle; the empire must have annexations left this turn. Payment (`resources >= cost`) and taking (`ownerEmpireId IS NULL`) are conditional updates: if either finds the row changed the transaction rolls back, so a territory is never overdrawn, a municipality never gets two owners, and whoever loses the race pays nothing and keeps the annexation of the turn. The target keeps the resources already on it.
- **Allocate** (`POST /matches/:id/allocate {amounts, turn}`): new amounts for some own territories, none in a battle, with the same total as before. Rows are locked in id order.
- **Allocation rule** (`PUT /matches/:id/allocation-rule {mode, weights?}`): `EQUAL` or `WEIGHTED`, with a weight per territory.
- **ELO and the global ranking**: when a match ends (`jobs`, `endgame.Finish` → `award`) every empire gets its `place` (1 is first) and its `award`, kept on `Empire`. The winners are first, together when level; then the empires still standing by resources and municipalities; then the fallen ones, the last to fall first. `award = (empires - place + 1) * (empires + turns / 5)` (integer division, `AwardTurnsPerPoint`): a whole number growing from the last to the first, worth more the more empires were in the match and the longer it lasted. Bots take a place but gather nothing; for the others the award is added to `User.elo`, with `ratedMatches + 1` and `ratedTurns +` the turns played (to the fall, or to the end). `GET /api/leaderboard` (signed in; `search`, `minMatches`, `sort` = `rank|username|matches|elo|turns`, `order`, `page`, `pageSize`) answers `{players: [{rank, username, matches, elo, turns}], total, page, pageSize}`: who has finished at least a match, `rank` being the place in the whole ranking whatever is searched. The page is `/leaderboard` (`web`, `features/leaderboard`), linked from the sidebar; the ranking of a finished match shows each player's award.
- **The atlas**: `/atlas` (`web`, `features/atlas`; open to guests, linked from the sidebar as "Mappa") shows on one map every area a match can be played on. An area is a folder that holds municipalities of its own. Only the outline of each area is loaded, never its municipalities. `GET /api/geo/atlas` answers `{unitCount, bounds, areas}`: each area has `id`, `name`, `rootId`/`rootName` (the geographic area it is part of), `unitCount`, a point (`lon`, `lat`), its `bounds`, `borders` (the areas it touches by `GeoAdjacency`) and `outline`, a GeoJSON geometry. The outline is the union of the area's municipalities, without the islands under about two km² and simplified to about 400 m; joining the borders takes seconds, so it is kept on the folder (`GeoArea.outline`, with `outlineOf` = count, last and sum of the ids it was drawn from) and drawn again by the first request after the municipalities change. The answer itself is kept in memory until folders or municipalities change. The page (`AtlasMap`, its own small MapLibre style) colours each area so that neighbours differ (`areaColors`), lists the areas under their geographic area and fits the map on the one chosen from the list or on the map.
- **Structures on the map** (`web`, `features/game/BuildPage.tsx`): the menu of the structures stays beside the map; a structure is dragged from it onto the map of the game and dropped on an own territory (`GameMap` hands out a `MapProbe` to ask which municipality is under a point of the screen), the territories it can go on lit while it is carried. One that can move is dragged from the list of what stands.
- **What is earned and spent** (`web`): when what the empire holds as a whole changes within a turn (an attack or an annexation paid for, something built, spoils), each territory shows `+N` or `−N` for a moment (markers `gain` / `loss`) and so does the counter of the resources. Resources only moved among territories show nothing.
- **Focus of the resources** (`web`, `features/game/focus.ts`): a point on the map the resources of the empire gather by, kept in the browser for each match (`match.focus.<id>`) and applied with `allocate`: when it is moved in the preliminary phase, and again at the start of every turn (`useFocusKeeper`). On the map of the game it is a bag of money to drag (`useFocusBags`, DOM markers of `GameMap`); the `+` on a bag splits it in up to six, each part carrying an equal share of what can move and spreading it around itself, and a bag dropped on another joins it. Moved outside the preliminary phase it is only remembered, for the turn to come. The resources panel shows the same focus, with its other shapes (mirror, ring, line).
- **Adjacency** of game territories is computed on demand from `TerritoryUnit` and `GeoAdjacency` (both directions, with a UNION so each uses its index).
- **Turn close** (`jobs`, `internal/turnclose`), one transaction: lock the match; do nothing unless it is `RUNNING` and `currentTurn` equals the job's turn (this makes the job repeatable); credit each active empire `incomeBase + incomePerUnit × municipalities`, split among its territories by its rule (`EQUAL`: equal parts; `WEIGHTED`: in proportion to `Territory.weight`, equal parts if all weights are zero), whole numbers, the remainder to the capital; reset `annexedThisTurn`; write `TurnSnapshot` (municipality → empire, owned ones only); set `currentTurn + 1` and `turnEndsAt + turnHours` (from when the turn was due, not from when the job ran, so a late close catches up turn by turn); record `TURN_CLOSED`; queue the next close; notify `turn.closed`.
- **Protection** is stored as the number of the turn of acquisition (`protectedUntilTurn`) and read as `>= currentTurn`: moving to the next turn ends it with no update.
- **Unit card** (`GET /matches/:id/units/:geoUnitId`): `{geoUnitId, name, territory:{id, name, ownerEmpireId, protected, inBattle, resources|null}, neighbours:[{geoUnitId, name, territoryId, ownerEmpireId}], annex}`; `annex` is `{cost, left, payFrom:[{territoryId, name, resources, usable}]}` for a player looking at a free municipality of a running match, otherwise null. `resources` of the territory is null unless it is the viewer's, free territories included.

## Battles

The api records, `jobs` decides. Nothing in the api computes an outcome.

- **Declare** (`POST /matches/:id/attacks {targetGeoUnitId, fromTerritoryIds[], turn}`, `src/modules/game/battles.ts`). After the usual action locks, the target and every source territory are locked `FOR UPDATE` in id order (`lockTerritories`); every reader or writer of a territory's resources goes through the same lock, so the amounts an attack records are the amounts really there. Checks: target owned by another empire, not protected (`protectedUntilTurn >= currentTurn`), not in a battle; each source own, adjacent to the target, not in a battle, holding at least 1. Then, in the same transaction: `Battle` row (`attackPct`, `attackCost`, `attackForce` = sum of the sources before paying, `defenseForce` = target resources now); a `BattleSource` per territory (`cost`, `resourcesAtDeclaration`); a `BattleLock` per territory involved, inserted in id order; the cost taken from each source.
- **Cost** (`src/rules/attack.ts`): `pct = min(attackMaxPct, attackPct + attackStepPct × (n − 1))`, each source pays `ceil(resources × pct / 100)`.
- **One battle per territory**: checked on the locked rows, and guaranteed by the primary key of `BattleLock` whatever the application does (a violation becomes `409 TERRITORY_IN_BATTLE`). A locked territory cannot be attacked, attack, move or receive resources, or pay for an annexation.
- **Preview** (`POST /matches/:id/attacks/preview`): the same checks and numbers, nothing saved, nothing about the defender.
- **Respond** (`POST /matches/:id/battles/:battleId/respond {action}`): only the defender, once. The answer is stored on the battle (`response`, `respondedAt`) and the battle is published on Kafka. If publishing fails the answer stays: the turn close will use it.
- **Resolve** (`jobs`, `internal/battle`), in one transaction with the battle row locked; a battle not `OPEN` is skipped, so a repeated delivery applies nothing twice.
  - `SURRENDER`: the attacker takes the territory with everything on it; each source gets back `floor(cost × surrenderRefundPct / 100)`.
  - `DEFEND`: the target pays `ceil(defenseForce × defensePct / 100)`, whoever wins; the `Resolver` draws two numbers and decides. The current one, `uniform-product-v1`, compares `attackForce × r1` with `defenseForce × r2`, `r1` and `r2` independent and uniform in [0, 1) from `crypto/rand`; the attacker wins only if strictly greater, so a tie goes to the defender. Its name, both rolls, the forces and the costs are stored on the battle.
  - Whoever wins a fought battle receives `floor((attackCost + defenseCost) × battleSpoilsPct / 100)`: the defender on the target territory, in the same write that takes the defence cost; the attacker on the source territories, each in proportion to what it paid. It is stored in `Battle.spoils` and told to the winner only.
  - If the attacker wins, the territory changes owner with what is left on it and is protected through `protectedUntilTurn`.
  - The locks are deleted, `BATTLE_RESOLVED` is recorded (names and outcome only) and `battle.resolved` is notified.
- **At turn close**, before income: every battle still open is resolved in declaration order. One with a recorded answer uses it; one without is fought as `DEFEND`: silence is never a surrender. A territory conquered here is protected through the turn that begins (`turn + 1`), because protection "until the end of the turn" that is ending would protect nothing; one conquered during a turn is protected until that turn ends.
- **Replacing the formula**: implement `battle.Resolver` and set it on the `battle.Service`; old battles keep the name of the resolver that decided them.
- **What each side sees** (`MatchService.state`, `battles`): open battles are listed for everyone with target and the two empires. The attacker also gets `fromTerritoryIds`, `attackCost`, `attackForce`; the defender gets `response`, `defenseForce`, `defenseCost`. Neither gets the other's numbers or the rolls. Battles resolved in the current or previous turn are listed for their two sides only. `Territory.battleId` is set on a target for everyone, on a source only for its owner.
- **Capital**: after a conquest `endgame.CapitalLost` runs in the same transaction (see Capital, fall and end of the match).

## Capital, fall and end of the match

- **Fall** (`jobs`, `internal/endgame`, called at the end of every battle the attacker wins): if the conquered territory was the defender's capital, in the same transaction the empire becomes `FALLEN` (`fallenTurn`, no capital); the conqueror keeps only the capital with its resources; every other territory of the fallen empire becomes free (`ownerEmpireId = NULL`) and keeps its resources, hidden like any free territory; every battle still open that the fallen empire was part of, as attacker or as defender, is closed as `CANCELLED`, its territories unlocked and the cost of the attack returned to the territories that paid it. `EMPIRE_FALLEN` is recorded.
- **Limits of a turn**: `attacksPerTurn` (5) attacks declared and `annexPerTurn` (3) annexations for each empire, whatever the mode; beyond them `409 ATTACK_LIMIT` / `ANNEX_LIMIT`, and `targets` lists nothing more of that kind. The state says what is left in `me.attacksLeft` and `me.annexLeft`.
- **Paying for an annexation** (`annexFunding` in `src/modules/game/shared.ts`): the own territory beside the municipality pays; what it lacks comes from the capital nearest to it (the capital or a second capital, not in a battle). The unit card says it in `annex.payFrom[].fromCapital`.
- **A conquered empire** (`jobs`, `endgame.dissolve`): when a capital is taken and no second capital saves the empire, every territory it still holds goes to the conqueror with its resources, protected until the turn ends. An empire abandoned by its player leaves its territories free instead.
- **Signs on the map that are buttons** (`web`): swords attack at once from every own territory beside the target that can, a flag annexes at once, and a shield on an attacked territory of the viewer, with the cost of defending over it, answers `DEFEND` at once.
- **Late attacks**: an attack declared in the last 5 seconds of a turn makes the turn 10 seconds longer, so that the defender can answer (`LATE_ATTACK_*` in `src/modules/game/battles.ts`). It is one `UPDATE` after the declaration is committed, conditional on the turn still being the same and about to end, and the `turn.close` job moves with the new end (`moveTurnClose`). The web shows the seconds added beside the clock.
- **Pause** (`POST /matches/:id/pause`, `/resume`): only the owner of a single-player match being played. `Match.pausedAt` is set: actions answer `409 MATCH_PAUSED`, except those of the preliminary phase when the match was stopped in it (the phase is read at `pausedAt`: the player can still put the empire in order); bots stop, and a `turn.close` job that comes by finds the match stopped and does nothing. Resuming moves `turnEndsAt` forward by the length of the pause and moves the pending `turn.close` job with it, or queues a new one if it already came by; bots play the turn again (`match.resumed`).
- **Phases of a turn** (`api`, `src/rules/phases.ts`): the first part of every turn is preliminary: a third of it, but at least thirty seconds and at most half the turn (thirty seconds of a rush turn of sixty). Nothing is stored: the phase follows from `turnEndsAt` and `turnHours`, and the state says when it ends in `match.preliminaryEndsAt`. In the preliminary phase only: moving resources (`allocate`), building and moving structures, merging territories, moving the capital. After it only: annexations and attacks. The other phase answers `409 WRONG_PHASE`; `targets` is empty in the preliminary phase. In the action phase `targets` lists what can be attacked (`territoryIds`) and the free municipalities that can be annexed now (`annexUnitIds`: beside an own territory that can pay, while the turn still allows an annexation): the map draws a button on each, swords that open the attack and a flag that annexes at once. Everything else (answering an attack, alliances, the board, renaming, the income rule) is done throughout. Bots do what is preliminary at the start of the turn and wait for the phase to end before moving on the others.
- **One attack per territory per turn** (`jobs`, battle resolution): a territory that was attacked and defended is protected through the turn of that battle (`protectedUntilTurn`), exactly like one that was conquered; a battle fought while its turn closes leaves the territory open in the turn that begins.
- **Abandon** (`POST /api/matches/:id/abandon`, `202`): a player leaves for good a match that is being played (`409 MATCH_NOT_ONGOING` otherwise; before the start a player withdraws instead). The api only checks and enqueues the job `empire.abandon` `{ "matchId": string, "empireId": string }`, once per empire; `jobs` (`endgame.Abandon`) does to the empire what a fall does, except that the capital too becomes free: open battles cancelled and refunded, pacts and structures ended, every territory without an owner and with its resources, the empire `FALLEN`. `EMPIRE_ABANDONED` (`data.empireName`) is recorded. The match ends if one empire is left (it wins) or if no player is left: bots alone are ranked as at the deadline.
- **Spectator**: the player of a fallen empire still gets `me` in the state, with `status: "FALLEN"`; every action answers `409 EMPIRE_FALLEN`. A fallen empire is not counted in `online.total`.
- **End, last empire standing**: when a fall leaves one active empire the match is `FINISHED` at once with that empire as `winnerEmpireId`, whether or not it has a maximum duration.
- **End, deadline**: a match with `maxDays` ends at the first turn close whose turn ended on or after `startAt + maxDays` days. That close does everything a close does (battles, income, alerts, snapshot) and then, instead of opening a turn, picks the winner: most total resources among active empires; if equal, most municipalities; if still equal, the one that joined first.
- **Finishing** cancels any battle still open (as above), sets `finishedAt` and `winnerEmpireId`, records `MATCH_FINISHED` and notifies `match.finished`. Pending `turn.close` jobs find the match not running and do nothing. Only when the match is finished does the state carry `resources` (the total) on every empire.
- **Move the capital** (`POST /matches/:id/capital {territoryId, turn}`): to another own territory, at most once every `capitalMoveEveryTurns` turns (`Empire.lastCapitalMoveTurn`), and not while the old or the new capital is in a battle. `me.capitalMoveInTurns` says how many turns are left to wait. `CAPITAL_MOVED` is recorded.
- **Accumulation alert** (`endgame.UpdateAccumulationAlerts`, at turn close after income): for empires with at least `accumAlertMinTerritories` territories, a territory holding more than `accumAlertPct`% of the empire's resources is noted (`aboveAlertAtLastClose`); if it was already noted at the previous close, `alert` is set. It clears at the first close below the threshold. `alert` is public in the state and carries no amount.

## Structures and merged areas

- **Catalogue** (`api/src/rules/structures.ts`): each `StructureDefinition` declares `type`, `cost(rules, turnValue)`, `durationTurns(rules)` (null = permanent), optional `cooldownTurns`, `maxPerEmpire`, `notOnCapital`, `moveEveryTurns`, and its `effects`. `registerStructure` adds one. **Adding a structure is adding an entry here** (plus its rule values in `rules/config.ts` and its texts in the web locale): no migration, no change in `jobs`, none in the battle rules.
- **Effects, not types**: `NO_ATTACK_ON`, `NO_ATTACK_FROM`, `BACKUP_CAPITAL`. They are copied into `Structure.data.effects` when a structure is built, and that is all the rest of the game reads: the attack checks in `api`, the promotion of a second capital in `jobs`, the signs on the map in `web`. A structure of a type nobody knows, with known effects, works everywhere.
- **Costs in turns**: `turnsToResources(n, turnValue) = ceil(n × turnValue)`, with `turnValue` the empire's income at the moment of the purchase. The cost is paid from the territory the structure stands on.
- **Build** (`POST /matches/:id/structures {type, territoryId, turn}`): the territory is locked; `structureBlock` gives the first reason it cannot be built (`IN_BATTLE`, `ON_CAPITAL`, `ALREADY_HERE`, `ONE_PER_EMPIRE`, `COOLDOWN`, `NOT_ENOUGH_RESOURCES`), returned as `409 STRUCTURE_<reason>`. Built in turn T for N turns: `expiresTurn = T + N − 1`, `cooldownUntilTurn = expiresTurn + cooldown`; another of the same type can be built there from the turn after.
- **Expiry** (`jobs`, turn close): `active = false` where `expiresTurn <= turn`, for every structure alike.
- **Second capital**: when a capital is conquered, `endgame.CapitalLost` first looks for an active structure of the losing empire with `BACKUP_CAPITAL` on a territory it still holds: if there is one, that territory becomes the capital, the structure is used up, `CAPITAL_PROMOTED` is recorded and the empire survives. A conquered territory loses the structures on it. A fallen empire loses all of them. It moves with `POST /matches/:id/structures/:structureId/move`, at its own interval (`data.lastMoveTurn`), independent of the main capital's.
- **Catalogue for a player** (`GET /matches/:id/structures/catalogue`): for each structure the cost now and, for each own territory, whether it can be built there and why not.
- **Merge** (`POST /matches/:id/merge {territoryIds[], name, turn}`, preview at `/merge/preview`): own territories, at least two, none in a battle, at most `mergeMaxUnits` municipalities in all, connected through shared borders; cost `ceil(mergeCostTurns × turnValue)` per territory included, paid from the sum of their resources. One `Territory` row survives (the capital's if it is among them, so the capital stays), takes the `TerritoryUnit` rows and the structures of the others, the summed resources minus the cost, the summed weights, `isArea = true` and the chosen name; the other rows are deleted. Nothing else changes: adjacency, income and counts are all computed from municipalities, so an area borders what its municipalities border and counts for as many as it contains. Problems: `TOO_FEW`, `NOT_YOURS`, `IN_BATTLE`, `TOO_MANY`, `NOT_CONTIGUOUS`, `NOT_ENOUGH_RESOURCES` (`409 MERGE_<problem>`).
- **Area outlines** (`GET /matches/:id/areas`): GeoJSON, one feature per area, geometry `ST_Union` of the simplified municipalities, with name and a point inside. The union is computed by PostGIS on request, in the api: areas are few and small, so no job is involved.
- **State**: `structures: [{id, type, territoryId, empireId, effects, turnsLeft}]`, active ones, public.

## Board

- The board is the public face of `GameEvent`: no separate table. An announcement is a typed domain event written by whatever caused it (`api` for joins, annexations, capitals, areas; `jobs` for battles, falls, starts and ends); a player's message is an event of type `MESSAGE` with `data.text`.
- `BOARD_KINDS` (`api/src/modules/board/service.ts`) says which event types appear and under which filter: `messages`, `empires`, `annexations`, `battles`, `capitals`, `areas`, `alliances`, `match`. Events not listed (`TURN_CLOSED`, `MATCH_OPENED`…) stay off the board. **Adding an announcement** is recording a new event type, listing it in `BOARD_KINDS` and giving it a sentence in the web locale (`game.board.events.<TYPE>`).
- `GET /matches/:id/board?kind=&empireId=&before=&limit=`: newest first, for anyone who can see the match. Each entry is `{id, type, turn, createdAt, empireId, territoryId, geoUnitId, data}`; `geoUnitId` is a municipality of the territory the event is about, so the client can centre the map on it. `empireId` filters on the empire of the event or, for battles, the defender.
- **No amounts, ever**: `data` holds names and codes only, as strings. The api does not write the text: the web interface builds each sentence from the event's type and names, which is also what makes it translatable.
- `POST /matches/:id/board {text}`: only a player with an active empire, in a match not finished; at most `boardMaxChars` characters; at least `boardMessageIntervalSec` seconds after the same empire's previous message, checked in the database with the empire row locked (`429 RATE_LIMITED` with `Retry-After`).
- `DELETE /matches/:id/board/:eventId`: the owner of the match or the platform admin; messages only (`removedAt`, `removedById`). Automatic announcements are the record of what happened and cannot be removed.
- Live updates: every change sends `match.update` to the followers of the match and the client reads the board again; there is no separate board message on the socket.

## Languages

The interface is in Italian and in English (`locales/it.json`, `locales/en.json`).

- **Adding a language** is adding `web/src/i18n/locales/<code>.json` (a copy of `it.json`, translated). Nothing else: `i18n/index.ts` finds the files at build time (`import.meta.glob`), each becomes its own chunk loaded only when chosen, and the selector in the account panel (`i18n/LanguageSelect.tsx`) appears as soon as there are two. Languages are listed under their own name (`Intl.DisplayNames`).
- **Which language**: the one chosen before on the device (`localStorage` key `lang`), otherwise the first language of the browser that exists, otherwise Italian. It is set before the first render and written on `<html lang>`. Italian is the fallback for any key a translation lacks.
- **Kept in step by a test** (`i18n/i18n.test.tsx`): every locale file must have exactly the messages of the Italian one (plural endings aside, since languages differ in their plural forms) and may not use a placeholder the Italian message does not have. Keys are also typed against `it.json`, so a key used in code and missing there does not compile.
- **Nothing to translate comes from the server**: errors are codes, board and history entries are event types with names, structures are types; the interface writes every sentence. Dates, numbers and relative times are formatted with the current language. Names of municipalities are data and stay as they are (they are searched and sorted with Italian rules whatever the language).
- Not prepared: right-to-left layouts, and texts of the game written by players (empire names, messages), which are shown as typed.

## Production

- `docker-compose.prod.yml` is an override of the base file (`ports: !reset []` removes what development publishes): a Caddy `proxy` terminates TLS for `DOMAIN` and is the only published service; secrets are required from `.env`; restart policies, log rotation, memory caps, `COOKIE_SECURE`, and the `backup` service on. `scripts/deploy.sh` is backup → build → up → wait for `/api/health/ready`. Operator's guide: `docs/RILASCIO.md`.
- **Client address**: Caddy sets `X-Forwarded-For` (ignoring the client's), nginx in `web` believes it only from `REAL_IP_FROM` (the compose network in production, nobody in development) and passes the result to the api, which trusts its proxy (`TRUST_PROXY`). Rate limits and session records therefore see the real address and a client cannot choose it.
- **Images**: the api starts as root only to hand the uploads volume to `node`, then drops privileges (`setpriv`) before migrating and serving; `jobs` runs as an unprivileged user; `web` is nginx with its config rendered from `nginx.conf.template` at start and the security headers of `security-headers.conf` (CSP included: every external origin the interface loads is listed there).

## Performance under load

Measured and explained in `docs/LOAD.md`. What exists because of it:

- **Coalesced pushes** (`RealtimeHub`, `MATCH_UPDATE_WINDOW_MS`): at most one `match.update` per match per window, leading and trailing, with the kinds of the collapsed changes merged. `battle.incoming` and `match.online` are not delayed.
- **Shared state reading** (`MatchService.load` / `loadShared`, `MATCH_STATE_CACHE_MS`): everything the state of a match is made of is read once and shared by concurrent viewers; `state()` derives each viewer's view in memory, which is where hidden information is enforced. `forget(matchId)` is called by `app.matchChanged`, the single path for changes made by the api (`onChange` of every service) and by `jobs` (notifications). Off (`0`) unless configured, so tests that write to the database directly read what they wrote.
- **Single flight** (`TileCache.load`): one generation per tile however many ask at once; also holds the serialised list of municipalities of a match.
- **Pool** (`DATABASE_POOL_SIZE`) and a glibc image for the api.
- All three caches are in the memory of the api process, like the hub: the api is a single instance. Scaling it out needs a shared channel for changes (every change published through PostgreSQL `NOTIFY` or Kafka, not only those of `jobs`) before anything else.

## Accessibility

- **Automated checks** (`web`): `src/test/a11y.ts` runs axe (WCAG 2.1 A and AA, best practices) on a rendered page; `src/app/a11y.test.tsx` applies it to the homepage, the account panel, the new-match form and every page of the match panel. A new page gets a line there.
- **Contrast** cannot be judged in jsdom, so it is checked where colours are defined: `src/styles/contrast.test.ts` reads `theme.css`, resolves `var()` and `color-mix()`, and asserts the ratio of every text/ground pair in use. A new token pair gets a row there.
- **Not by colour alone**: `features/game/tags.ts` (`empireTags`) derives a short unique tag per empire; `MatchPage` turns ownership into `ownerTags` for `GameMap`, which draws them from the `owners` GeoJSON source as the `owner-tags` symbol layer, placed after names and signs so those win collisions. Works in the turn review too.
- **Keyboard**: `features/game/UnitSearch.tsx` selects a municipality by name through the same path as a tap on the map; `Layout` starts with a skip link to `main#contenuto`; the map canvas has an accessible name and MapLibre's keyboard handler (rotation disabled).

## Logs and error tracking

Both services write one JSON object per line on standard output; the container runtime collects them. No external tracker is wired in: every line that matters carries a stable `event` field, which is what a log collector searches and alerts on.

| `event` | Service | Level | When | Fields |
| --- | --- | --- | --- | --- |
| `request` | api | info, error for 5xx | every answered request, except a successful `/api/health` | `reqId`, `method`, `route` (the pattern, e.g. `/api/matches/:id/annex`, never the raw URL), `status`, `ms`, `userId`, `matchId` |
| `unhandled_error` | api | error | a failure no handler foresaw (the client gets `500 INTERNAL`) | `reqId`, `err` with stack, `method`, `route`, `userId` |
| `client_error` | api | warn | the web interface reported an error | `message`, `stack`, `path`, `kind` (`render`, `error`, `rejection`) |
| `process_crash` | api | fatal | an exception outside any request; the process exits and is restarted | `cause`, `err` |

- **Request id**: generated by the api for every request (never taken from the client), returned in the `x-request-id` header and, for a `500`, in the body as `error.requestId`. A report from a player with that id leads to the `unhandled_error` line.
- **What is never logged**: request bodies, query strings, cookies and authorization headers (also redacted by path, with `*.password` and `*.token`, should an object containing them ever be logged). Expected client errors (`4xx`) are `request` lines at info level, not errors.
- **Who**: the auth guard writes the user's id on the request once the session is resolved; anonymous calls have `userId: null`.
- **Web**: `lib/report.ts` posts to `POST /api/client-errors` what breaks a page while rendering (the router's `errorElement`, `app/ErrorPage.tsx`, which keeps the navbar and offers a reload), script errors and unhandled promise rejections. At most 5 per page load, each message once; the api accepts 20 a minute per address and only logs them.
- **jobs** logs with `slog` in JSON: `job done` / `job failed` (with `id`, `type`, `attempt`, `retry`, `err`), `turn closed`, `battle resolved`, `match started` / `match finished`, each with `matchId`. A panic inside a job is recovered and recorded as that job's failure. `LOG_LEVEL` sets the level in both services.

## Turn history

- `TurnSnapshot (matchId, turn, ownership)` holds `{geoUnitId: empireId}` for the owned municipalities at the end of a turn. `jobs` writes it at every turn close and in `endgame.Finish`, so the last turn of a match is there even when the match ends in the middle of it. A turn is "closed" when its snapshot exists.
- `GET /matches/:id/history` → `[{turn, closedAt, events: number}]`, newest first. `GET /matches/:id/history/:turn` → `{turn, closedAt, events: BoardEntry[], ownership}`, `404` for a turn without snapshot. Both in `BoardService`: the history is the event log read by turn, with the same entries as the board minus `MESSAGE`. Events recorded before the start (turn 0) are listed under turn 1.
- Nothing about resources is stored per turn, so the history cannot leak them; the tests assert the exact keys returned.
- Web: `features/game/HistoryPage.tsx`; `MatchPage` keeps `review: number | null` and, while it is set, feeds `GameMap` the colours of the snapshot and no markers, labels, areas or highlights. A closed turn is cached forever (`staleTime: Infinity`); the list of turns sits under the `['matches','unit',matchId,…]` key and is read again on `match.update`.

## Alliances

- An alliance is a **pact between two empires**: one `Alliance` row with `aEmpireId < bEmpireId` (unique pair), `endsAtTurn` and `endedByEmpireId`. There is no membership table and no group: `areAllies(tx, x, y)` is a lookup of the pair, and nothing is transitive. Code in `api/src/modules/game/alliances.ts`.
- Proposal → `AllianceInvite`; accepting locks both empire rows, checks both sides against `allianceMaxAllies` and that the two are not fighting, then creates the pact. Routes: `POST /matches/:id/alliances/invites`, `…/invites/:inviteId/{accept|decline|withdraw}`, `POST …/alliances/:allianceId/{end|keep}`, `POST …/alliances/transfer`, `GET|POST …/alliances/:allianceId/chat`.
- `end` sets `endsAtTurn = currentTurn + allianceLeaveNoticeTurns`; `keep` clears it and is allowed only to `endedByEmpireId`. `jobs` (`endgame.ApplyAllianceExits`) deletes the pacts whose turn has closed and records `ALLIANCE_ENDED`; the fall of an empire deletes its pacts.
- State: `alliances: [{id, empireIds: [a, b], endsAtTurn, endedByEmpireId}]`, public. Resources are visible to the owner and to the other empire of each of its pacts.

## Bots

- A bot is an ordinary `Empire` of a `User` with `isBot` (no password matches it, and login looks only among non-bots). `api/src/modules/bots/service.ts` plays it **through the same services a player's requests reach** (`MatchService.join`, `GameService.annex`, `BattleService.declare/respond`, …) with a synthetic `AuthContext`: every rule, lock and limit applies as it is, and a bot knows only what the unit cards and its own state show a player.
- `BotService.playTurn(matchId)`: maybe spawns one (`botsEnabled`, `botsMax`, `botSpawnChancePct`; on a free municipality two steps from an owned one), then each bot acts. `answerAttacks(matchId)`: bots under attack answer. A refusal by the game (`AppError` below 500) is a normal outcome; anything else is logged as `bot_error`.
- `BotRunner` decides when: it is told of every change of a match (`app.matchChanged`) and schedules `playTurn` on `turn.closed` / `match.started` and `answerAttacks` on `battles`, after a short random pause, one task at a time per match. It runs only where `runBots` is set (the server, not the tests); `app.wakeBots()` at startup covers the turn a restart may have missed.
- Bots live in the api process like the hub: one more reason the api is a single instance.

## Empire logos

- `EmpireLogo (empireId, mime, data, updatedAt)`: the image is in the database, so it travels with backups. `PUT /matches/:id/empire/logo` takes the bare image (content types `image/png|jpeg|webp`, at most 200 KB); `readLogo` decides what it is **from its bytes**, so an SVG or a script called a picture is refused. `GET /matches/:id/empires/:empireId/logo?v=…` serves it with `nosniff` and `Content-Security-Policy: default-src 'none'`; `DELETE` is for its owner, the owner of the match and the admin.
- State: `empires[].logoUrl` (versioned by `updatedAt`, cacheable forever). Web: `EmpireShield` cuts the image to the shield; on the map `features/map/capital-icon.ts` draws the arms of each empire (emblem or logo) on a canvas and adds it as a MapLibre image, used by the `capital-arms` symbol layer over the plain disc, which stays as the fallback.

## End-to-end tests

- `e2e/` (root repository): Playwright against the running stack, **at phone size** (two projects: 412×915 and 360×640, Chromium with touch). The setup (`support/world.ts`) loads the province of Milan through the admin upload if it is not there, creates two users with a session straight in the database, and a running match in a known position; the teardown removes users and match.
- **Rule: a change to the interface comes with its phone test.** Each test checks at least that nothing sticks out of the screen sideways (`expectNoSidewaysScroll`) and that what must be tapped is big enough (`expectTappable`). Screenshots of every screen are saved in `e2e/test-results/` for a look.
- Run: `docker compose up -d`, then `cd e2e && pnpm install && pnpm exec playwright install chromium && pnpm test`. In CI: `.github/workflows/e2e.yml` of the root repository builds the stack from the four repositories and runs them.

## Game mechanics, precisely

All amounts are integers; percentages round the cost up (`ceil`).

- **Join**: the player picks a free territory. It becomes the capital, owner set, `resources = hiddenStart + startResources`, protected for the current turn. Before the match is `RUNNING` the same call is allowed while `OPEN`.
- **Annex** (immediate): target free and adjacent to a territory of the empire; empire has not used its annexations this turn; `payFrom` is an own territory adjacent to the target, not in an open battle, with `resources >= annexCost`. Effects: pay; target owner = empire (its resources, previously hidden, stay on it); `protectedUntilTurn = currentTurn`.
- **Allocate** (immediate): body gives the new amount for some own territories not in an open battle; the sum must equal the current sum over those same territories. No unallocated resources are ever stored.
- **Attack** (immediate declaration): target owned by another active empire, not protected, no open battle on it, no active block; `from` = 1..n own territories adjacent to the target, each with `resources >= 1`, not in an open battle, without an active block. `pct = min(attackMaxPct, attackPct + attackStepPct * (n - 1))`; each source pays `ceil(resources * pct / 100)`; `attackForce` = sum of the sources' resources **before** paying. Sources and target get a `BattleLock` row and are locked (no allocation, no build, no merge, no other battle) while the battle is open.
- **Respond**: `api` records `Battle.response` and publishes the battle on Kafka; `jobs` resolves it at once. `DEFEND` pays `ceil(targetResources * defensePct / 100)` from the target, `defenseForce` = target resources **before** paying; outcome `attackForce * r1 > defenseForce * r2` → attacker wins (`r1`, `r2` uniform in [0,1) from a CSPRNG, stored on the battle; a tie goes to the defender). Whoever wins a fought battle receives `floor((attackCost + defenseCost) * battleSpoilsPct / 100)` (the defender on the target, the attacker on the sources), stored in `Battle.spoils` and told to the winner only. `SURRENDER`: attacker wins and each source gets back `floor(cost * surrenderRefundPct / 100)`.
- **Attacker wins**: target owner = attacker, target keeps whatever resources are left on it, `protectedUntilTurn = currentTurn`. If the target was the defender's capital: if the defender has a second capital it is promoted and the defender survives; otherwise the defender empire is `FALLEN` and all its other territories become free, keeping their resources.
- **Unanswered battle at turn close**: treated as `DEFEND`. A battle with a recorded response that is still open (its Kafka message was lost) is resolved with that response.
- **Turn close** (`jobs`, one transaction): resolve unanswered battles; credit each active empire `incomeBase + incomePerUnit * units`, split across its territories by `Territory.weight` (equal weights by default, remainder to the capital); reset `annexedThisTurn`; expire structures whose `expiresTurn <= currentTurn`; update accumulation alerts (a territory holding more than `accumAlertPct` of its empire's resources at two consecutive closes, only for empires with at least `accumAlertMinTerritories` territories); write `TurnSnapshot`; check end of match; advance `currentTurn`, set `turnEndsAt`, enqueue the next `turn.close`.
- **End of match**: when `maxDays` is reached the active empire with the most total resources wins (tie: more GeoUnits). Without `maxDays`, the last active empire wins.
- **Move capital**: to another own territory, at most once every `capitalMoveEveryTurns` turns, neither territory in an open battle.
- **Merge**: 2..`mergeMaxUnits` own territories, connected through match adjacency, none in an open battle; cost `ceil(mergeCostTurns * turnValue) * count` paid from the sum of their resources; result is one territory (keep the capital's row if included) holding the remaining resources and all units; adjacency is the union. Renaming an area is free.
- **Structures**: `BLOCK` costs `blockCost` from the territory, lasts `blockTurns`, then the same territory cannot get another for `blockCooldownTurns`; a blocked territory cannot be attacked and cannot attack. `SECOND_CAPITAL` costs `ceil(secondCapitalCostTurns * turnValue)` from the territory, one per empire, not on the capital.
- **Hidden starting resources**: drawn per territory when the match is created, server side, from a normal(`hiddenMean`, `hiddenSd`) truncated to [`hiddenMin`, `hiddenMax`].

## REST API

Base path `/api`. JSON bodies, zod-validated. Errors: `{ "error": { "code": string, "message": string } }` with 400 (`VALIDATION`, with `fields`; `BAD_REQUEST`), 401 (`UNAUTHENTICATED`), 403 (`FORBIDDEN`), 404 (`NOT_FOUND`), 409, 429 (`RATE_LIMITED`), 500 (`INTERNAL`). Routes marked with a milestone in this table do not exist yet. Auth is the session cookie.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /auth/register` `{username,email,password}` | none | create user (email not unique), start session; `201`, `409 USERNAME_TAKEN`, `429` |
| `POST /auth/login` `{username,password}` | none | start session; `401 INVALID_CREDENTIALS`, `429` |
| `POST /auth/logout` | user | revoke current session |
| `GET /auth/me` | user | `{id,username,role}` |
| `GET /stats/online` | none | `{online:number}` |
| `GET /admin/sessions` / `DELETE /admin/sessions/:id` | admin | active sessions (`id, createdAt, lastSeenAt, expiresAt, ip, userAgent, user, connected, current`) and revoke |
| `GET /admin/stats` | admin | `{users, matchesRunning, online}`; `users` counts players, not the admin |
| `GET /admin/geo/areas` | admin | flat list of the tree: `{id, name, parentId, uploadCount, unitCount}`, `unitCount` including descendants |
| `POST /admin/geo/areas` `{name, parentId?}` / `PATCH /admin/geo/areas/:id` `{name}` / `DELETE /admin/geo/areas/:id` | admin | create, rename, delete; `409 AREA_NAME_TAKEN`, `409 AREA_IN_USE` |
| `POST /admin/geo/areas/:id/uploads` (multipart `file`) | admin | store the file, create the `GeoUpload`, enqueue `geo.process`; `400 UNSUPPORTED_FILE`, `413 FILE_TOO_LARGE` |
| `GET /admin/geo/uploads?areaId=` / `GET /admin/geo/uploads/:id` / `DELETE /admin/geo/uploads/:id` | admin | status, progress, errors; delete with its municipalities (`409 UPLOAD_IN_PROGRESS`, `409 UPLOAD_IN_USE`) |
| `GET /admin/geo/units?q=&limit=` | admin | find municipalities by name (at least 2 characters) |
| `GET /admin/geo/units/:id/neighbours` | admin | neighbours of a municipality, each with `manual` |
| `GET /admin/geo/adjacency/manual` / `POST /admin/geo/adjacency` `{aId,bId}` / `DELETE` same body | admin | manual adjacencies; `409 ALREADY_ADJACENT` |
| `GET /geo/areas` | none | geographic areas that have municipalities: `{id, name, unitCount}`, largest first |
| `GET /geo/areas/:id/map` | none | `{id, name, unitCount, bounds, version, tiles, minZoom, maxZoom, labelMinZoom}` for any folder |
| `GET /geo/areas/:id/units` | none | `[{id, name, lon, lat}]`: every municipality of the folder with a point inside it |
| `GET /geo/areas/:id/tiles/:z/:x/:y.mvt?v=` | none | vector tile (see Map) |
| `GET /matches/options` | none | `{rules, maxPlayersLimit, colors, emblems}`: defaults and catalogue for the forms |
| `GET /geo/tree` | none | every folder with the municipalities under it: `{id, name, parentId, unitCount}` |
| `GET /matches?name=&size=&page=&pageSize=` | none | `OPEN` and `RUNNING` matches, paged: `{page, pageSize, total, matches}`; `size` by enrolled players: `free`, `s` (≤20), `m` (21–50), `l` (>50) |
| `GET /matches/mine` | user | matches the user owns (drafts included) or plays |
| `POST /matches` `{name, areaIds[], startAt, maxDays?, maxPlayers?, turnHours?, inviteCode?, config?}` | user | create a `DRAFT`; `config` holds only the rules that differ from the defaults |
| `GET /matches/:id` | none | summary: `{id, name, status, startAt, maxDays, maxPlayers, turnHours, currentTurn, turnEndsAt, players, hasInviteCode, owner, areas, config, isOwner}`, plus `inviteCode` for the owner |
| `PATCH /matches/:id` / `DELETE /matches/:id` | owner | change (`409 MATCH_LOCKED`, `TOO_FEW_SEATS`, `START_IN_PAST`); delete a draft (`409 NOT_A_DRAFT`) |
| `POST /matches/:id/open` | owner | open registrations: create territories, schedule the start; `409 START_IN_PAST`, `NO_UNITS`, `NOT_A_DRAFT` |
| `POST /matches/:id/join` `{geoUnitId, empire:{name,color,emblem,motto}, inviteCode?}` | user | found an empire; `403 INVITE_CODE_REQUIRED`, `409 REGISTRATION_CLOSED`, `ALREADY_JOINED`, `MATCH_FULL`, `TERRITORY_TAKEN`, `EMPIRE_NAME_TAKEN`, `EMPIRE_COLOR_TAKEN` |
| `PATCH /matches/:id/empire` `{name,color,emblem,motto}` | player | restyle before the start; `409 MATCH_STARTED` |
| `GET /matches/:id/map` / `/units` / `/tiles/:z/:x/:y.mvt?v=` | none | map of the match (see Matches) |
| `GET /matches/:id/state` | optional | everything the viewer may see (below) |
| `GET /matches/:id/units/:geoUnitId` | optional | card of a municipality (see Turns and immediate actions) |
| `POST /matches/:id/annex` `{geoUnitId, payFromTerritoryId, turn}` | player | `409 ANNEX_LIMIT`, `TERRITORY_TAKEN`, `NOT_ADJACENT`, `NOT_ENOUGH_RESOURCES`, `TERRITORY_IN_BATTLE`, `NOT_YOUR_TERRITORY`, `TURN_CHANGED`, `MATCH_NOT_RUNNING`; `403 NOT_A_PLAYER` |
| `POST /matches/:id/allocate` `{amounts:{[territoryId]:number}, turn}` | player | `409 ALLOCATION_SUM`, `TERRITORY_IN_BATTLE`, `NOT_YOUR_TERRITORY` |
| `PUT /matches/:id/allocation-rule` `{mode, weights?}` | player | how each turn's income is split |
| `POST /matches/:id/attacks/preview` `{targetGeoUnitId, fromTerritoryIds[]}` | player | `{pct, totalCost, force, from:[{territoryId, name, resources, cost}]}` |
| `POST /matches/:id/attacks` `{targetGeoUnitId, fromTerritoryIds[], turn}` | player | declare; `409 TARGET_IS_FREE`, `TARGET_IS_YOURS`, `TARGET_PROTECTED`, `TERRITORY_IN_BATTLE`, `NOT_ADJACENT`, `NOT_ENOUGH_RESOURCES`, `NOT_YOUR_TERRITORY`, `TURN_CHANGED` |
| `POST /matches/:id/battles/:battleId/respond` `{action:"DEFEND"|"SURRENDER"}` | defender | `403 NOT_THE_DEFENDER`, `409 BATTLE_ANSWERED` |
| `POST /matches/:id/capital` `{territoryId, turn}` | player | move the capital; `409 ALREADY_CAPITAL`, `CAPITAL_MOVED_RECENTLY`, `TERRITORY_IN_BATTLE`, `NOT_YOUR_TERRITORY` |
| `POST /matches/:id/merge/preview` `{territoryIds[]}` / `POST /matches/:id/merge` `{territoryIds[], name, turn}` | player | cost and feasibility; merge into one area |
| `GET /matches/:id/areas` | none | outlines of the merged areas, GeoJSON |
| `PATCH /matches/:id/territories/:territoryId` `{name}` | player | rename an own area |
| `GET /matches/:id/structures/catalogue` | player | what can be built, where, at what cost |
| `POST /matches/:id/structures` `{type, territoryId, turn}` / `POST /matches/:id/structures/:structureId/move` `{territoryId, turn}` | player | build; move a movable structure |
| `GET /matches/:id/board?kind=&empireId=&before=&limit=` / `POST` `{text}` / `DELETE /matches/:id/board/:eventId` | read: any; write: player; delete: owner or admin | `400 MESSAGE_TOO_LONG`, `429 RATE_LIMITED` |
| `GET /matches/:id/history` · `GET /matches/:id/history/:turn` | any | Closed turns with their events and the ownership at the end of each; `404` for a turn not closed |
| `POST /client-errors` `{message, stack?, path?, kind?}` | any | An error of the web interface, logged and nothing else; always `204` |
| `POST /matches/:id/alliances/invites` `{toEmpireId}` · `POST …/invites/:inviteId/{accept\|decline\|withdraw}` · `POST …/alliances/leave` · `POST …/alliances/transfer` `{fromTerritoryId, toTerritoryId, amount, turn}` · `GET\|POST …/alliances/chat` `{text}` | player | Alliances: all return the match state, the chat returns its messages newest first |
| `GET /matches/:id/history` | any | `[{turn, events:[...]}]` |
| `GET /matches/:id/history/:turn` | any | `{turn, ownership:{[geoUnitId]:empireId|null}}` |

`GET /matches/:id/state` response today (battles, alerts, structures and live counters join it with their milestones):

```ts
{
  match: MatchSummary,                       // as GET /matches/:id
  me: null | { empireId, annexLeft, turnValue, allocationMode, status, capitalMoveInTurns },
  empires: [{ id, name, color, emblem, motto, username, status, capitalTerritoryId, units: number }],
  // Owned territories only: every other municipality of the match is free.
  territories: [{ id, name, ownerEmpireId, geoUnitIds: number[], isArea: boolean, protected: boolean,
                  resources: number | null /* null = hidden from this viewer */,
                  weight: number | null /* own territories only */,
                  battleId: string | null /* targets for everyone, sources for their owner */,
                  alert: boolean }],
  battles: [/* see Battles */],
  alliances: [{ id, empireIds: [a, b], endsAtTurn: number | null, endedByEmpireId }],   // public
  invites: [{ id, fromEmpireId, toEmpireId }],                               // the viewer's only
  online: { connected: number, total: number }
}
```

Never include another empire's resources, costs, forces or rolls. Events in board and history carry no amounts.

## WebSocket

`GET /ws`. Authentication is optional and comes from the session cookie of the handshake: a socket opened as a guest stays a guest, so the client reopens it after login and logout.

Client → server: `{t:"sub",matchId}` and `{t:"unsub",matchId}` to follow a match; the client sends its subscriptions again after every reconnection.

Server → client:

- `{t:"online",n}` global count, sent on connect and whenever it changes
- `{t:"session.revoked"}` then the socket closes with code `4401`: the session was revoked, logged out or has expired
- `{t:"match.update",matchId,kinds:string[]}` to the followers of a match when something in it changed (`kinds` hints at what: `match`, `empires`, `territories`, `resources`, `battles`, `battle.resolved`, `turn.closed`, `match.started`). It carries no data: the client reads `/state` again, so what a viewer may see is decided in one place
- `{t:"match.online",matchId,connected}` to the followers of a match when the number of its players watching it changes
- `{t:"battle.incoming",matchId,battleId}` only to the attacked player, when an attack on them is declared

"Online" = distinct users with a valid session and at least one open socket; guests are not counted. The same number is at `GET /api/stats/online`. Per match, "connected" = distinct users with an active empire in the match and a socket following it; the total is the number of active empires. Whether a user plays in a match is read once, when the socket subscribes.

The server pings every 30 s and drops sockets that do not answer; sessions that expire while connected are disconnected within a minute. The registry of sockets (`src/realtime/hub.ts`) lives in the api process. What `jobs` commits (a turn closed, a match started) reaches the api as a `game_events` notification and is forwarded as `match.update`.

## Event types (`GameEvent.type`)

`MATCH_OPENED`, `MATCH_STARTED`, `TURN_CLOSED`, `EMPIRE_CREATED` and `ANNEXED` (`data.empireName`, `data.territoryName`), `BATTLE_RESOLVED` (`data.attackerName`, `data.defenderName`, `data.territoryName`, `data.outcome`, `data.defenderEmpireId`), `BATTLE_DECLARED` (not public until resolved), `BATTLE_RESOLVED` (`data.outcome`), `EMPIRE_FALLEN`, `CAPITAL_BUILT`, `CAPITAL_MOVED`, `CAPITAL_PROMOTED`, `AREA_CREATED`, `AREA_RENAMED`, `MESSAGE` (`data.text`), `MATCH_STARTED`, `MATCH_FINISHED`. `data` holds ids and names only, never amounts.
