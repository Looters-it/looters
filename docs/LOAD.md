# Load test

What happens with a full match: 100 players on the whole of Italy (7,896 municipalities), all connected and all playing at once. The script is `api/scripts/load-test.ts`; this page says how to run it, what it measured and what was changed because of it.

## Running it

The stack must be up (`docker compose up -d`) with the municipalities loaded.

```sh
cd api
pnpm load                                   # 100 players, 3 minutes, turns of 45 seconds
LOAD_PLAYERS=20 LOAD_DURATION_SEC=60 pnpm load
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOAD_BASE_URL` | `http://localhost:8080` | The stack under test, through the web proxy like a browser |
| `LOAD_PLAYERS` | `100` | Players, each with its own session and WebSocket |
| `LOAD_DURATION_SEC` | `180` | How long they play once the match has started |
| `LOAD_TURN_SEC` | `45` | Length of a turn (at least 36 seconds) |
| `LOAD_THINK_MS` | `1000` | Average pause of a player between two actions |
| `LOAD_P95_LIMIT_MS` | `1000` | The run fails if the 95th percentile of a route played during the match is above this |
| `LOAD_TURN_LAG_LIMIT_MS` | `5000` | The run fails if a turn closes later than this after its deadline |
| `LOAD_KEEP` | unset | Set to keep the match and the `load_*` users afterwards; otherwise they are deleted |

It reads `DATABASE_URL` from `api/.env`, because the players are created straight in the database with a session each: registering a hundred users from one address is what the rate limits exist to stop. Everything else goes through the public HTTP and WebSocket interface. It exits with a non-zero status when the run fails, so it can be used as a gate.

## What a simulated player does

1. All players register for the match at the same instant, open a WebSocket and load the map (the list of municipalities and three low-zoom tiles): the rush when a match opens.
2. Once the match runs, each player loops with a pause of about a second: read the state, answer an incoming attack if there is one, otherwise open the card of an own municipality and annex a free neighbour, attack an enemy neighbour, move resources between two own territories, or read the board.
3. Like the real interface, each player reads the state again whenever the server says the match changed.

Starting points are chosen in pairs two steps apart, so empires touch after one annexation and battles start within the first turns. Refusals the game is expected to give (`4xx`: no annexations left, a turn that closed meanwhile) are counted apart from errors.

## Result

Docker Desktop on an Apple M3 laptop (8 CPUs and 8 GB given to Docker), load generator on the same machine and other programs running: an unfavourable setting, not a production figure.

| | Before | After |
| --- | --- | --- |
| Requests served in 3 minutes | 12,529 (69/s) | 57,436 (316/s) |
| Read the state, median / 95th percentile | 1,238 ms / 3,262 ms | 31 ms / 222 ms |
| Read the state after a push, median / 95th | not simulated yet | 106 ms / 328 ms |
| Card of a municipality | 519 ms / 1,562 ms | 16 ms / 127 ms |
| Move resources | 915 ms / 3,099 ms | 51 ms / 274 ms |
| Annex | 1,226 ms / 4,004 ms | 42 ms / 243 ms |
| Attack | 1,541 ms / 3,782 ms | 129 ms / 392 ms |
| Answer an attack | 1,623 ms / 3,622 ms | 105 ms / 358 ms |
| Registering, 100 at once | 1,517 ms / 1,554 ms | 821 ms / 846 ms |
| List of municipalities, 100 at once | 1,748 ms / 2,185 ms | 675 ms / 967 ms |
| WebSocket messages pushed | 306,711 | 28,647 |
| Turn closes, delay after the deadline | 0.6–1.3 s | 0.3–0.8 s |
| Server errors | 0 | 0 |

In both runs every socket stayed connected, no request failed and every turn closed on time: the game was correct under load from the start, and slow. In the final run 275 battles were resolved and 55 empires fell in five turns.

"Before" understates the problem: in that run the players did not yet read the state again at every push, as the real interface does. With that behaviour and no other change, the median state read was 677 ms even running the api outside Docker.

## What was slow, and what changed

