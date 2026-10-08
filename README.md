# Gioco di conquista dei comuni

Cartella radice del progetto: contiene i tre repository dei servizi, il `docker-compose.yml` e la documentazione condivisa.

| Cartella | Contenuto |
|---|---|
| `api/` | Node.js + TypeScript, Fastify, Prisma. Possiede lo schema del database. |
| `jobs/` | Go. Lavori in background: dati geografici, turni, risoluzione delle battaglie. |
| `web/` | React + TypeScript, Vite, Tailwind v4, shadcn/ui. |
| `db/init/` | Script eseguito alla prima creazione del database. |
| `docs/ARCHITECTURE.md` | Contratto tecnico tra i servizi. |
| `docs/SPEC.md` | Regole di gioco effettivamente implementate. |

Regole di progetto e attività sono nella cartella superiore: `PROMPT.md` e `BACKLOG.md`.

## Avvio

Serve solo Docker.

```sh
cp .env.example .env      # poi imposta ADMIN_PASSWORD (almeno 12 caratteri)
docker compose up --build
```

- Gioco: <http://localhost:8080>
- API: <http://localhost:3000/api/health/ready>
- PostgreSQL: `localhost:5433` (utente, password e database `gioco`)
- Kafka: `localhost:29092`

All'avvio `api` applica le migrazioni e crea l'admin di piattaforma; `jobs` parte quando `api` è pronta. La homepage mostra lo stato dei servizi.

Per ripartire da zero, cancellando database e code: `docker compose down -v`.

## Sviluppo

Avvia solo i servizi di supporto e lancia i tre progetti sulla tua macchina:

```sh
docker compose up -d db kafka kafka-init
```

| Progetto | Preparazione | Avvio | Verifiche |
|---|---|---|---|
| `api` | `cp .env.example .env && pnpm install && pnpm db:deploy && pnpm seed` | `pnpm dev` | `pnpm lint && pnpm typecheck && pnpm test` |
| `jobs` | `cp .env.example .env`, con lo stesso `UPLOAD_DIR` di `api` (percorso assoluto) | `set -a; . ./.env; set +a; go run ./cmd/jobs` | `go vet ./... && go test ./...` |
| `web` | `pnpm install` | `pnpm dev` (<http://localhost:5173>) | `pnpm lint && pnpm typecheck && pnpm test` |

Gli script di `api` leggono da soli il file `.env`; `jobs` legge solo le variabili d'ambiente, per questo vanno esportate prima di lanciarlo.

### Test di integrazione

I test che usano database e Kafka si attivano con `TEST_DATABASE_URL` e `TEST_KAFKA_BROKERS` (vedi i `.env.example`); senza queste variabili vengono saltati. Il database `gioco_test` viene creato da `db/init/`, e va migrato una volta:

```sh
cd api && DATABASE_URL=postgresql://gioco:gioco@localhost:5433/gioco_test pnpm db:deploy
```

### Test con l'Italia intera

Il test di `jobs` su tutti i comuni italiani si attiva indicando un GeoJSON con i loro confini, per esempio quello di [openpolis/geojson-italy](https://github.com/openpolis/geojson-italy) (`geojson/limits_IT_municipalities.geojson`):

```sh
cd jobs && GEO_ITALY_FILE=/percorso/comuni.geojson TEST_DATABASE_URL=postgresql://gioco:gioco@localhost:5433/gioco_test go test -run TestRealBoundariesOfItaly ./internal/geoprocess
```

Lo stesso file si può caricare dalla dashboard admin (<http://localhost:8080/admin>, scheda "Dati geografici") dopo aver creato l'area "Italia".

### Modifiche allo schema

Lo schema si cambia solo in `api/prisma/schema.prisma`, poi `pnpm db:migrate`. I vincoli che Prisma non sa esprimere (CHECK, indici parziali) si aggiungono a mano nel file SQL della migrazione. `jobs` non modifica mai lo schema.

Quando `api` aggiunge una chiave alla configurazione di partita, va aggiunto il campo in `jobs/internal/rules/config.go` e rigenerato il file di prova:

```sh
cd api && pnpm exec tsx -e 'import {DEFAULT_MATCH_RULES} from "./src/rules/config.ts"; console.log(JSON.stringify(DEFAULT_MATCH_RULES,null,2))' > ../jobs/internal/rules/testdata/default-config.json
```
