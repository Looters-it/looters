# Regole implementate

Questo file descrive **solo ciò che il codice fa oggi**. Le regole di progetto, comprese quelle non ancora sviluppate, sono in `../../PROMPT.md`; il contratto tecnico tra i servizi è in `ARCHITECTURE.md`. Va aggiornato alla chiusura di ogni milestone.

Stato: **milestone 10 (Bacheca) completata.** Una partita avanza turno dopo turno: gli imperi guadagnano risorse, annettono i comuni liberi e si attaccano tra loro. Perdere la capitale fa cadere l'impero, e la partita finisce con un vincitore.

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

### Mappa

- La mappa mostra OpenStreetMap, attenuata, con sopra i confini dei comuni. I comuni liberi sono semitrasparenti e lasciano leggere la mappa sottostante; quelli di un impero sono a colore pieno.
- Si ingrandisce con i pulsanti, con la rotella e con due dita. La mappa non ruota.
- A zoom basso compaiono i nomi degli imperi, a zoom alto i nomi dei comuni; quando due nomi si sovrappongono resta quello del comune o dell'impero più grande.
- Toccando un comune lo si seleziona: il suo confine viene marcato e compare un riquadro ancorato al comune. Su telefono il riquadro è una scheda che sale dal basso.
- Nelle mappe inserite in una pagina (homepage, anteprima admin) un dito scorre la pagina e due dita muovono la mappa.
- **Homepage**: mostra la mappa dell'area geografica più grande, con tutti i comuni liberi. Non è ancora la "mappa in diretta" di una partita.
- **Anteprima admin**: nella scheda "Dati geografici" ogni cartella con comuni ha la sua mappa. Toccando un comune si evidenziano i suoi confinanti, per controllare le adiacenze a vista. Il pulsante "Imperi di prova" colora una partita fittizia con cento imperi, per valutare come regge la mappa.
- I cambi di proprietà aggiornano solo i comuni interessati, senza ricaricare la mappa.

Non ancora presenti, in arrivo con le partite: il bordo esterno più spesso di ogni impero, gli stemmi accanto ai nomi, le icone di stato (capitale, protetto, sotto attacco, blocco, allerta).

### Partite

**Creazione**

