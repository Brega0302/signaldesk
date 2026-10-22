# SignalDesk — vodič za Adina

## Prvo: šta si napravio?

SignalDesk je aplikacija kojom tim prati kvarove svojih servisa. Nije program koji automatski otkriva kvar. Osoba prijavi problem, tim ga istražuje i bilježi rješenje.

Primjer: kupci ne mogu platiti narudžbu. Prijaviš incident za Payments, postaviš ozbiljnost Critical, dodijeliš odgovornu osobu, zapišeš nalaze i pomjeraš status do Resolved.

Za intervju je pošteno reći da si koristio AI kao pomoć. Vrijednost pokazuješ razumijevanjem, samostalnim izmjenama i objašnjenjem kompromisa. Jedan projekt sam po sebi ne znači da imaš seniorsko iskustvo.

## Kako ga pokrenuti

1. Instaliraj Node 22.13 ili noviji.
2. U terminalu ovog foldera pokreni npm install.
3. Kopiraj .env.example u .env.
4. npm run dev pokreće API i frontend.
5. Otvori http://127.0.0.1:5180.
6. Za provjeru koristi npm test i npm run build.

Demo lozinka je DemoPass123! za sva tri računa. Administrator: admin@signaldesk.demo; član tima: responder@signaldesk.demo; posmatrač: viewer@signaldesk.demo.

## Tri sloja koja moraš razlikovati

**Frontend** (src/main.tsx): ono što vidiš u pregledniku. Prikazuje podatke i šalje zahtjeve. React stanje pamti otvoreni prozor, filtere i učitane rezultate. Ne odlučuje konačno ko smije mijenjati podatke.

**Backend** (server/app.ts): prima HTTP zahtjev, provjerava prijavu i prava, validira unos, primjenjuje poslovna pravila i vraća odgovor.

**Baza** (server/db.ts): čuva korisnike, servise, incidente i događaje. Podaci ostaju i nakon restarta. Baza nije isto što i React state.

## Prati jedno kreiranje incidenta

1. Popuniš formular i klikneš Create incident.
2. Frontend šalje POST /api/incidents s JSON podacima.
3. Preglednik automatski doda session cookie.
4. Server pronađe korisnika preko hashiranog tokena.
5. Odbije viewer račun čak i ako je zahtjev ručno poslan bez interfejsa.
6. Zod provjeri dužinu naslova, opis i dozvoljenu ozbiljnost.
7. Server provjeri da servis zaista postoji.
8. Transakcija doda incident i događaj Incident reported.
9. Server vrati 201 i novi zapis.
10. Frontend ponovo učita listu i otvori detalje.

Vježba: nađi svaki od ovih koraka u kodu prije razgovora.

## Šta znači transakcija?

Ako snimiš novi status, a ne snimiš događaj, historija više nije pouzdana. Transakcija znači: ili se snime obje promjene ili nijedna.

BEGIN IMMEDIATE zauzima pravo pisanja u SQLite. Nakon uspjeha ide COMMIT; poslije greške ROLLBACK. Ovo je konkretan razlog za transakciju, ne ukrasna arhitektura.

## Zašto postoji version?

Zamisli da ti i kolega otvorite isti incident s verzijom 2. Ti ga promijeniš i nastane verzija 3. Kolega i dalje šalje verziju 2. Bez provjere bi mogao pregaziti tvoj rad.

Ovdje server vrati 409 Conflict. Interfejs osvježi podatke i kaže da je zapis izmijenjen. To se zove optimistička kontrola konkurentnosti.

Vježba: otvori dva prozora s istim incidentom. U jednom promijeni status. U drugom pokušaj dodjelu. Moraš vidjeti upozorenje o konfliktu.

## Zašto uloge na serveru?

Sakriveno dugme nije zaštita. Korisnik može sam poslati HTTP zahtjev. Middleware canWrite odbija viewer. Kreiranje servisa dodatno zahtijeva admin ulogu.

Autentikacija: ko si? Autorizacija: šta smiješ?

## Kako radi prijava?

Lozinka se ne čuva kao običan tekst. scrypt i nasumična salt vrijednost daju password hash. Nakon prijave server generiše nepredvidiv token i pošalje ga kao HttpOnly cookie. U bazu ide hash tokena.

