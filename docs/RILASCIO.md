# Guida al rilascio

Come mettere il gioco in produzione su un server e come aggiornarlo. Vale per un server solo, con Docker: è la forma in cui il gioco è stato costruito e provato (vedi "Limiti" in fondo).

## Cosa serve

- Un server Linux con Docker e Docker Compose (versione 2.24 o successiva), raggiungibile da internet sulle porte **80** e **443**.
- Un **nome di dominio** che punta al server, già attivo prima del primo avvio: il certificato HTTPS viene chiesto per quel nome.
- Per 100 giocatori sull'Italia intera: almeno 4 processori, 8 GB di memoria e 20 GB di disco. La prova di carico (`docs/LOAD.md`) è stata fatta con 8 processori e 8 GB condivisi con altro.
- I quattro repository: questo, e dentro di esso `api`, `jobs` e `web`.

## Primo avvio

```sh
git clone <repository radice> looters && cd looters
git clone <repository api> api
git clone <repository jobs> jobs
git clone <repository web> web

cp .env.prod.example .env
# compilare .env: DOMAIN, POSTGRES_PASSWORD, ADMIN_PASSWORD, ADMIN_EMAIL

./scripts/deploy.sh --no-backup
```

Lo script costruisce le immagini, avvia tutto e aspetta che l'api risponda. Alla fine il gioco è su `https://<DOMAIN>`. Poi:

1. entrare come admin (`ADMIN_USERNAME` e `ADMIN_PASSWORD` di `.env`);
2. dalla dashboard admin caricare i confini dei comuni e aspettare la fine dell'elaborazione;
3. creare la prima partita.

`.env` contiene le password: resta sul server, non va nel repository (è già ignorato da git) e conviene che sia leggibile solo da chi amministra (`chmod 600 .env`).

## Aggiornare

```sh
git pull && git -C api pull && git -C jobs pull && git -C web pull
./scripts/deploy.sh
```

`deploy.sh` fa, in ordine: un **backup**, la costruzione delle immagini, il riavvio dei soli container cambiati, il controllo che l'api sia pronta. Le modifiche allo schema del database sono applicate dall'api all'avvio, da sola.

Durante il riavvio il gioco non risponde per qualche decina di secondi. Le partite non ne risentono: i turni scaduti nel frattempo vengono chiusi appena `jobs` riparte, e uno scontro la cui richiesta va persa viene risolto alla chiusura del turno. I giocatori restano collegati (le sessioni sono nel database) e la pagina si riconnette da sola. Conviene comunque aggiornare lontano dalla fine di un turno.

## Tornare indietro

Se una versione nuova non va:

```sh
git -C api checkout <versione precedente>      # lo stesso per jobs e web, se serve
./scripts/deploy.sh
```

Questo basta se la versione nuova **non ha cambiato lo schema** del database. Se lo ha cambiato, la versione vecchia non sa leggerlo: si torna indietro anche con i dati, ripristinando il backup che `deploy.sh` ha fatto prima di aggiornare (`./scripts/restore.sh <file>`, vedi il README). Le mosse fatte dopo quel backup vanno perse: per questo, prima di un aggiornamento che cambia lo schema, conviene avvisare i giocatori.

## Cosa cambia rispetto allo sviluppo

`docker-compose.prod.yml` si aggiunge a `docker-compose.yml`:

| | Sviluppo | Produzione |
| --- | --- | --- |
| Accesso da fuori | `http://localhost:8080`; database, Kafka e api raggiungibili dalla macchina | Solo HTTPS (80 reindirizza a 443) tramite il proxy Caddy; nient'altro è esposto |
| Certificato | nessuno | ottenuto e rinnovato da solo per `DOMAIN` (Let's Encrypt) |
| Password | valori di prova | da `.env`, senza valori predefiniti: senza, lo stack non parte |
| Cookie di sessione | anche su HTTP | solo su HTTPS (`Secure`) |
| Riavvio | manuale | automatico dopo un errore o un riavvio del server |
| Log | senza limite | al massimo 5 file da 20 MB per container |
| Memoria | senza limite | un tetto per container (`API_MEMORY`, `JOBS_MEMORY`, `DB_MEMORY`) |
| Backup | a richiesta | uno ogni 24 ore in `./backups`, tenendo gli ultimi 14 |

In entrambi i casi: l'api gira come utente non privilegiato, il sito invia gli header di sicurezza (Content-Security-Policy, niente inclusione in altre pagine, niente rilevamento del tipo), e l'indirizzo di chi si collega, usato per limitare i tentativi di accesso, è quello visto dal proxy e non uno dichiarato dal browser.

## Controllare che vada

```sh
alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'
dc ps                                   # tutti "Up", api e db "healthy"
curl -s https://<DOMAIN>/api/health/ready
dc logs -f api jobs                     # log in JSON, una riga per evento
```

`/api/health/ready` risponde `200` con `database: true` quando il gioco funziona; riporta anche l'ultima risposta di `jobs` e se la coda degli scontri è collegata. È l'indirizzo da dare a un servizio di monitoraggio esterno.

Nei log le righe da tenere d'occhio hanno un campo `event` (`docs/ARCHITECTURE.md`, "Logs and error tracking"): `unhandled_error` e `process_crash` nell'api, `job failed` in `jobs`. Se un giocatore segnala un errore con un codice, quel codice è il `reqId` della riga.

## Operazioni

| Cosa | Come |
| --- | --- |
| Backup adesso, verifica, ripristino | `./scripts/backup.sh`, `./scripts/restore.sh --verify latest`, `./scripts/restore.sh <file>` (README, "Backup e ripristino") |
| Portare i backup fuori dal server | copiare `./backups` altrove con lo strumento che si usa già (rsync, uno storage a oggetti): **non è automatico** |
| Cambiare la password dell'admin | cambiarla in `.env`, poi `dc up -d api` |
| Cambiare la password del database | `dc exec db psql -U looters -c "ALTER USER looters PASSWORD '<nuova>'"`, poi la stessa in `.env` e `dc up -d` (quella di `.env` da sola vale solo alla creazione del volume) |
| Più scontri risolti in parallelo | aumentare `KAFKA_BATTLE_PARTITIONS` in `.env`, poi `dc up -d` (si può solo aumentare) |
| Fermare tutto senza perdere dati | `dc down` (i dati stanno nei volumi; `dc down -v` li **cancella**) |
| Provare la configurazione su una macchina | `DOMAIN=localhost` in `.env`: il certificato è firmato da Caddy stesso e il browser avvisa |

## Limiti

- **Un solo server e una sola istanza dell'api.** Gli aggiornamenti in tempo reale, lo stato condiviso delle partite e le tile della mappa stanno nella memoria di quel processo. Più istanze richiedono prima un canale comune per i cambiamenti (`docs/ARCHITECTURE.md`, "Performance under load").
- **I backup stanno sullo stesso disco** finché non li si copia altrove, e non sono cifrati.
- **Nessun monitoraggio né raccolta dei log è compreso**: i log restano sul server, ruotati.
- **La mappa di base** viene dai server pubblici di OpenStreetMap, che ne ammettono un uso leggero: con molti giocatori va sostituita con un fornitore di tile (un indirizzo in `web/src/features/map/style.ts`, da aggiungere anche in `web/security-headers.conf`).
- Database, Kafka e file caricati non sono replicati: un guasto del server ferma il gioco fino al ripristino.
