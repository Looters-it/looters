# Architecture contract

This file is the contract between the three services. Game rules live in `../../PROMPT.md` (§2, §9); the validated UI in `../../PROMPT.md` §11 and `../../prototipo/`. If code and this file disagree, fix one of them in the same change.

## Services

| Service | Stack | Port | Owns |
|---|---|---|---|
| `db` | PostgreSQL 16 + PostGIS 3.4 (`postgis/postgis:16-3.4`) | 5432 (5433 on the host) | data |
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

- `api`: `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_BATTLE_TOPIC` (default `battle.resolve`), `PORT`, `HOST`, `LOG_LEVEL`, `UPLOAD_DIR`; seed only: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (at least 12 characters), `ADMIN_EMAIL`; tests: `TEST_DATABASE_URL`, `TEST_KAFKA_BROKERS`. From M2: `SESSION_COOKIE_NAME` (default `sid`), `SESSION_TTL_HOURS` (default 720).
- `jobs`: `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_BATTLE_TOPIC`, `KAFKA_GROUP_ID` (default `gioco-jobs`), `UPLOAD_DIR`, `JOBS_POLL_MS` (1000), `JOBS_WORKERS` (4), `JOBS_MAX_ATTEMPTS` (5), `JOBS_STALE_AFTER_SEC` (300); tests: `TEST_DATABASE_URL`, `TEST_KAFKA_BROKERS`.
- `web`: `API_PROXY_TARGET` (dev server only).
- root `.env` (read by compose): `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`, optional `KAFKA_BATTLE_TOPIC`, `KAFKA_BATTLE_PARTITIONS` (6).

## Queues and notifications

There are two channels from `api` to `jobs`, and one back.

### Job table (scheduled and one-off work)

- Table `Job` (see schema). `api` inserts rows (`src/queue/jobs.ts`), inside the same transaction as the change that needs the job when there is one. `jobs` claims them with `UPDATE ... WHERE id = (SELECT ... WHERE status='PENDING' AND "runAt" <= now ORDER BY "runAt" FOR UPDATE SKIP LOCKED LIMIT 1)`, sets `RUNNING`, then `DONE` or, after `JOBS_MAX_ATTEMPTS`, `FAILED` with `lastError`. Failed attempts are retried with backoff (5s, 10s, 20s… up to 5 min) by pushing `runAt` forward. A job `RUNNING` for longer than `JOBS_STALE_AFTER_SEC` is put back in the queue.
- `Job.dedupeKey` is unique: enqueueing the same key twice keeps one job (for example `turn.close:<matchId>:<turn>`).
- Job types and payloads:
  - `system.ping` `{ "sentAt": string }` sent by `api` at startup; `jobs` answers with the `system.pong` notification
  - `geo.process` `{ "uploadId": string }` (M3)
  - `match.start` `{ "matchId": string }` scheduled at `Match.startAt` (M5)
  - `turn.close` `{ "matchId": string, "turn": number }` scheduled at `Match.turnEndsAt` (M6)
- Every job must be idempotent: `turn.close` for a turn that is not the match's `currentTurn` is a no-op; all its effects happen in one transaction that also advances `currentTurn`.

### Kafka (battle resolution)

- Battles are resolved **only in `jobs`**, so the formula exists in one language. `api` validates and records the declaration and the defender's response in the database, then asks for the resolution on Kafka.
- Topic `battle.resolve` (`KAFKA_BATTLE_TOPIC`), created by the `kafka-init` service of compose with `KAFKA_BATTLE_PARTITIONS` partitions (default 6); topic auto-creation is disabled.
- Message: key = `matchId`, value = `{ "battleId": string, "matchId": string }`. Ids only: `jobs` reads the battle and `Battle.response` from the database.
- The key keeps the battles of one match in order on one partition; `jobs` processes partitions in parallel, so the number of partitions is the number of battles resolved at the same time.
- Delivery is at-least-once (idempotent producer with `acks=all`; offsets committed after processing). Resolution must be idempotent: it locks the battle row and does nothing unless `status = 'OPEN'`.
- A message that fails 5 times is skipped and logged. Nothing is lost: `turn.close` resolves every battle still open, honouring a recorded `response` and treating a missing one as `DEFEND`. The same safety net covers a message that never reached Kafka after the database commit.
- Until M7 the consumer only logs the request: no battle can exist yet.

### Notifications back to the api

- After committing, `jobs` runs `SELECT pg_notify('game_events', json)` with `{ "matchId": string|null, "kind": string }` (`kind`: `system.pong`, `geo.progress`, `match.started`, `turn.closed`, `battle.resolved`, `match.finished`). `api` LISTENs on `game_events` (`src/queue/notifications.ts`) and fans out over WebSocket.
- Notifications sent while the api is disconnected are lost: they are hints to re-read state, never the state itself.

## Health

