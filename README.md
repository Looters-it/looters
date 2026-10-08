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

Quando `api` aggiunge una chiave alla configurazione di partita, va aggiunto il campo in `jobs/internal/rules/config.go`.

`jobs` tiene due copie di cose che appartengono ad `api`: lo schema del database su cui girano i suoi test (`jobs/testdata/schema.sql`, la somma delle migrazioni) e la configurazione predefinita di una partita (`jobs/internal/rules/testdata/default-config.json`). Dopo una nuova migrazione o una modifica alle regole si rigenerano insieme, e con `--check` si verifica che siano aggiornate:

```sh
./scripts/sync-jobs-fixtures.sh          # rigenera
./scripts/sync-jobs-fixtures.sh --check  # fallisce se una copia è rimasta indietro
```

## Produzione

Mettere il gioco su un server e aggiornarlo: [`docs/RILASCIO.md`](docs/RILASCIO.md). In breve, `cp .env.prod.example .env`, compilarlo, e `./scripts/deploy.sh`.

## Prova di carico

`cd api && pnpm load` simula 100 giocatori sull'Italia intera contro lo stack avviato e fallisce se il gioco rallenta oltre le soglie o se un turno chiude in ritardo. Come funziona, le variabili e i risultati sono in [`docs/LOAD.md`](docs/LOAD.md).

## Backup e ripristino

Un backup è una coppia di file in `./backups` con lo stesso orario (UTC): `gioco-<data>-<ora>.dump` (il database, formato `pg_dump -Fc`) e `gioco-<data>-<ora>.uploads.tgz` (i file geografici caricati dall'admin). Insieme bastano a ricostruire tutto: Kafka non va salvato, perché uno scontro la cui richiesta va persa viene comunque risolto alla chiusura del turno.

| Cosa | Comando |
| --- | --- |
| Un backup adesso | `./scripts/backup.sh` |
| Backup periodici | `docker compose --profile backup up -d backup` (ogni `BACKUP_INTERVAL_HOURS`, 24 se non indicato; restano gli ultimi `BACKUP_KEEP`, 14) |
| Controllare che un backup si ripristini, senza toccare nulla | `./scripts/restore.sh --verify latest` |
| Ripristinare | `./scripts/restore.sh latest` oppure `./scripts/restore.sh gioco-<data>-<ora>.dump` |

**Cosa fa il ripristino.** Chiede conferma, ferma `api` e `jobs`, ricostruisce il backup in un database nuovo e solo se riesce lo mette al posto di quello in uso; poi rimette i file caricati e riavvia i servizi. Il database di prima **non viene cancellato**: resta come `gioco_before_restore_<data>`, e si elimina a mano quando si è sicuri:

```sh
docker compose exec db psql -U gioco -d postgres -c 'DROP DATABASE "gioco_before_restore_<data>"'
```

**Dopo un ripristino** il gioco riparte dallo stato del backup: le mosse fatte dopo sono perse, le sessioni dei giocatori restano valide e i turni scaduti nel frattempo vengono chiusi da `jobs` appena riparte.

**Da ricordare.** `./backups` sta sulla stessa macchina del database: va copiata altrove (un altro server, uno storage a oggetti) con lo strumento che si preferisce, altrimenti non protegge dalla perdita del disco. Conviene lanciare `--verify` ogni tanto: un backup mai provato non è un backup. Su una macchina nuova: `docker compose up -d db`, copiare i due file in `./backups`, poi `./scripts/restore.sh <file>`.

### Integrazione continua

Ogni repository ha il suo `.github/workflows/ci.yml` (GitHub Actions), che parte a ogni push su `main` e a ogni pull request:

| Repository | Cosa controlla |
| --- | --- |
| `api` | formattazione, lint, tipi, test (con PostGIS e Kafka veri, migrati da zero), build |
| `jobs` | `gofmt`, `go vet`, test (con PostGIS e Kafka veri, schema da `testdata/schema.sql`), build |
| `web` | formattazione, lint, tipi, test, build |

In CI i test di integrazione non vengono saltati: le variabili `TEST_DATABASE_URL` e `TEST_KAFKA_BROKERS` sono sempre impostate. Il controllo `--check` delle copie di `jobs` non può girare in CI, perché i repository sono separati: va lanciato a mano prima di un commit che tocca migrazioni o regole.