- Ogni utente registrato può creare una partita scegliendo: nome, area di gioco (un'area o una cartella con dei comuni), data e ora di inizio, giocatori massimi (da 2 a 120, predefinito 100), durata del turno in ore (predefinita 24), durata massima in giorni (facoltativa: senza, la partita non ha scadenza), codice d'invito (facoltativo: senza, la partita è pubblica) e tutte le regole di gioco, che partono dai valori predefiniti.
- La partita nasce come **bozza**, visibile solo a chi l'ha creata, che può modificarla in tutto o eliminarla.
- Con "Apri le iscrizioni" la bozza diventa pubblica. In quel momento vengono creati i territori di gioco, uno per comune, ciascuno con la sua dotazione nascosta. Da lì in poi mappa, durata del turno e regole non si possono più cambiare; restano modificabili nome, data di inizio, durata massima, giocatori massimi (non sotto il numero degli iscritti) e codice d'invito.
- Chi crea la partita partecipa come gli altri: si iscrive e sceglie il suo comune.

**Dotazione nascosta dei comuni**

- Ogni comune riceve una quantità casuale di risorse tra 10 e 100: i valori centrali sono i più frequenti (oltre metà dei comuni sta tra 40 e 70) e quelli da 80 in su sono rari (circa l'8%). Limiti e forma sono regole della partita.
- Il valore viene estratto sul server e non arriva mai a nessun giocatore finché il comune è libero.

**Iscrizione**

- Ci si iscrive scegliendo sulla mappa un comune libero e dando all'impero nome, colore, stemma e motto (facoltativo).
- Il comune scelto diventa la **capitale**. Vi vengono allocate le risorse iniziali (200) più la dotazione nascosta del comune, che in quel momento viene svelata al solo proprietario.
- Se due giocatori scelgono lo stesso comune, lo ottiene chi arriva prima; l'altro riceve un errore, non perde nulla e può scegliere di nuovo.
- In una partita nome (senza distinguere maiuscole e minuscole) e colore di un impero sono univoci; lo stemma può ripetersi. Ogni utente ha un solo impero per partita.
- I colori sono 120 e gli stemmi dieci (torre, stella, croce, corona, scudo, rombo, bande, scacchi, monte, luna), tutti predefiniti.
- Se la partita ha un codice d'invito, serve per iscriversi; lo vede solo chi ha creato la partita.
- Nome, colore, stemma e motto si possono cambiare solo prima dell'inizio.
- Le iscrizioni restano aperte anche a partita iniziata, finché ci sono posti, a meno che la regola "si può entrare anche a partita iniziata" sia disattivata.

**Avvio**

- All'ora di inizio la partita parte da sola: passa al turno 1 e la fine del turno viene calcolata dall'ora di inizio prevista.
- Le capitali scelte prima dell'inizio sono protette fino alla fine del turno 1. Chi entra a partita iniziata è protetto fino alla fine del turno in cui entra.
- Servono almeno 2 imperi (regola della partita). Con meno, all'ora di inizio non succede nulla: la partita resta con le iscrizioni aperte e chi l'ha creata può fissare una nuova data.

**Cosa vede chi**

- Tutti, anche gli ospiti, vedono le partite con iscrizioni aperte o in corso, gli imperi, i loro comuni sulla mappa e le regole.
- Le risorse di un territorio le vede solo il suo proprietario. Per tutti gli altri sono "nascoste".

**Homepage**

- "Partite attive" elenca le partite con iscrizioni aperte o in corso, sei per pagina, filtrabili per nome e per partecipanti (con posti liberi, fino a 20, da 21 a 50, più di 50). Il pulsante è "Partecipa", "Al completo" (disattivato) o "Entra" se la partita è già tua.
- "Le tue partite" elenca quelle che hai creato (bozze comprese) o a cui partecipi.

### Turni

- Il turno ha una durata fissa. Alla scadenza viene chiuso da solo e si apre il successivo; la scadenza del nuovo turno si calcola da quella prevista del precedente, non dal momento in cui la chiusura è avvenuta.
- Alla chiusura: ogni impero attivo riceve il guadagno, il limite di annessioni si azzera, le protezioni dei comuni appena acquisiti finiscono, e viene salvato chi possiede ogni comune (servirà allo storico).
- La chiusura è ripetibile: se viene eseguita due volte per lo stesso turno, la seconda non ha effetto.
- Le azioni dei giocatori hanno effetto immediato. Ogni azione dichiara il turno in cui è stata decisa: se nel frattempo il turno è cambiato viene rifiutata e nulla viene speso.

### Risorse

- Le risorse di un impero stanno sui suoi territori: non esiste una cassa centrale e il totale è sempre la somma dei territori.
- **Guadagno per turno**: 50 più 10 per ogni comune controllato (regole della partita).
- **Ripartizione del guadagno**: è una regola permanente dell'impero. "In parti uguali" divide il guadagno tra i territori; "in proporzione" lo divide secondo un peso per territorio, fissato dal giocatore con le risorse che ogni comune ha nel momento in cui sceglie questa regola. Gli importi sono interi e il resto va alla capitale.
- Un comune acquisito dopo aver scelto la proporzione ha peso 1, quindi riceve molto poco finché il giocatore non riapplica la regola.
- **Spostamento**: il giocatore può ridistribuire le risorse tra i propri territori in qualsiasi momento; il totale non cambia. Un territorio coinvolto in uno scontro è bloccato.
- Nella scheda "Risorse per comune" ogni comune ha uno slider. In cima ci sono i comuni, le risorse totali e quelle non allocate. Abbassare un comune libera risorse; un comune può salire solo di quanto è stato liberato. "Dividi in parti uguali" e "Annulla" agiscono sulla bozza; nulla viene salvato finché non si preme "Applica", attivo solo quando le non allocate sono zero.

### Annessione

- Un giocatore può annettere un comune libero confinante con un proprio territorio. L'effetto è immediato.
- Costa 50 risorse, pagate per intero da un proprio territorio confinante con il bersaglio, scelto dal giocatore. Se nessun territorio confinante ha 50 risorse l'annessione non è possibile.
- Limite: 1 annessione per turno.
- Il comune annesso conserva le risorse che aveva (la dotazione nascosta, o quelle rimaste dopo la caduta di un impero), che da quel momento sono dell'impero e visibili al solo proprietario.
- Il comune appena annesso può ricevere risorse subito ed è protetto fino alla fine del turno.
- Se due imperi annettono lo stesso comune nello stesso momento lo ottiene il primo; il secondo riceve un errore, non spende nulla e conserva l'annessione del turno.
- I saldi non possono mai andare in negativo, nemmeno con richieste contemporanee.

### Scontri

**Dichiarazione**

- Un impero attacca un comune di un altro impero confinante con il proprio territorio, scegliendo da quali suoi comuni confinanti con il bersaglio far partire l'attacco: uno o più.
- Ogni comune usato deve avere almeno 1 risorsa e non deve essere già in uno scontro.
- Non si può attaccare un comune appena acquisito (protetto fino a fine turno), un comune già sotto attacco, un comune libero (si annette) o un proprio comune.
- **Costo**: una percentuale delle risorse di ciascun comune usato: 50% con un comune, più 10% per ogni comune in più, fino al 100%. Si arrotonda per eccesso e si paga subito, alla dichiarazione.
- **Forza**: la somma delle risorse sui comuni usati al momento della dichiarazione, prima di pagare il costo. Anche la forza del difensore viene fissata in quel momento: sono le risorse sul comune attaccato.
- Prima di confermare il giocatore vede forza in campo, quota pagata e costo; non vede alcuna probabilità di vittoria, perché le risorse del nemico sono nascoste.

**Blocco**

- Un comune può essere coinvolto in un solo scontro alla volta, come bersaglio o come comune di partenza. Finché lo scontro è aperto non può essere attaccato, attaccare, dare o ricevere risorse, né pagare un'annessione. Il vincolo è garantito dal database.
- Gli altri comuni dei due imperi restano liberi, e uno stesso impero può essere attaccato su più comuni contemporaneamente, anche da imperi diversi.

**Risposta del difensore**

- Il difensore riceve subito un'allerta rossa nella barra in alto. La risposta si dà sempre in una finestra modale, che mostra le risorse nel comune e il costo della difesa.
- **Difendersi**: paga il 50% delle risorse sul comune attaccato (per eccesso) e si combatte subito.
- **Arrendersi**: cede il comune con tutte le sue risorse senza spendere nulla; l'attaccante riceve indietro il 50% del costo, comune per comune (per difetto).
- Se non risponde entro la fine del turno, alla chiusura si combatte come se si fosse difeso: paga il costo della difesa. Il silenzio non è mai una resa.
- L'esito si legge nella stessa finestra.

**Battaglia**

- Ciascuno moltiplica la propria forza per un numero casuale tra 0 e 1, estratto in modo indipendente con un generatore sicuro. Vince chi ottiene il valore più alto; in caso di parità esatta vince il difensore.
- A parità di risorse l'attaccante vince una volta su due; con il doppio, tre su quattro. La frequenza delle vittorie è verificata nei test rispetto a questa formula.
- Se vince l'attaccante prende il comune con le risorse rimaste dopo il costo della difesa. Se vince il difensore lo tiene, ma il costo della difesa è speso comunque. Il costo dell'attacco non viene mai restituito, tranne la metà in caso di resa.
- Il comune conquistato è protetto fino alla fine del turno. Se viene conquistato alla chiusura di un turno (difensore che non ha risposto), è protetto per tutto il turno successivo.
- Forze, costi, numeri estratti, esito e nome della formula usata vengono registrati.

**Cosa vede chi**

- Tutti vedono quali comuni sono sotto attacco (bordo rosso pulsante in mappa) e tra quali imperi è lo scontro.
- L'attaccante vede i propri numeri (comuni usati, costo, forza), il difensore i propri (risorse nel comune, costo della difesa). Nessuno vede i numeri dell'altro né quelli estratti.
- Da quali comuni parte un attacco lo sa solo l'attaccante.
- La voce "Scontri" del menu elenca gli scontri in corso e, per i due imperi coinvolti, quelli conclusi nel turno corrente e nel precedente.

### Capitale, caduta e vittoria

**Capitale**

- Ogni impero ha una capitale, sempre visibile a tutti in mappa (un disco bordato nel colore dell'impero).
- Si può spostare in un altro proprio comune una volta ogni 3 turni, mai mentre la capitale attuale o quella nuova è in uno scontro: la capitale non può sottrarsi a un attacco.

**Caduta di un impero**

- Se la capitale viene conquistata, in battaglia o per resa, l'impero cade e il giocatore resta nella partita come spettatore: vede tutto ciò che vedono gli ospiti, non può più agire.
- Chi ha conquistato la capitale ottiene solo quel comune, con le sue risorse.
- Tutti gli altri comuni dell'impero caduto diventano liberi e conservano le loro risorse, che restano nascoste finché qualcuno non li annette.
- Gli scontri ancora aperti in cui l'impero caduto era attaccante o difensore vengono annullati: non si combattono, i comuni coinvolti si sbloccano e il costo dell'attacco torna ai comuni che l'avevano pagato.

**Fine della partita**

- **Ultimo impero rimasto**: quando resta un solo impero attivo la partita finisce subito e quell'impero vince, anche se la partita ha una durata massima.
- **Scadenza**: una partita con durata massima finisce alla prima chiusura di turno che cade alla scadenza o dopo. Quel turno viene chiuso normalmente (scontri, guadagno), poi vince l'impero attivo con più risorse totali; a parità chi controlla più comuni; a ulteriore parità chi si è iscritto prima.
- A partita conclusa non si può più fare nulla, gli scontri aperti vengono annullati e la classifica mostra il vincitore e le risorse totali di ogni impero, fino a quel momento nascoste.

**Allerta di accumulo**

- Quando un comune contiene più del 50% delle risorse del suo impero a due chiusure di turno consecutive, compare in mappa un'allerta visibile a tutti (un disco rosso con punto esclamativo). Segnala il comune, mai la quantità.
- Sparisce alla prima chiusura in cui il comune è tornato sotto la soglia.
- Vale solo per gli imperi con almeno 3 territori.
- La verifica avviene alla chiusura del turno, dopo il guadagno.

### Strutture

- Le strutture si scelgono da un catalogo e si piazzano su un proprio comune, che ne paga il costo con le sue risorse. Sono visibili a tutti.
- Il catalogo è estendibile: una nuova struttura si aggiunge come voce del catalogo, senza modifiche al database né alla chiusura dei turni. L'interfaccia mostra qualunque struttura il catalogo contenga.
- "Il valore di N turni" è N volte il guadagno per turno dell'impero al momento dell'acquisto, arrotondato per eccesso.
- Non si può costruire su un comune coinvolto in uno scontro.

| Struttura | Costo | Durata | Effetto |
|---|---|---|---|
| Blocco militare | 300 risorse | 5 turni (quello di costruzione compreso) | Il comune non può essere attaccato, e non può attaccare né partecipare a un attacco. |
| Seconda capitale | valore di 20 turni | permanente | Se la capitale principale viene conquistata, l'impero non cade. |

**Blocco militare**

- Alla scadenza non è rinnovabile di seguito: devono passare 5 turni prima di piazzarne un altro sullo stesso comune.
- È segnalato in mappa con i turni rimanenti.

**Seconda capitale**

- Una sola per impero, su un comune diverso dalla capitale.
- Se la capitale principale viene conquistata, il giocatore perde quel comune ma resta in partita: la seconda capitale diventa la capitale e la riserva è consumata. Per averne un'altra va ricomprata.
- Se è la seconda capitale a essere conquistata, si perdono solo il comune e la struttura: non passa al conquistatore.
- Si può spostare su un altro proprio comune con il proprio intervallo di 3 turni, indipendente da quello della capitale principale. (Lo spostamento è disponibile via API; nell'interfaccia non c'è ancora il pulsante.)
- In mappa è un anello nel colore dell'impero, distinto dal disco pieno della capitale.

### Fusione di territori

- Il giocatore unisce due o più propri comuni confinanti tra loro in un'unica **area**, a cui dà un nome. Costa il valore di mezzo turno per ogni comune incluso, pagato dalla somma delle loro risorse.
- Un'area contiene al massimo 5 comuni, non si può dividere e può comprendere la capitale (che resta dov'è).
- L'area si comporta come un solo territorio: le risorse si sommano, confina con tutto ciò con cui confinava almeno uno dei suoi comuni, attacca come un territorio solo (senza costo progressivo) e chi la conquista la prende intera.
- Nei conteggi (classifica, guadagno, parità a fine partita) vale quanto i comuni che contiene.
- Non si può unire un comune coinvolto in uno scontro. Le strutture dei comuni uniti passano all'area.
- Un'area può far scattare l'allerta di accumulo come ogni altro territorio.
- In mappa è contornata da un bordo spesso con il suo nome; si rinomina dalla scheda di uno dei suoi comuni.

**Nell'interfaccia**: sotto "Il tuo impero" ci sono tre pagine con una barra comune: Risorse per comune, Unisci territori, Costruzioni. In "Unisci territori" e in "Costruzioni" i comuni si scelgono dall'elenco o toccandoli sulla mappa; quando l'operazione non è possibile il motivo è scritto.

### Bacheca

- Ogni partita ha una bacheca pubblica, leggibile da chiunque veda la partita (ospiti compresi), in ordine cronologico.
- **Comunicazioni degli imperi**: messaggi di solo testo scritti dai giocatori a nome del proprio impero, mostrati con nome e stemma. Al massimo 500 caratteri, e un impero deve aspettare 20 secondi tra un messaggio e l'altro.
- Può scrivere solo chi ha un impero ancora in gioco, finché la partita non è finita. Ospiti, spettatori e imperi caduti leggono soltanto.
- Chi ha creato la partita e l'admin di piattaforma possono rimuovere i messaggi dei giocatori. Gli annunci automatici non si possono rimuovere.
- **Annunci automatici**: creazione di un impero, annessione di un comune, esito di un conflitto (conquista, difesa riuscita o resa), creazione e rinomina di un'area, caduta di un impero, costruzione di una seconda capitale, spostamento della capitale, promozione della seconda capitale, inizio e fine della partita. Anche la nascita di un'alleanza, l'ingresso di un impero e l'uscita effettiva sono annunciati.
- L'attacco viene annunciato solo a conflitto risolto. Blocchi militari e allerte di accumulo non vengono annunciati: si vedono in mappa.
- Gli annunci non contengono mai quantità di risorse: solo nomi ed esiti.
- Un annuncio che cita un comune ha un collegamento che centra la mappa su quel comune e lo seleziona.
- La bacheca si filtra per tipo (comunicazioni, conflitti, annessioni, imperi, capitali, aree, alleanze, partita) e per impero.
- Si aggiorna da sola quando succede qualcosa nella partita.
- **Nell'interfaccia** è un pannello in basso a sinistra sopra la mappa: chiuso mostra l'ultimo annuncio e quanti sono nuovi, aperto si espande verso l'alto con i filtri, l'elenco e il campo per scrivere. Su telefono è la terza scheda in fondo.

### Alleanze

- Un impero propone un'alleanza a un altro impero in gioco; chi la riceve accetta o rifiuta, chi l'ha fatta può ritirarla. Chi è già in un'alleanza, proponendo, invita il terzo nella propria: basta l'accordo di chi invita e di chi è invitato.
- Un impero fa parte di **una sola alleanza**, che ha al massimo **3 membri** (configurabile). Non si può invitare un impero che è già in un'alleanza, né accettare se nel frattempo l'alleanza si è riempita o chi ha proposto ne è uscito o ha cambiato alleanza.
- Non ci si può alleare con qualcuno con cui è in corso uno scontro: prima lo scontro si chiude.
- **Gli alleati non possono attaccarsi.** Il divieto vale dal momento dell'accettazione fino all'uscita effettiva.
- **Uscita**: è unilaterale e ha effetto alla **fine del turno successivo** a quello in cui viene annunciata (preavviso configurabile). Fino ad allora chi esce resta alleato a tutti gli effetti: non può attaccare né essere attaccato dagli alleati, vede e fa vedere le risorse. Chi ha annunciato l'uscita non può invitare altri. L'annuncio è visibile a tutti nella scheda dell'alleanza e non si ritira.
- Un'alleanza rimasta con un solo membro, per un'uscita o per la caduta di un impero, si scioglie.
- **Risorse visibili**: gli alleati vedono le risorse dei territori l'uno dell'altro, in mappa, nelle schede dei comuni e nella vista "Risorse". Dopo l'uscita effettiva tornano nascoste.
- **Trasferimenti**: un impero può mandare risorse da un proprio territorio a un territorio di un alleato, subito, senza limite di distanza. Non si può mandare da o verso un territorio coinvolto in uno scontro: l'aiuto tra alleati è solo preventivo.
- **Chat di alleanza**: privata, la leggono e ci scrivono solo i membri attuali; chi entra legge anche i messaggi precedenti, chi esce non la vede più.
- **L'alleanza non vince**: il vincitore è sempre un solo impero. Se alla fine restano solo imperi alleati, la partita continua fino alla scadenza o finché uno conquista le capitali degli altri, dopo essere uscito.
- Chi è alleato con chi è **pubblico**: lo vedono tutti, anche ospiti e spettatori. Le proposte in attesa le vedono solo chi le ha fatte e chi le ha ricevute.
- **Nell'interfaccia**: la voce "Alleanza" del menu dell'impero raccoglie membri, proposte, invito, trasferimento, chat e uscita (con conferma). Sulla mappa un selettore in alto a sinistra cambia vista: **Politica** (colore dell'impero), **Alleanze** (un colore per alleanza, neutro per chi non ne ha) e **Risorse** (tono più scuro dove ci sono più risorse, solo sui territori propri e degli alleati).

### Storico dei turni

- Di ogni turno chiuso restano gli **eventi** (gli stessi annunci automatici della bacheca, in ordine; non i messaggi dei giocatori) e **chi possedeva ogni comune** alla fine del turno. Anche l'ultimo turno di una partita conclusa è nello storico, in qualunque momento sia finita.
- Lo storico è pubblico come la bacheca: lo legge chiunque veda la partita. Non contiene mai risorse, né proprie né altrui: delle risorse dei turni passati non si conserva nulla.
- Ciò che è successo prima dell'inizio (la nascita degli imperi) è elencato nel primo turno.
- **Nell'interfaccia**: la voce "Storico dei turni" del menu elenca i turni dal più recente, una card richiudibile per turno con il numero di eventi; aperta, mostra gli eventi (quelli che citano un comune portano la mappa su quel comune) e il pulsante **Rivedi sulla mappa**.
- **Revisione della mappa**: la mappa si colora con i proprietari di quel turno; una barra in alto a sinistra dice quale turno si sta guardando, con le frecce per il turno precedente e successivo e **Torna al presente**. Durante la revisione non si vedono capitali, strutture, aree, allerte e scontri (sono del presente) e un tocco su un comune dice solo di chi era allora.

### Interfaccia di partita

- **Barra in alto**: giocatori della partita connessi sul totale di quelli in gioco, turno, conto alla rovescia, risorse totali del giocatore.
- **Pannello a destra con menu**: La partita, Classifica, e sotto "Il tuo impero" la voce Risorse per comune. Dentro una voce il menu sparisce e resta il pulsante "Menu".
- **Classifica**: barra di ripartizione dei comuni e una scheda per impero con posizione, nome, giocatore, numero di comuni e un quadratino per comune (capitale contornata, protetto vuoto). Passando su una scheda i territori dell'impero si evidenziano in mappa. Non mostra mai le risorse.
- **Scheda del comune**: toccando un comune si apre con nome, impero, risorse (numero se proprie, "nascoste" altrimenti; nulla per i comuni liberi), stato, l'annessione quando è possibile e i comuni confinanti, ciascuno apribile. Quando l'annessione non è possibile il motivo è scritto.
- Selezionando un proprio comune, i confinanti liberi si evidenziano in mappa.
- **Aggiornamenti in tempo reale**: quando qualcosa cambia nella partita la pagina si aggiorna da sola.
- **Telefono**: mappa e pannello occupano lo schermo a turno, con due schede in fondo.

### Configurazione delle regole di partita

Ogni valore numerico di gioco è una chiave della configurazione di partita (`api/src/rules/config.ts`). Alla creazione di una partita la configurazione viene salvata per intero in `Match.config`: cambiare un default non modifica le partite esistenti. Le chiavi sconosciute e i valori incoerenti vengono rifiutati.

| Chiave | Default | Regola (PROMPT) |
|---|---|---|
| `minPlayersToStart` | 2 | imperi minimi perché la partita parta (scelta provvisoria) |
| `lateJoin` | sì | ci si può iscrivere anche a partita iniziata (scelta provvisoria) |
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
| `boardMessageIntervalSec` | 20 | secondi di attesa tra due messaggi dello stesso impero (scelta provvisoria) |

Di queste chiavi oggi sono in uso `minPlayersToStart`, `lateJoin`, `startResources`, le quattro della dotazione nascosta, `incomeBase`, `incomePerUnit`, `annexCost`, `annexPerTurn`, le tre dell'attacco, `defensePct`, `surrenderRefundPct`, `capitalMoveEveryTurns`, le due dell'allerta di accumulo e le sei delle strutture; le altre sono definite e validate in attesa delle rispettive milestone.

### Vincoli garantiti dal database

- Le risorse di un territorio non possono essere negative.
- Un territorio può comparire in un solo scontro aperto alla volta, come bersaglio o come territorio di partenza (`BattleLock`).
- Un impero può appartenere a una sola alleanza.
- In una partita nome e colore di un impero sono univoci, e ogni utente ha un solo impero.
- Un comune appartiene a un solo territorio di gioco per partita.
- Una partita nasce nello stato bozza.
- Un comune libero viene assegnato con un aggiornamento condizionato: due iscrizioni contemporanee sullo stesso comune non possono riuscire entrambe.

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
| 2026-10-08 | La dotazione nascosta dei comuni viene estratta all'apertura delle iscrizioni (quando la bozza diventa pubblica), prima che chiunque possa iscriversi. |
| 2026-10-08 | La creazione segue gli stati del brief (bozza, poi iscrizioni aperte): chi crea la partita si iscrive dalla pagina della partita, non in un unico passaggio come nel prototipo. |
| 2026-10-08 | La scheda "Stato del sistema" è passata dalla homepage alla panoramica admin. |

## Punti aperti

- **Storico, scelte da confermare** `[ASSUNZIONE]`: lo storico è pubblico (anche per ospiti); i messaggi dei giocatori non ne fanno parte; la revisione mostra solo la proprietà dei comuni, non capitali, aree e strutture di allora; una partita con moltissimi turni li elenca tutti, senza paginazione.

- **Alleanze, scelte da confermare** `[ASSUNZIONE]`: per far entrare un terzo impero basta l'invito di un solo membro, senza il consenso dell'altro; l'annuncio di uscita non si può ritirare; i trasferimenti tra alleati non hanno limite di quantità né di distanza; alleati e proposte accettate sono pubblici, mentre le proposte in attesa sono private; il colore di un'alleanza in mappa è quello del suo primo membro.

- **Spostamento della seconda capitale**: esiste nelle API ma non ha ancora un pulsante nell'interfaccia.
- **Blocco militare e fusione**: se si unisce un comune sotto blocco, il blocco passa all'intera area. Il brief non copre il caso.
- **Geometria delle aree**: la calcola PostGIS su richiesta dentro `api`, non un job in `jobs` come indicato nel backlog (M9-05): le aree sono poche e piccole.
- **Ultimo impero rimasto in una partita con scadenza**: la faccio finire subito, anche se il brief cita questa regola solo per le partite senza scadenza. Da confermare.
- **Parità totale alla scadenza** (stesse risorse e stessi comuni): vince chi si è iscritto prima. Il brief non lo dice.
- **Scontri annullati alla caduta di un impero**: il costo dell'attacco viene restituito per intero. Il brief non copre il caso.
- **Stemma sulla capitale**: il segnaposto è un disco colorato, non lo stemma dell'impero come da §2.8.
- **Protezione di un comune conquistato alla chiusura del turno**: l'ho estesa a tutto il turno successivo, perché "fino alla fine del turno" appena chiuso non proteggerebbe nulla. Da confermare.
- **Chi attacca è pubblico**: durante lo scontro tutti vedono quale impero attacca quale comune (non da dove). Il brief dice solo che lo scontro è visibile in mappa. Da confermare.
- **Icone di stato in mappa**: per ora c'è solo il bordo del comune sotto attacco; scudo del protetto e segnaposto della capitale non sono ancora disegnati.
- **Peso dei comuni nuovi nella ripartizione in proporzione**: oggi è 1. Da decidere se dare al comune nuovo un peso più sensato (per esempio la media degli altri).
- **Connessi della partita**: conto i giocatori con un impero attivo che hanno la partita aperta in quel momento, non quelli semplicemente collegati al sito. Da confermare.
- **Interfaccia su telefono**: le due schede in fondo (mappa, pannello) non sono state provate su un telefono reale; la terza scheda del prototipo, la bacheca, arriva con la milestone 10.
- **Giocatori minimi per partire**: il brief non dice cosa succede se all'ora di inizio c'è un solo iscritto o nessuno. Ho scelto: servono almeno 2 imperi, altrimenti la partita aspetta una nuova data. Da confermare.
- **Iscrizioni a partita iniziata**: il brief non lo dice in modo esplicito. Ho scelto di permetterle, con una regola per disattivarle. Da confermare.
- **Abbandono**: un giocatore iscritto non può ritirarsi né cambiare comune di partenza prima dell'inizio. Il brief non lo prevede.
- **Palette degli imperi**: i 120 colori sono generati (24 tinte in 5 toni) per garantire l'unicità fino a 120 giocatori, ma molti si somigliano sulla mappa. Resta da disegnare la palette dedicata (M0-11).
- **Durata del turno minima**: l'interfaccia accetta frazioni di ora (fino a 0,01, circa 36 secondi) per fare partite di prova veloci. Da decidere se limitarla in produzione.
- **Mappa di sfondo**: in sviluppo si usano le tile pubbliche di OpenStreetMap, che non sono ammesse per un sito in produzione. Prima del rilascio serve un fornitore di tile (o un server proprio).
- **Prova su telefono**: la mappa è stata verificata su computer con l'Italia intera; su un telefono reale non è ancora stata provata.
- **Colori degli imperi di prova**: derivano dalle tre palette del tema e oltre una dozzina di imperi si confondono, come già annotato per la palette dedicata.
- **Soglie dei confini** (5 metri di scarto, 50 metri di confine in comune): sono una mia proposta, configurabile; sull'Italia intera danno il risultato atteso sui casi controllati.
- **Isole**: i quattordici comuni senza confinanti vanno collegati a mano dall'admin, scegliendo a quali comuni della terraferma o di altre isole unirli.
- **Limiti dei tentativi**: i valori (10 accessi falliti in 5 minuti, 10 registrazioni all'ora per indirizzo) sono una mia proposta: il brief chiede il limite ma non ne fissa i numeri.
- **Contatori in memoria**: limiti dei tentativi e registro delle connessioni vivono nel processo `api`. Vanno spostati in uno store condiviso se `api` girerà in più istanze.
- **Limite di frequenza dei messaggi in bacheca** (§2.11): il brief lo prevede ma non ne fissa il valore. Ho messo 20 secondi tra due messaggi dello stesso impero, configurabile per partita. Da confermare.
- **Chi è nuovo in bacheca**: il conteggio dei "nuovi" è ricordato nel browser, non sul server: cambiando dispositivo riparte.
- **Palette degli imperi** (§11): i colori attuali si distinguono poco; serve una palette dedicata prima del rilascio.