- `GET /api/health` → `{status:"ok"}`: the process is up (used by the compose healthcheck).
- `GET /api/health/ready` → `{status, database, jobs:{lastPongAt}, battleQueue}`; 503 when the database does not answer. `jobs.lastPongAt` is the time of the last reply to a ping, `battleQueue` whether the Kafka producer is connected.

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
  "startResources": 200,
  "hiddenMin": 10, "hiddenMax": 100, "hiddenMean": 55, "hiddenSd": 17,
  "incomeBase": 50, "incomePerUnit": 10,
  "annexCost": 50, "annexPerTurn": 1,
  "attackPct": 50, "attackStepPct": 10, "attackMaxPct": 100,
  "defensePct": 50, "surrenderRefundPct": 50,
  "capitalMoveEveryTurns": 3,
  "accumAlertPct": 50, "accumAlertMinTerritories": 3,
  "mergeCostTurns": 0.5, "mergeMaxUnits": 5,
  "secondCapitalCostTurns": 20,
  "blockCost": 300, "blockTurns": 5, "blockCooldownTurns": 5,
  "allianceMaxMembers": 3, "allianceLeaveNoticeTurns": 1,
  "boardMaxChars": 500
}
```

"Value of one turn" = `incomeBase + incomePerUnit * (number of GeoUnits the empire controls)`.

## Game mechanics, precisely

All amounts are integers; percentages round the cost up (`ceil`).

- **Join**: the player picks a free territory. It becomes the capital, owner set, `resources = hiddenStart + startResources`, protected for the current turn. Before the match is `RUNNING` the same call is allowed while `OPEN`.
- **Annex** (immediate): target free and adjacent to a territory of the empire; empire has not used its annexations this turn; `payFrom` is an own territory adjacent to the target, not in an open battle, with `resources >= annexCost`. Effects: pay; target owner = empire (its resources, previously hidden, stay on it); `protectedUntilTurn = currentTurn`.
- **Allocate** (immediate): body gives the new amount for some own territories not in an open battle; the sum must equal the current sum over those same territories. No unallocated resources are ever stored.
- **Attack** (immediate declaration): target owned by another active empire, not protected, no open battle on it, no active block; `from` = 1..n own territories adjacent to the target, each with `resources >= 1`, not in an open battle, without an active block. `pct = min(attackMaxPct, attackPct + attackStepPct * (n - 1))`; each source pays `ceil(resources * pct / 100)`; `attackForce` = sum of the sources' resources **before** paying. Sources and target get a `BattleLock` row and are locked (no allocation, no build, no merge, no other battle) while the battle is open.
- **Respond**: `api` records `Battle.response` and publishes the battle on Kafka; `jobs` resolves it at once. `DEFEND` pays `ceil(targetResources * defensePct / 100)` from the target, `defenseForce` = target resources **before** paying; outcome `attackForce * r1 > defenseForce * r2` → attacker wins (`r1`, `r2` uniform in [0,1) from a CSPRNG, stored on the battle; a tie goes to the defender). `SURRENDER`: attacker wins and each source gets back `floor(cost * surrenderRefundPct / 100)`.
- **Attacker wins**: target owner = attacker, target keeps whatever resources are left on it, `protectedUntilTurn = currentTurn`. If the target was the defender's capital: if the defender has a second capital it is promoted and the defender survives; otherwise the defender empire is `FALLEN` and all its other territories become free, keeping their resources.
- **Unanswered battle at turn close**: treated as `DEFEND`. A battle with a recorded response that is still open (its Kafka message was lost) is resolved with that response.
- **Turn close** (`jobs`, one transaction): resolve unanswered battles; credit each active empire `incomeBase + incomePerUnit * units`, split across its territories by `Territory.weight` (equal weights by default, remainder to the capital); reset `annexedThisTurn`; expire structures whose `expiresTurn <= currentTurn`; update accumulation alerts (a territory holding more than `accumAlertPct` of its empire's resources at two consecutive closes, only for empires with at least `accumAlertMinTerritories` territories); write `TurnSnapshot`; check end of match; advance `currentTurn`, set `turnEndsAt`, enqueue the next `turn.close`.
- **End of match**: when `maxDays` is reached the active empire with the most total resources wins (tie: more GeoUnits). Without `maxDays`, the last active empire wins.
- **Move capital**: to another own territory, at most once every `capitalMoveEveryTurns` turns, neither territory in an open battle.
- **Merge**: 2..`mergeMaxUnits` own territories, connected through match adjacency, none in an open battle; cost `ceil(mergeCostTurns * turnValue) * count` paid from the sum of their resources; result is one territory (keep the capital's row if included) holding the remaining resources and all units; adjacency is the union. Renaming an area is free.
- **Structures**: `BLOCK` costs `blockCost` from the territory, lasts `blockTurns`, then the same territory cannot get another for `blockCooldownTurns`; a blocked territory cannot be attacked and cannot attack. `SECOND_CAPITAL` costs `ceil(secondCapitalCostTurns * turnValue)` from the territory, one per empire, not on the capital.
- **Hidden starting resources**: drawn per territory when the match is created, server side, from a normal(`hiddenMean`, `hiddenSd`) truncated to [`hiddenMin`, `hiddenMax`].

## REST API

Base path `/api`. JSON bodies, zod-validated. Errors: `{ "error": { "code": string, "message": string } }` with 400/401/403/404/409/429. Auth is the session cookie.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /auth/register` `{username,email,password}` | none | create user (email not unique), start session |
| `POST /auth/login` `{username,password}` | none | start session |
| `POST /auth/logout` | user | revoke current session |
| `GET /auth/me` | user | `{id,username,role}` |
| `GET /stats/online` | none | `{online:number}` |
| `GET /admin/stats` | admin | `{users,matchesRunning,online}` |
| `GET /admin/sessions` / `DELETE /admin/sessions/:id` | admin | list and revoke sessions |
| `GET /admin/geo/areas` / `POST /admin/geo/areas` `{name,parentId?,kind}` / `DELETE /admin/geo/areas/:id` | admin | folder tree |
| `POST /admin/geo/areas/:id/uploads` (multipart `file`, `.kml`, `.json`, `.geojson`) | admin | store file, create `GeoUpload`, enqueue `geo.process` |
| `GET /admin/geo/uploads` / `GET /admin/geo/uploads/:id` | admin | status, progress, errors |
| `POST /admin/geo/adjacency` `{aId,bId}` / `DELETE` same body | admin | manual adjacency between GeoUnits |
| `GET /geo/areas` | user | tree with unit counts, for match creation |
| `GET /matches?name=&size=&page=` | none | paged list; `size` in `free`,`s`,`m`,`l` |
| `POST /matches` `{name,areaIds[],startAt,maxDays?,maxPlayers,turnHours,inviteCode?,config?}` | user | create (status `DRAFT`, then `OPEN` when the owner opens registrations), enqueue `match.start` |
| `GET /matches/:id` | none | public summary |
| `POST /matches/:id/join` `{geoUnitId,empire:{name,color,emblem,motto?},inviteCode?}` | user | create empire on a free territory |
| `GET /matches/:id/map` | none | GeoJSON FeatureCollection, one feature per GeoUnit: `properties {geoUnitId,name}`; simplified geometry |
| `GET /matches/:id/state` | optional | everything the viewer may see (below) |
| `POST /matches/:id/annex` `{territoryId,payFromId}` | player | |
| `POST /matches/:id/allocate` `{amounts:{[territoryId]:number}}` | player | |
| `POST /matches/:id/attacks` `{targetId,fromIds[]}` | player | |
| `POST /matches/:id/battles/:battleId/respond` `{action:"DEFEND"|"SURRENDER"}` | player | |
| `POST /matches/:id/capital` `{territoryId}` | player | move capital |
| `POST /matches/:id/merge` `{territoryIds[],name}` | player | |
| `PATCH /matches/:id/territories/:tid` `{name}` | player | rename own area |
| `POST /matches/:id/structures` `{type:string,territoryId}` (a key of the structure catalogue) | player | |
| `GET /matches/:id/board?type=&empireId=&before=` / `POST` `{text}` / `DELETE /matches/:id/board/:eventId` | read: any; write: player; delete: owner or admin | |
| `GET /matches/:id/history` | any | `[{turn, events:[...]}]` |
| `GET /matches/:id/history/:turn` | any | `{turn, ownership:{[geoUnitId]:empireId|null}}` |