HttpOnly znači da JavaScript u pregledniku ne čita cookie. Ne znači da je aplikacija automatski zaštićena od svakog XSS-a. HTTPS, sigurno renderovanje i CSP su odvojeni slojevi.

Odjava briše sesiju iz baze. JWT nije potreban samo zato što se često pojavljuje u tutorijalima.

## Statusi nisu proizvoljni

Open znači prijavljeno. Investigating znači aktivno istraživanje. Monitoring znači da je primijenjeno rješenje i prati se rezultat. Resolved znači završeno.

Ne može se odmah iz Open u Resolved. Server vraća 422. Iz Monitoring se može nazad u Investigating, a zatvoren incident može ponovo postati Open.

## Šta mjere brojevi?

Active: svi koji nisu resolved.
Critical: critical incidenti koji nisu resolved.
Resolved: trenutno završeni.
MTTR: prosječan broj minuta od otvaranja do zatvaranja završnih incidenata.

MTTR nije uptime niti garantovano vrijeme dostupnosti. Ako te pitaju za SLA, reci da ta funkcija ovdje nije implementirana.

## Zašto SQLite, a ne PostgreSQL?

Za lokalni demonstracioni projekt dobiješ relacije, transakcije i trajnost bez dodatnog servera. WAL dozvoljava bolju saradnju čitanja i pisanja. Ograničenje: jedan pisac i jedan lokalni fajl.

Za više serverskih instanci predložio bi PostgreSQL i zajednički sistem za rate limit. Ne predstavljaj SQLite kao univerzalno najbolje rješenje.

## Testovi koje pokažeš

npm test pokreće HTTP server s pravom SQLite bazom u memoriji. Test se prijavi i šalje zahtjeve kao preglednik.

- Viewer pokušava promijeniti podatke: 403.
- Stara verzija pokušava prepisati incident: 409.
- Nedozvoljen status: 422.
- Pogrešan unos: 400.
- Nakon odjave stari token: 401.
- Promjena i historija ostaju konzistentni.
- SQL nalik napad u pretrazi ostaje običan tekst.
- Pretjerani pokušaji prijave dobiju 429.

To su provjere ponašanja, a ne testovi koji samo ponavljaju izgled funkcije.

## Demo od pet minuta

1. Prijavi se kao admin i objasni četiri metrike.
2. Kreiraj incident za servis Payments.
3. Dodijeli ga članu tima, promijeni status i dodaj bilješku.
4. Pokaži historiju sa stvarnim imenom korisnika.
5. Prođi kroz monitoring i resolved; pokaži uticaj na zdravlje servisa.
6. Prijavi se kao viewer i pokaži read-only prikaz.
7. Pokaži test za stale update i objasni 409.

## Pitanja za intervju

**Šta je najvažnija odluka?** Transakcija čuva promjenu i audit zajedno, a version sprečava neprimjetno prepisivanje.

**Kako bi dodao email obavijesti?** Outbox tabela unutar iste transakcije, pa zaseban worker šalje poruke uz retry i idempotency. Slanje emaila direktno u transakciji može blokirati bazu.

**Kako bi dodao više firmi?** Tenant ID na svim relevantnim podacima, provjera članstva u svakoj ruti, tenant-scoped upiti i testovi izolacije. Sam dropdown nije dovoljno.

**Šta bi prvo poboljšao?** Account management, migracije, šire UI testove, backup/restore postupak, te razdvajanje velikog frontend fajla u feature module.

**Da li je ovo produkcijski dokazano?** Ne. Ovo je funkcionalan portfolio projekt sa stvarnim backendom i testovima, uz jasno opisana ograničenja.

## Plan da ga zaista naučiš

Dan 1: pokreni aplikaciju, koristi sve tri uloge i ispričaj tok kreiranja incidenta.
Dan 2: pročitaj db.ts i nacrtaj veze između tabela.
Dan 3: pročitaj login i canWrite; objasni autentikaciju i autorizaciju.
Dan 4: promijeni status flow i prilagodi testove.
Dan 5: napravi malu vlastitu funkciju, npr. filter po odgovornoj osobi, kroz UI i API.
Dan 6: simuliraj konflikt iz dva prozora i objasni rollback.
Dan 7: snimi svoj demo od pet minuta bez čitanja ovog dokumenta.

