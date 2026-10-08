# Regole implementate

Questo file descrive **solo ciò che il codice fa oggi**. Le regole di progetto, comprese quelle non ancora sviluppate, sono in `../../PROMPT.md`; il contratto tecnico tra i servizi è in `ARCHITECTURE.md`. Va aggiornato alla chiusura di ogni milestone.

Stato: **milestone 3 (Dashboard admin e dati geografici) completata.** Nessuna azione di gioco è ancora disponibile.

## Cosa esiste

### Admin di piattaforma

- L'admin viene creato solo dal seed di `api`, con le credenziali lette da `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`. Non esiste alcuna rotta che lo crei.
- Il seed gira a ogni avvio di `api`: se l'admin esiste già, email e password vengono riallineate alle variabili d'ambiente.
- Se lo username scelto appartiene già a un utente normale, il seed fallisce e non promuove nessuno.
- La password dell'admin deve avere almeno 12 caratteri ed è salvata con hash argon2id.

### Registrazione e accesso

- Ci si registra con nome utente, email e password. Il nome utente ha da 3 a 20 caratteri tra lettere, cifre e trattino basso.
- Il nome utente è univoco **senza distinguere maiuscole e minuscole**: "Mario" e "mario" sono lo stesso giocatore. Viene mostrato come è stato scritto alla registrazione.
- L'email non è univoca: più utenti possono condividerla.
- La password ha almeno 8 caratteri ed è salvata con hash argon2id.
- Si accede solo con nome utente e password; l'email non è mai accettata come identificativo.
- Password sbagliata e nome utente inesistente danno la stessa risposta.
- Nessun percorso di registrazione può creare un admin: una richiesta che contiene un ruolo viene rifiutata.
- Accesso e registrazione stanno in un popover aperto dal pulsante in alto a destra.

### Sessioni

- Ogni accesso crea una sessione nel database. Il browser riceve un token in un cookie httpOnly; nel database ne è salvato solo l'hash.
- Una sessione dura 30 giorni (configurabile), poi scade.
- L'uscita termina la sessione corrente.
- L'admin può elencare le sessioni attive e revocarne una: la sessione smette subito di essere valida e le sue connessioni in tempo reale vengono chiuse all'istante. Il giocatore vede un avviso e torna ospite.

### Limitazione dei tentativi

- Accesso: dopo 10 tentativi falliti in 5 minuti, dallo stesso indirizzo o sullo stesso nome utente, i tentativi successivi vengono rifiutati fino alla fine della finestra. Un accesso riuscito azzera il conteggio.
- Registrazione: al massimo 10 registrazioni all'ora dallo stesso indirizzo.
- Entrambi i limiti sono configurabili.

### Utenti connessi

- Un utente è "connesso" quando ha una sessione valida e almeno una connessione in tempo reale aperta. Più schede dello stesso utente contano una volta; gli ospiti non contano.
- Il numero compare nella barra in alto, a cifre scorrevoli, e si aggiorna in tempo reale per tutti, ospiti compresi.

### Dashboard admin

- Esiste solo per l'admin di piattaforma, all'indirizzo `/admin`; per chiunque altro la pagina non esiste.
- **Panoramica**: utenti registrati (l'admin non è contato tra i giocatori), partite in corso, utenti connessi in questo momento.
- **Sessioni**: elenco delle sessioni attive con utente, inizio, ultima attività, indirizzo e stato di connessione. Ogni sessione si può revocare dopo conferma, tranne la propria: l'admin esce con "Esci".
- **Dati geografici**: vedi sotto.

### Dati geografici

- L'admin organizza i dati in **aree** (Italia, Francia…) e in **cartelle annidate** dentro ogni area (Italia → Nord → Lombardia). I nomi sono univoci dentro la stessa cartella. Ogni voce mostra quanti comuni contiene, comprese le sottocartelle.
- In ogni area o cartella si possono caricare file **KML** o **GeoJSON** (anche con estensione `.json`), fino a 300 MB, con i confini in coordinate WGS84.
- Il caricamento è asincrono: l'admin vede l'avanzamento e, alla fine, quanti comuni e quanti confini sono stati trovati.
- Un file con anche un solo elemento non valido viene **rifiutato per intero**: nessun comune viene caricato e l'admin vede l'elenco dei problemi, elemento per elemento (manca il nome, non è un poligono, coordinate non in WGS84, confine con meno di quattro punti, codice ripetuto).
- Lo stesso comune non può essere caricato due volte nella stessa area geografica: se il file contiene codici già presenti viene rifiutato.
- Di ogni comune si salvano nome, codice (se presente), confine, una versione semplificata del confine per la mappa, un punto interno e la superficie.
- **Comuni confinanti**: due comuni confinano quando i loro confini corrono affiancati (entro 5 metri) per almeno 50 metri. Toccarsi in un solo punto non basta. I confini si calcolano una volta, al caricamento, anche con i comuni già presenti nella stessa area: regioni caricate separatamente risultano unite.
- **Confini aggiunti a mano**: l'admin cerca un comune, vede i suoi confinanti e può aggiungerne altri a mano, per isole e comuni che non si toccano. Solo i confini aggiunti a mano si possono rimuovere.
- Eliminare un file elimina i suoi comuni; eliminare una cartella elimina tutto ciò che contiene. Entrambe le operazioni chiedono conferma e sono rifiutate se una partita usa quei comuni.

Verifica sui confini reali di tutti i comuni italiani (7.896): elaborati in circa 20 secondi, 22.811 confini. Restano senza confinanti solo Campione d'Italia e tredici comuni insulari (Capraia Isola, Carloforte, Favignana, Isola del Giglio, Isole Tremiti, La Maddalena, Lampedusa e Linosa, Lipari, Pantelleria, Ponza, Procida, Ustica, Ventotene): sono i casi da collegare a mano.

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
| 2026-10-07 | I nomi utente sono univoci senza distinguere maiuscole e minuscole. |
| 2026-10-07 | Accesso e registrazione sono un popover della barra in alto (§11), non pagine dedicate. |
| 2026-10-07 | Elenco e revoca delle sessioni via API sono stati anticipati dalla milestone 3, perché servono a verificare la revoca. |
| 2026-10-07 | Un file con elementi non validi viene rifiutato per intero, non caricato a metà. |
| 2026-10-07 | Due comuni che si toccano in un solo punto non sono confinanti. |
| 2026-10-07 | La dashboard admin è stata costruita senza un mockup approvato (M0-09 è ancora aperta). |
| 2026-10-07 | La dotazione nascosta dei comuni viene estratta alla creazione della partita, non all'avvio. |

## Punti aperti

- **Soglie dei confini** (5 metri di scarto, 50 metri di confine in comune): sono una mia proposta, configurabile; sull'Italia intera danno il risultato atteso sui casi controllati.
- **Isole**: i quattordici comuni senza confinanti vanno collegati a mano dall'admin, scegliendo a quali comuni della terraferma o di altre isole unirli.
- **Limiti dei tentativi**: i valori (10 accessi falliti in 5 minuti, 10 registrazioni all'ora per indirizzo) sono una mia proposta: il brief chiede il limite ma non ne fissa i numeri.
- **Contatori in memoria**: limiti dei tentativi e registro delle connessioni vivono nel processo `api`. Vanno spostati in uno store condiviso se `api` girerà in più istanze.
- **Limite di frequenza dei messaggi in bacheca** (§2.11): il brief lo prevede ma non ne fissa il valore. Da decidere prima della milestone 10.
- **Palette degli imperi** (§11): i colori attuali si distinguono poco; serve una palette dedicata prima del rilascio.