`GET /matches/:id/state` response:

```ts
{
  match: { id, name, status, currentTurn, turnEndsAt, maxPlayers, turnHours, startAt, config },
  me: null | { empireId, annexLeft: number, turnValue: number },
  empires: [{ id, name, color, emblem, motto, username, status, capitalTerritoryId, secondCapitalTerritoryId, units: number }],
  territories: [{ id, name, ownerEmpireId, geoUnitIds: number[] | string[], adj: string[], isArea: boolean,
                  protected: boolean, alert: boolean, battleId: string | null, block: null | { turnsLeft: number },
                  resources: number | null /* null = hidden from this viewer */ }],
  battles: [{ id, targetId, attackerEmpireId, defenderEmpireId, status, outcome, turn,
              fromIds: string[] | null, cost: number | null /* only for the attacker */ }],
  online: { connected: number, total: number }
}
```

Never include another empire's resources, costs, forces or rolls. Events in board and history carry no amounts.

## WebSocket

`GET /ws` (cookie auth optional). Client → server: `{t:"sub",matchId}`, `{t:"unsub",matchId}`. Server → client:

- `{t:"online",n}` global count (also sent on connect)
- `{t:"match.online",matchId,connected,total}`
- `{t:"match.update",matchId,kinds:string[]}` the client refetches `/state`
- `{t:"board",matchId,event}`
- `{t:"battle.incoming",matchId,battleId}` only to the defender
- `{t:"session.revoked"}` then the socket closes

"Online" = distinct users with a valid session and at least one open socket; the public count also includes nothing else.

## Event types (`GameEvent.type`)

`EMPIRE_CREATED`, `ANNEXED`, `BATTLE_DECLARED` (not public until resolved), `BATTLE_RESOLVED` (`data.outcome`), `EMPIRE_FALLEN`, `CAPITAL_BUILT`, `CAPITAL_MOVED`, `CAPITAL_PROMOTED`, `AREA_CREATED`, `AREA_RENAMED`, `MESSAGE` (`data.text`), `MATCH_STARTED`, `MATCH_FINISHED`. `data` holds ids and names only, never amounts.
