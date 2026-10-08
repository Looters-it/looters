import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8080'
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://looters:looters@localhost:5433/looters'
const STATE_FILE = fileURLToPath(new URL('../.state.json', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../fixtures/milano-comuni.geojson', import.meta.url))

/** Everything of the tests carries this, so that it can be found and removed. */
export const PREFIX = 'e2e_'
const AREA_NAME = 'E2E Milano'

/** What the setup prepared and the tests use. */
export interface World {
  matchId: string
  matchName: string
  /** Session tokens: a test becomes a player by setting the cookie. */
  anna: { token: string; empire: string; capital: string }
  bruno: { token: string; empire: string; capital: string }
  /** Free municipalities next to Anna's capital: one for each screen size, which share the match. */
  freeNeighbours: string[]
}

export const readWorld = (): World => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as World

const id = () => `e2e${randomBytes(10).toString('hex')}`
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

async function api<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: {
      ...(token ? { cookie: `sid=${token}` } : {}),
      ...(body instanceof FormData || body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${String(response.status)} ${await response.text()}`)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

/** A user that exists only for the tests, with a session: no password, no registration. */
async function userWithSession(db: pg.Client, username: string, role = 'USER') {
  const token = randomBytes(32).toString('base64url')
  const user = await db.query<{ id: string }>(
    `INSERT INTO "User" (id, username, email, "passwordHash", role, "createdAt")
     VALUES ($1, $2, $3, '!', $4::"Role", now() AT TIME ZONE 'UTC') RETURNING id`,
    [id(), username, `${username}@example.test`, role],
  )
  await db.query(
    `INSERT INTO "Session" (id, "userId", "tokenHash", "createdAt", "lastSeenAt", "expiresAt")
     VALUES ($1, $2, $3, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC',
       (now() AT TIME ZONE 'UTC') + interval '1 day')`,
    [id(), user.rows[0]?.id, sha256(token)],
  )
  return token
}

export async function removeWorld(db?: pg.Client): Promise<void> {
  const client = db ?? new pg.Client({ connectionString: DATABASE_URL })
  if (!db) await client.connect()
  await client.query(
    `DELETE FROM "Match" WHERE "ownerId" IN (SELECT id FROM "User" WHERE username LIKE $1)`,
    [`${PREFIX}%`],
  )
  await client.query(`DELETE FROM "User" WHERE username LIKE $1`, [`${PREFIX}%`])
  if (!db) await client.end()
}

/**
 * The municipalities the tests play on: the province of Milan, loaded once
 * through the admin's own upload and kept between runs.
 */
async function ensureArea(db: pg.Client): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT a.id FROM "GeoArea" a
     WHERE a.name = $1 AND EXISTS (SELECT 1 FROM "GeoUnit" u WHERE u."areaId" = a.id)`,
    [AREA_NAME],
  )
  if (existing.rows[0]) return existing.rows[0].id

  await db.query(`DELETE FROM "GeoArea" WHERE name = $1`, [AREA_NAME])
  const admin = await userWithSession(db, `${PREFIX}admin`, 'ADMIN')
  const area = await api<{ id: string }>(admin, 'POST', '/admin/geo/areas', { name: AREA_NAME })
  const form = new FormData()
  form.append('file', new Blob([readFileSync(FIXTURE)]), 'milano-comuni.geojson')
  const upload = await api<{ id: string }>(admin, 'POST', `/admin/geo/areas/${area.id}/uploads`, form)
  // `jobs` reads the file and finds the borders.
  for (let waited = 0; ; waited += 1000) {
    const { status } = await api<{ status: string }>(admin, 'GET', `/admin/geo/uploads/${upload.id}`)
    if (status === 'DONE') return area.id
    if (status === 'FAILED' || waited > 120_000) {
      throw new Error(`the municipalities were not loaded (upload ${status}): is jobs running?`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** A running match with two players, in a known position. */
export async function createWorld(): Promise<World> {
  const db = new pg.Client({ connectionString: DATABASE_URL })
  await db.connect()
  try {
    await removeWorld(db)
    const areaId = await ensureArea(db)
    const anna = await userWithSession(db, `${PREFIX}anna`)
    const bruno = await userWithSession(db, `${PREFIX}bruno`)

    // Anna in Milano; a free neighbour of hers; Bruno two steps further, not touching.
    const places = await db.query<{ start: number; startName: string; free: string; other: number; otherName: string }>(
      `WITH edges AS (
         SELECT "aId" AS x, "bId" AS y FROM "GeoAdjacency" UNION ALL SELECT "bId", "aId" FROM "GeoAdjacency"
       ), milano AS (SELECT id, name FROM "GeoUnit" WHERE "areaId" = $1 AND name = 'Milano')
       SELECT m.id AS start, m.name AS "startName", n.name AS free, o.id AS other, o.name AS "otherName"
       FROM milano m
       JOIN edges e1 ON e1.x = m.id JOIN "GeoUnit" n ON n.id = e1.y
       JOIN edges e2 ON e2.x = n.id JOIN "GeoUnit" o ON o.id = e2.y AND o.id <> m.id
       WHERE NOT EXISTS (SELECT 1 FROM edges d WHERE d.x = m.id AND d.y = o.id)
       ORDER BY n.name, o.name LIMIT 1`,
      [areaId],
    )
    const neighbours = await db.query<{ name: string }>(
      `SELECT n.name FROM "GeoUnit" m
       JOIN "GeoAdjacency" a ON m.id IN (a."aId", a."bId")
       JOIN "GeoUnit" n ON n.id IN (a."aId", a."bId") AND n.id <> m.id
       WHERE m."areaId" = $1 AND m.name = 'Milano' AND n.id <> $2
       ORDER BY n.name`,
      [areaId, places.rows[0]?.other ?? 0],
    )
    const place = places.rows[0]
    if (!place) throw new Error('the fixture has no Milano with neighbours')

    const matchName = 'Partita di prova e2e'
    const match = await api<{ id: string }>(anna, 'POST', '/matches', {
      name: matchName,
      areaIds: [areaId],
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
      turnHours: 24,
      // Each screen size annexes once, in the same turn of the same match.
      config: { annexPerTurn: 5 },
    })
    await api(anna, 'POST', `/matches/${match.id}/open`)
    const options = await api<{ colors: string[] }>(null, 'GET', '/matches/options')
    const join = (token: string, geoUnitId: number, name: string, color: string | undefined, emblem: string) =>
      api(token, 'POST', `/matches/${match.id}/join`, {
        geoUnitId,
        empire: { name, color, emblem, motto: null },
      })
    await join(anna, place.start, 'Ducato di Anna', options.colors[0], 'torre')
    await join(bruno, place.other, 'Repubblica di Bruno', options.colors[9], 'luna')

    // Started by hand, with a turn that will not end while the tests run and nothing
    // left to chance: known resources, no protection.
    await db.query(
      `UPDATE "Territory" SET resources = 500, "protectedUntilTurn" = NULL
       WHERE "matchId" = $1 AND "ownerEmpireId" IS NOT NULL`,
      [match.id],
    )
    await db.query(
      `UPDATE "Match" SET status = 'RUNNING', "currentTurn" = 1,
         "turnEndsAt" = (now() AT TIME ZONE 'UTC') + interval '6 hours' WHERE id = $1`,
      [match.id],
    )

    const world: World = {
      matchId: match.id,
      matchName,
      anna: { token: anna, empire: 'Ducato di Anna', capital: place.startName },
      bruno: { token: bruno, empire: 'Repubblica di Bruno', capital: place.otherName },
      freeNeighbours: neighbours.rows.map((row) => row.name),
    }
    writeFileSync(STATE_FILE, JSON.stringify(world, null, 2))
    return world
  } finally {
    await db.end()
  }
}
