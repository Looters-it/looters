# Regole implementate

Questo file descrive **solo ciò che il codice fa oggi**. Le regole di progetto, comprese quelle non ancora sviluppate, sono in `../../PROMPT.md`; il contratto tecnico tra i servizi è in `ARCHITECTURE.md`. Va aggiornato alla chiusura di ogni milestone.

Stato: **milestone 1 (Fondamenta) completata.** Nessuna azione di gioco è ancora disponibile.

## Cosa esiste

### Admin di piattaforma

- L'admin viene creato solo dal seed di `api`, con le credenziali lette da `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`. Non esiste alcuna rotta che lo crei.
- Il seed gira a ogni avvio di `api`: se l'admin esiste già, email e password vengono riallineate alle variabili d'ambiente.
- Se lo username scelto appartiene già a un utente normale, il seed fallisce e non promuove nessuno.
- La password dell'admin deve avere almeno 12 caratteri ed è salvata con hash argon2id.

### Utenti (solo modello dati)

- Lo username è univoco; l'email non lo è: più utenti possono condividerla.
- Registrazione, login e sessioni arrivano con la milestone 2.

### Configurazione delle regole di partita

Ogni valore numerico di gioco è una chiave della configurazione di partita (`api/src/rules/config.ts`). Alla creazione di una partita la configurazione viene salvata per intero in `Match.config`: cambiare un default non modifica le partite esistenti. Le chiavi sconosciute e i valori incoerenti vengono rifiutati.

| Chiave | Default | Regola (PROMPT) |
|---|---|---|
| `startResources` | 200 | risorse iniziali di ogni giocatore (§2.4) |
| `hiddenMin`, `hiddenMax` | 10, 100 | limiti della dotazione nascosta dei comuni (§2.4) |
| `hiddenMean`, `hiddenSd` | 55, 17 | forma della distribuzione della dotazione (§2.4) |
| `incomeBase`, `incomePerUnit` | 50, 10 | guadagno per turno: base più quota per comune (§2.3) |
| `annexCost`, `annexPerTurn` | 50, 1 | costo e limite delle annessioni (§2.3) |
| `attackPct`, `attackStepPct`, `attackMaxPct` | 50, 10, 100 | costo dell'attacco, incremento per territorio aggiuntivo, tetto (§2.5, §9 n. 1 e 4) |
| `defensePct` | 50 | costo della difesa (§2.5) |
| `surrenderRefundPct` | 50 | quota del costo d'attacco restituita in caso di resa (§2.5) |
| `capitalMoveEveryTurns` | 3 | intervallo tra due spostamenti della capitale (§2.9) |
| `accumAlertPct`, `accumAlertMinTerritories` | 50, 3 | soglia e dimensione minima per l'allerta di accumulo (§2.8) |
| `mergeCostTurns`, `mergeMaxUnits` | 0,5, 5 | costo per territorio e dimensione massima di un'area (§2.10, §9 n. 16) |
| `secondCapitalCostTurns` | 20 | costo della seconda capitale, in turni (§2.10) |
| `blockCost`, `blockTurns`, `blockCooldownTurns` | 300, 5, 5 | costo, durata e pausa del blocco militare (§2.10) |
| `allianceMaxMembers`, `allianceLeaveNoticeTurns` | 3, 1 | membri massimi e preavviso di uscita (§2.6, §9 n. 9) |
| `boardMaxChars` | 500 | lunghezza massima di un messaggio in bacheca (§2.11) |

Queste chiavi sono definite e validate, ma nessuna regola le usa ancora.

### Vincoli garantiti dal database

- Le risorse di un territorio non possono essere negative.
- Un territorio può comparire in un solo scontro aperto alla volta, come bersaglio o come territorio di partenza (`BattleLock`).
- Un impero può appartenere a una sola alleanza.
- In una partita nome e colore di un impero sono univoci, e ogni utente ha un solo impero.
- Un comune appartiene a un solo territorio di gioco per partita.
- Una partita nasce nello stato bozza.

## Decisioni prese in corso d'opera

| Data | Decisione |
|---|---|
| 2026-10-07 | Le adiacenze tra territori di gioco non sono copiate per partita: si ricavano dalle adiacenze tra comuni. |
| 2026-10-07 | Le battaglie vengono risolte solo dal servizio `jobs`, mai da `api`. |
| 2026-10-07 | La coda di risoluzione delle battaglie è su Kafka; i lavori programmati a orario (avvio partita, chiusura turno, dati geografici) restano su una tabella del database. |
| 2026-10-07 | Uno scontro la cui richiesta su Kafka va persa viene comunque risolto alla chiusura del turno. |
| 2026-10-07 | La dotazione nascosta dei comuni viene estratta alla creazione della partita, non all'avvio. |

## Punti aperti

- **Limite di frequenza dei messaggi in bacheca** (§2.11): il brief lo prevede ma non ne fissa il valore. Da decidere prima della milestone 10.
- **Palette degli imperi** (§11): i colori attuali si distinguono poco; serve una palette dedicata prima del rilascio.