1. **Every change made every player read the whole state.** Each action pushed `match.update` to the 100 followers, and each of them answered by reading the state: one action cost a hundred state reads, and thirty actions a second cost three thousand. Now the hub tells the followers of a match at most once per `MATCH_UPDATE_WINDOW_MS` (1 second): the first change at once, the following ones together when the window ends. The player who acts is not affected, because the answer to the action already carries the new state; an incoming attack has its own message and is not delayed.
2. **A hundred identical readings at the same moment.** The state of a match was read from the database (seven queries) for each viewer. Now what is read is the same for everyone and kept for `MATCH_STATE_CACHE_MS` (1 second); what each viewer may see of it — own and allied resources, own battles and proposals — is decided in memory. Every change made through the api, and every notification from `jobs`, discards it at once, so nobody reads a state older than their own action.
3. **The same tile generated a hundred times.** Players entering together asked for the same tiles while none was cached yet, and each request generated its own. Now the first request generates a tile and the others wait for it. The list of municipalities of a match is kept the same way.
4. **Prisma's query engine on Alpine.** In the container the api used five processors to serve what it served outside Docker with one. The engine is much slower on musl when many requests run at once; the image is now Debian (`node:22-bookworm-slim`). This alone took the median state read from 384 ms to 23 ms.
5. **Connection pool.** Every game action is a transaction that holds a database connection for its whole length. `DATABASE_POOL_SIZE` now sets the pool; the default (twice the processors plus one) was enough for this run once the rest was fixed.

## Limits of this test, and what it leaves open

- One api process. The WebSocket hub, the shared state reading and the tile cache live in its memory: running several api instances needs those moved out of the process first (see `docs/ARCHITECTURE.md`).
- With the window, a player sees what others do up to one second late.
- Players are simulated with fixed pauses; real ones are slower and less regular. No browser is involved: rendering the map with 100 empires is not measured here.
- It was not run on a production-sized machine or over a real network, and not for hours: memory growth over a long match is not covered.

## Duels across many matches

A second script, `api/scripts/duel-load.ts`, measures something else: many matches at the same time, each with two players who only fight. One attacks, the other defends, the battle goes through the queue to `jobs` and comes back resolved; then again, as fast as the stack answers.

```sh
cd api
pnpm load:duels                                  # 50 matches, 60 seconds of fighting
DUEL_MATCHES=100 DUEL_DURATION_SEC=45 pnpm load:duels
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUEL_BASE_URL` | `http://localhost:8080` | The stack under test |
| `DUEL_MATCHES` | `50` | Matches fighting at the same time, two players each |
| `DUEL_DURATION_SEC` | `60` | How long they fight once every match is open |
| `DUEL_POLL_MS` | `100` | How often the attacker reads the state while waiting for a result |
| `DUEL_P95_LIMIT_MS` | `1000` | The run fails if the 95th percentile of a route used while fighting is above this |
| `DUEL_RESOLVE_P95_LIMIT_MS` | `3000` | The run fails if the 95th percentile of the time to resolve a battle is above this |
| `DUEL_RESOLVE_TIMEOUT_MS` | `20000` | A battle not resolved after this long is an error |
| `DUEL_OPEN_TIMEOUT_SEC` | `300` | How long the matches may take to open and start |
| `DUEL_KEEP` | unset | Set to keep the matches and the `duel_*` users afterwards |

The matches are opened first and fight afterwards, so the two are measured apart. The script writes to the database for three things only: the players and their sessions, the protection of the capitals (removed, so the fight starts at turn 1), and the resources of the two capitals, set again every 12 duels. The attacker is given far less than the defender, so it nearly always loses and the same match goes on; when it wins against the odds, the pair opens another match. Turns are two hours long: this run is about battles, not about the closing of turns.

It reports the time of every call by route, the duels resolved each second, and the time of a battle from the answer of the defender to its result as the attacker sees it (read every `DUEL_POLL_MS`, so it is rounded up to that).

### Result

Same machine and setting as above, every match on the whole of Italy, 45 seconds of fighting.

| Matches | Duels per second | Attack, median / 95th | Answer, median / 95th | Battle resolved, median / 95th | Opening all the matches | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 47 | 72 ms / 154 ms | 59 ms / 133 ms | 45 ms / 115 ms | 7 s | 0 |
| 50 | 59 | 258 ms / 590 ms | 241 ms / 530 ms | 174 ms / 418 ms | 30 s | 0 |
| 100 | 75 | 394 ms / 778 ms | 368 ms / 812 ms | 340 ms / 690 ms | 62 s | 0 |

Every battle was resolved and nothing failed. With ten times the matches the duels closed each second grow by about a half while every call takes five times as long: with players that never pause the stack is at its limit already with ten matches, and more matches share the same throughput. Real players declare a few attacks a turn, not five a second.

### What it found

Creating many matches at the same instant failed: each creation writes one territory per municipality in a single transaction (about a second for Italy), and from the tenth or so the others gave up waiting for a database connection after two seconds, with a `500`. Creations now go through two at a time and the others wait their turn, so fifty matches asked together are all created, the last after about half a minute, and the connections are left to the matches being played.
