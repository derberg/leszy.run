# GDPR Compliance Programme — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring leszy.run into full compliance with GDPR + Polish UoŚUDE by shipping public legal pages, consent management with audit trail, self-service data export + soft-delete, retention purges, security hardening, and internal compliance documentation.

**Architecture:** Six workstreams executed in dependency order — F (docs) → C5 (schema) → A (legal pages) → B (consent) → C1-C4 (rights endpoints + UI) → D (retention) → E (security). Each workstream produces an independent, reviewable batch of commits. Backwards-incompatible UX changes are gated behind the new policy version, so feature flagging is unnecessary.

**Tech Stack:** Plain JS only (no TypeScript). Supabase (Postgres + Edge Functions + Auth) for server-side, React + Vite for the public frontend, Drizzle for local Postgres, Vercel for hosting. Tests use the existing patterns: `supabase/functions/tests/*.test.js` (Deno test) for edge functions, `public/tests/e2e/*.spec.js` (Playwright) for UI.

**Spec reference:** [docs/superpowers/specs/2026-06-03-gdpr-compliance-design.md](docs/superpowers/specs/2026-06-03-gdpr-compliance-design.md)

---

## Prerequisites (do once before starting)

- [ ] **P1. Branch setup.** Decide whether to land this on the current `feat/auth-profiles-contributions-badges` branch or a sibling `feat/gdpr-compliance` branched off `main`. Recommendation: sibling branch so the auth work can ship independently. To create:

```bash
git checkout main
git pull
git checkout -b feat/gdpr-compliance
```

- [ ] **P2. Pull a fresh Supabase backup before any DDL.** Per [docs/scrapers.md](docs/scrapers.md) the backup recipe is:

```bash
mkdir -p ~/backups/leszyrun && \
  f=~/backups/leszyrun/supabase_$(date +%Y%m%d_%H%M).dump && \
  set -a && source /Users/derberg/Documents/GitHub/BeepBeep/.env && set +a && \
  PGPASSWORD=$(python3 -c "
import re, urllib.parse, os
url = os.environ.get('SUPABASE_DB_URL', '')
m = re.search(r'://[^:]+:([^@]+)@', url)
if not m: raise SystemExit('no password in SUPABASE_DB_URL')
print(urllib.parse.unquote(m.group(1)), end='')
") && \
  docker run --rm -e PGPASSWORD="$PGPASSWORD" postgres:17 \
    pg_dump --host=aws-1-eu-west-1.pooler.supabase.com --port=5432 \
            --username=postgres.kojoxazlnxncrpxmnxiq --dbname=postgres \
            --format=custom --verbose --no-owner --no-privileges > "$f" && \
  ls -lh "$f"
```

- [ ] **P3. Confirm `lukasz@leszy.run` alias works.** Send a test email to that address from any account, confirm receipt. If it doesn't exist yet, set up the forwarding rule in the domain registrar before Workstream A goes to production.

---

## Workstream F — Internal documentation (docs/gdpr/)

Pure-text files. No tests. Each file is one commit.

### Task F1: Create the `docs/gdpr/` directory and add DPA checklist to `.gitignore`

**Files:**
- Modify: [.gitignore](.gitignore)

- [ ] **Step 1: Read current `.gitignore` to find the right insertion point**

```bash
head -30 .gitignore
```

- [ ] **Step 2: Add gitignore entry for the DPA checklist**

Append this line to `.gitignore` (group with other doc/log ignores if such a section exists):

```
docs/gdpr/dpa-checklist.md
```

- [ ] **Step 3: Verify the ignore is active**

```bash
mkdir -p docs/gdpr
touch docs/gdpr/dpa-checklist.md
git status --short docs/gdpr/dpa-checklist.md
```

Expected: no output (the file is ignored).

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(gdpr): ignore docs/gdpr/dpa-checklist.md from VCS"
```

---

### Task F2: Write ROPA (Rejestr Czynności Przetwarzania)

**Files:**
- Create: [docs/gdpr/ropa.md](docs/gdpr/ropa.md)

- [ ] **Step 1: Create the ROPA file**

Create `docs/gdpr/ropa.md` with this structure (Polish, formal register). One section per processing activity. Each section MUST contain all eight subfields below.

```markdown
# Rejestr Czynności Przetwarzania (ROPA) — Leszy.run

**Administrator:** Łukasz Górnicki, prowadzący serwis Leszy.run
**Kontakt:** lukasz@leszy.run
**Data ostatniej aktualizacji:** 2026-06-04
**Wersja:** 1.0

## Rola Leszy.run

Leszy.run / Łukasz Górnicki jest **jedynym administratorem (controller)** dla wszystkich czynności wymienionych poniżej. Nie występują relacje wspólnego administrowania (joint controllership) ani relacje powierzenia danych (processor) z organizatorami biegów. Organizatorzy są **źródłem danych** — administrowanie przechodzi na Leszy.run w momencie zaimportowania listy startowej.

## 1. Rejestracja i prowadzenie kont użytkowników

- **Cel:** Umożliwienie użytkownikom zakładania kont, edycji profili, śledzenia własnej aktywności biegowej.
- **Podstawa prawna:** Art. 6(1)(b) RODO — wykonanie umowy o świadczenie usług elektronicznych.
- **Kategorie danych:** email, username, display_name, telefon (opcjonalnie), data urodzenia, płeć, miasto, województwo, klub.
- **Kategorie osób:** zarejestrowani użytkownicy serwisu Leszy.run (osoby fizyczne).
- **Odbiorcy:** Supabase, Inc. (hosting bazy danych); SendGrid (dostarczanie emaili transakcyjnych).
- **Transfery poza EOG:** Supabase i SendGrid mogą przetwarzać dane w USA pod EU Standard Contractual Clauses.
- **Okres przechowywania:** bezterminowo, aż do żądania usunięcia konta przez użytkownika (soft delete).
- **Środki bezpieczeństwa:** szyfrowanie at-rest (Supabase), RLS (Row-Level Security), uwierzytelnianie magic-link OTP, rate limiting na endpointach OTP, audit log działań administracyjnych.

## 2. Pomiar czasu w biegach

- **Cel:** Pomiar czasu uczestników biegów organizowanych przez organizatorów współpracujących z Leszy.run, publikacja wyników w archiwum sportowym.
- **Podstawa prawna:** Art. 6(1)(f) RODO — uzasadniony interes administratora (świadczenie usługi pomiaru czasu, prowadzenie archiwum sportowego, weryfikowalność wyników).
- **Kategorie danych:** imię, nazwisko, numer startowy, kategoria, tag RFID, telefon (opcjonalnie do SMS check-in), email (opcjonalnie), surowe odczyty bramek (gate_events), potwierdzenia przejść, wyniki.
- **Kategorie osób:** uczestnicy biegów zaimportowani z list startowych organizatorów (w tym małoletni — patrz DPIA).
- **Odbiorcy:** Supabase, Inc. (baza danych), Vercel (serwowanie publicznych wyników).
- **Transfery poza EOG:** jak w pkt 1.
- **Okres przechowywania:** dane uczestników i wyniki — bezterminowo (archiwum sportowe); surowe `gate_events` i `gate_crossings` — 90 dni od zakończenia biegu (purge automatyczny).
- **Środki bezpieczeństwa:** jak w pkt 1; dodatkowo automatyczna anonimizacja danych uczestnika w wynikach po usunięciu konta (jeśli uczestnik miał konto).

## 3. SMS check-in

- **Cel:** Wysyłanie wiadomości SMS z linkiem do potwierdzenia obecności na starcie biegu.
- **Podstawa prawna:** Art. 6(1)(b) RODO — wykonanie umowy z uczestnikiem (gdy podał numer telefonu organizatorowi w celu otrzymania SMS).
- **Kategorie danych:** numer telefonu, znaczniki czasowe wysyłki, treść wiadomości (kod check-in), status dostarczenia.
- **Kategorie osób:** uczestnicy biegów, którzy podali numer telefonu organizatorowi.
- **Odbiorcy:** SMSAPI sp. z o.o. (Polska) jako podmiot przetwarzający SMS.
- **Transfery poza EOG:** brak (SMSAPI przetwarza dane w Polsce).
- **Okres przechowywania:** bezterminowo, do usunięcia konta lub wniosku osoby.
- **Środki bezpieczeństwa:** szyfrowane API SMSAPI, klucze API w secret store (env vars), brak logowania pełnej treści wiadomości w logach aplikacji.

## 4. Wkłady społecznościowe (zgłoszenia wydarzeń, recenzje, treści użytkowników)

- **Cel:** Umożliwienie użytkownikom zgłaszania nowych wydarzeń biegowych, edycji i recenzowania treści serwisu.
- **Podstawa prawna:** Art. 6(1)(b) RODO — wykonanie umowy o świadczenie usług; Art. 6(1)(f) — uzasadniony interes (moderacja treści).
- **Kategorie danych:** ID użytkownika, treść zgłoszenia, znaczniki czasowe, decyzja moderatora.
- **Kategorie osób:** zarejestrowani użytkownicy serwisu.
- **Odbiorcy:** Supabase.
- **Transfery poza EOG:** jak w pkt 1.
- **Okres przechowywania:** bezterminowo (część archiwum społeczności); anonimizowane przy usunięciu konta.
- **Środki bezpieczeństwa:** RLS, audit log działań moderacyjnych.

## 5. Agregacja kalendarza biegów (scrapery)

- **Cel:** Gromadzenie informacji o publicznie ogłaszanych wydarzeniach biegowych w Polsce.
- **Podstawa prawna:** Art. 6(1)(f) — uzasadniony interes (informowanie społeczności biegowej o wydarzeniach), z zastrzeżeniem, że Leszy.run nie przetwarza danych osobowych z tych źródeł — gromadzone są wyłącznie informacje o samych wydarzeniach (nazwa, data, miejsce, dystanse, link).
- **Kategorie danych:** brak danych osobowych. Wyłącznie publiczne metadane wydarzeń.
- **Kategorie osób:** N/D.
- **Odbiorcy:** Supabase, Vercel.
- **Transfery poza EOG:** jak w pkt 1.
- **Okres przechowywania:** bezterminowo (kalendarz historyczny).
- **Środki bezpieczeństwa:** N/D dla danych osobowych.

## 6. Analityka strony WWW (Google Analytics 4)

- **Cel:** Statystyki ruchu, optymalizacja serwisu.
- **Podstawa prawna:** Art. 6(1)(a) RODO — zgoda wyrażona w banerze cookie.
- **Kategorie danych:** adres IP (anonimizowany przez GA4), zdarzenia nawigacji, identyfikator klienta cookie, dane urządzenia (przeglądarka, system operacyjny, rozdzielczość).
- **Kategorie osób:** odwiedzający stronę, którzy wyrazili zgodę.
- **Odbiorcy:** Google Ireland Ltd. (przetwarzanie w UE i USA pod EU SCC).
- **Transfery poza EOG:** USA pod EU SCC.
- **Okres przechowywania:** 14 miesięcy w GA4 (skonfigurowane w panelu GA).
- **Środki bezpieczeństwa:** brak ładowania skryptu GA do momentu wyrażenia zgody, automatyczne czyszczenie cookies GA przy odmowie/wycofaniu zgody.

## 7. Komunikacja transakcyjna (email)

- **Cel:** Wysyłanie kodów OTP (logowanie, potwierdzenie usunięcia konta), powiadomień systemowych.
- **Podstawa prawna:** Art. 6(1)(b) RODO — wykonanie umowy o świadczenie usług.
- **Kategorie danych:** email, treść wiadomości, znaczniki czasowe.
- **Kategorie osób:** zarejestrowani użytkownicy serwisu.
- **Odbiorcy:** Twilio / SendGrid (USA pod EU SCC).
- **Transfery poza EOG:** USA pod EU SCC.
- **Okres przechowywania:** logi SendGrid zgodnie z polityką SendGrid (30 dni).
- **Środki bezpieczeństwa:** wiadomości zawierające kody OTP mają krótki czas ważności; klucz API SendGrid w secret store.

## Historia zmian

| Wersja | Data | Opis |
|---|---|---|
| 1.0 | 2026-06-04 | Pierwsza wersja ROPA — wdrożenie programu zgodności GDPR. |
```

- [ ] **Step 2: Commit**

```bash
git add docs/gdpr/ropa.md
git commit -m "docs(gdpr): add ROPA (Rejestr Czynności Przetwarzania)"
```

---

### Task F3: Write breach response runbook

**Files:**
- Create: [docs/gdpr/breach-response.md](docs/gdpr/breach-response.md)

- [ ] **Step 1: Create the breach response file**

Create `docs/gdpr/breach-response.md` with this content:

```markdown
# Procedura reagowania na naruszenie ochrony danych osobowych

**Wersja:** 1.0
**Data:** 2026-06-04
**Odpowiedzialny:** Łukasz Górnicki, lukasz@leszy.run

## 1. Definicja naruszenia

Naruszenie ochrony danych osobowych (art. 4 pkt 12 RODO) to każde zdarzenie prowadzące do:
- przypadkowego lub niezgodnego z prawem zniszczenia danych,
- utraty danych (np. awaria nośnika bez backupu),
- modyfikacji danych bez upoważnienia,
- nieuprawnionego ujawnienia danych (wyciek),
- nieuprawnionego dostępu do danych.

Przykłady dla Leszy.run:
- nieautoryzowany dostęp do bazy Supabase (np. wyciek service_role key),
- atak przez aplikację webową (XSS, SQL injection) ujawniający dane,
- błąd w RLS udostępniający dane prywatne publicznie,
- zgubione/skradzione urządzenie z dostępem do panelu admin,
- atak na konto Vercel / GitHub z dostępem do kodu i secretów.

## 2. Wykrycie i triage (do 1 godziny)

Po wykryciu sygnału naruszenia:
1. Zapisz znacznik czasu wykrycia.
2. Określ wstępny zakres: które dane / ile osób / które systemy.
3. Zatrzymaj propagację — odetnij dostęp atakującego (rotacja kluczy, blokada konta).
4. NIE usuwaj logów ani dowodów — będą potrzebne w analizie.

## 3. Ocena ryzyka (do 24 godzin)

Kryteria oceny:
- **Rodzaj danych:** zwykłe vs. szczególnie chronione (np. dane dzieci, biometria → wysokie ryzyko)
- **Liczba osób:** pojedyncze vs. masowe
- **Łatwość identyfikacji:** anonimowe vs. bezpośrednio identyfikujące
- **Możliwe konsekwencje:** szkoda materialna, reputacyjna, kradzież tożsamości

Wynik oceny: NISKIE / ŚREDNIE / WYSOKIE ryzyko.

## 4. Decyzja o notyfikacji UODO (Art. 33 RODO)

**Wymagana,** gdy ryzyko nie jest oczywiście niskie. W razie wątpliwości — notyfikuj.

**Termin:** 72 godziny od wykrycia. Zegar liczy się od momentu, gdy administrator dowiedział się o naruszeniu.

**Forma:** formularz online na https://uodo.gov.pl/pl/p/zgloszenia lub email na zgloszenia@uodo.gov.pl.

**Wymagana treść zgłoszenia (Art. 33(3)):**
- charakter naruszenia (co się stało, kiedy, gdzie),
- kategorie i przybliżona liczba osób,
- kategorie i przybliżona liczba rekordów,
- dane kontaktowe administratora,
- prawdopodobne konsekwencje,
- środki zastosowane i planowane.

Jeśli nie wszystkie dane dostępne w 72h — zgłoś co jest znane, uzupełnij później (Art. 33(4)).

## 5. Notyfikacja osób, których dane dotyczą (Art. 34 RODO)

Wymagana, gdy naruszenie **może powodować wysokie ryzyko** dla praw i wolności osób.

Forma: jasny, prosty język — email lub komunikat w serwisie.

Szablon:

> Tytuł: Ważna informacja o bezpieczeństwie Twoich danych w Leszy.run
>
> Szanowna/y Pani/Panie,
>
> w dniu [DATA] wystąpiło zdarzenie polegające na [OPIS NARUSZENIA]. Zostały ujawnione/zmodyfikowane następujące dane: [LISTA].
>
> Możliwe konsekwencje: [LISTA].
>
> Podjęte działania: [LISTA].
>
> Zalecenia dla Pani/Pana: [LISTA — np. zmiana hasła, monitoring konta].
>
> W razie pytań — lukasz@leszy.run lub +48 [telefon].
>
> Mają Państwo prawo wniesienia skargi do Prezesa UODO (https://uodo.gov.pl).

## 6. Mitygacja techniczna

Lista czynności do wykonania (dostosować do typu incydentu):
- [ ] Rotacja `SUPABASE_SERVICE_ROLE_KEY` w panelu Supabase
- [ ] Rotacja `SENDGRID_API_KEY`, `SMSAPI_TOKEN`, `BRAVE_SEARCH_API_KEY`
- [ ] Rotacja sekretów GitHub Actions / Vercel
- [ ] Wymuszone wylogowanie wszystkich sesji (Supabase: signOut all)
- [ ] Audyt logów Supabase + Vercel + GitHub (kto, kiedy, skąd)
- [ ] Wymuszenie 2FA na koncie Supabase/Vercel/GitHub (jeśli wyłączone)
- [ ] Sprawdzenie polityk RLS pod kątem ewentualnej luki
- [ ] Aktualizacja CSP / nagłówków bezpieczeństwa, jeśli incydent wskazał ich braki

## 7. Post-mortem (w ciągu tygodnia)

Plik: `docs/gdpr/incidents/YYYY-MM-DD-<nazwa>.md` (gitignored).

Treść:
1. Co się stało (timeline)
2. Jak wykryto
3. Jak naprawiono
4. Co należy zmienić, by się nie powtórzyło
5. Lekcje + zmiany w procedurze
6. Aktualizacja ROPA / polityki, jeśli wymagana

## 8. Kontakty awaryjne

| Kogo | Po co | Kontakt |
|---|---|---|
| UODO (zgłoszenie) | Notyfikacja w 72h | zgloszenia@uodo.gov.pl, https://uodo.gov.pl |
| Supabase Security | Naruszenie po stronie infrastruktury | security@supabase.com |
| Vercel Security | Naruszenie hostingu | security@vercel.com |
| Łukasz Górnicki | Decyzje | lukasz@leszy.run |
```

- [ ] **Step 2: Commit**

```bash
git add docs/gdpr/breach-response.md
git commit -m "docs(gdpr): add breach response runbook"
```

---

### Task F4: Write DPIA for participant data

**Files:**
- Create: [docs/gdpr/dpia-participants.md](docs/gdpr/dpia-participants.md)

- [ ] **Step 1: Create the DPIA file**

Create `docs/gdpr/dpia-participants.md` with this content:

```markdown
# Ocena skutków dla ochrony danych (DPIA) — Dane uczestników biegów

**Wersja:** 1.0
**Data:** 2026-06-04
**Administrator:** Łukasz Górnicki, lukasz@leszy.run
**Podstawa wymogu:** Art. 35 RODO — przetwarzanie wysokiego ryzyka.

## 1. Opis przetwarzania

### Co jest przetwarzane
- Dane identyfikacyjne uczestników: imię, nazwisko, numer startowy, kategoria wiekowa
- Dane kontaktowe: telefon (opcjonalnie), email (opcjonalnie)
- Dane biometryczne *pośrednio*: tag RFID przypisany do osoby
- Dane lokalizacyjno-czasowe: czas przejścia bramek pomiarowych (start, meta, checkpointy)
- Dane szczególnej kategorii (Art. 9): nie są przetwarzane bezpośrednio. Jednak dane o sprawności fizycznej mogą być pośrednio wnioskowane z czasów (np. „uczestnik nie ukończył biegu po 5km — możliwy stan zdrowia").

### Dla kogo
- Dorośli uczestnicy biegów (większość)
- **Małoletni uczestnicy** (biegi z flagą `is_kids = true` — kilkanaście wydarzeń rocznie) — kategoria wysokiego ryzyka

### Cel
- Pomiar czasu zawodników
- Publikacja wyników w archiwum biegów (leszy.run/results)
- Weryfikowalność wyników w razie sporu

### Podstawa prawna
Art. 6(1)(f) RODO — uzasadniony interes administratora.

## 2. Konieczność i proporcjonalność

| Pole | Czy niezbędne? | Uzasadnienie / alternatywy odrzucone |
|---|---|---|
| Imię, nazwisko | TAK | Identyfikacja w wynikach. Alternatywa (tylko pseudonim) nieakceptowalna dla zawodów oficjalnych. |
| Numer startowy | TAK | Backup identyfikacji, gdy RFID zawodzi. |
| Kategoria wiekowa | TAK | Klasyfikacja wyników. Konkretna data urodzenia wymagana do automatycznego ustalenia. |
| Tag RFID | TAK | Sam pomiar czasu. |
| Telefon | OPCJONALNE | SMS check-in. Może być pominięty. |
| Email | OPCJONALNE | Komunikacja z uczestnikiem o evencie. |
| Czasy przejść (gate_events) | TAK ZA ŻYCIA BIEGU | Surowe dane potrzebne do weryfikacji. Po 90 dniach purgowane — pozostają tylko agregaty (results). |

Konkluzja: zbiór danych jest minimalny dla zrealizowania celu.

## 3. Identyfikacja ryzyk

| Ryzyko | Prawdopodobieństwo | Skutek | Poziom |
|---|---|---|---|
| Wyciek bazy → ujawnienie listy startowej dziecka + lokalizacji biegu | NISKIE (RLS, szyfrowanie) | WYSOKI (bezpieczeństwo dziecka) | ŚREDNI |
| Wyciek bazy → ujawnienie szczegółowych czasów → wnioskowanie o stanie zdrowia | NISKIE | ŚREDNI | NISKI-ŚREDNI |
| Atak na konto admin → masowy eksport danych | NISKIE (2FA, audit log) | WYSOKI | ŚREDNI |
| Błąd w `get-profile-data` ujawniający pełne dane | ŚREDNIE (do mitygacji w E4) | ŚREDNI | ŚREDNI |
| Uczestnik nie wiedział, że jego dane trafiły do Leszy.run | ŚREDNIE | NISKI (prawo sprzeciwu) | NISKI |

## 4. Środki mitygacji

- **Szyfrowanie at-rest:** wszystkie dane w Supabase szyfrowane (AES-256).
- **RLS:** każda tabela z PII ma polityki Row-Level Security, audytowane (Workstream E5).
- **Retencja:** surowe `gate_events` purgowane po 90 dniach (Workstream D).
- **Kontrola dostępu:** lista adminów oparta o env var `ADMIN_USER_IDS`, audyt każdego działania administracyjnego (Workstream E3).
- **OTP rate limit:** ograniczenie brute-force / enumeracji (Workstream E2).
- **CSP + nagłówki bezpieczeństwa:** ochrona przed XSS, clickjacking (Workstream E1).
- **Prawo sprzeciwu:** uczestnik może zażądać anonimizacji w wynikach przez kontakt `lukasz@leszy.run` — soft delete w `participants`.
- **Polityka prywatności:** transparentność wobec uczestników o tym, że ich dane trafiły do Leszy.run.

## 5. Pozostałe ryzyko po mitygacji

**Niskie, akceptowalne.** Główne pozostałe ryzyko to atak na infrastrukturę Supabase — częściowo poza kontrolą administratora; mitygowane przez wybór dostawcy z rygorystycznymi standardami (SOC 2, ISO 27001).

## 6. Konsultacja z osobami, których dane dotyczą

Nie przeprowadzono formalnej konsultacji. Otwarty kanał kontaktu (lukasz@leszy.run) służy zbieraniu uwag.

## 7. Decyzja administratora

Przetwarzanie spełnia warunki Art. 6(1)(f) RODO przy zastosowanych środkach mitygacji. **Zatwierdzono do wdrożenia.**

Podpis: Łukasz Górnicki, 2026-06-04

## 8. Plan przeglądu

DPIA podlega przeglądowi:
- co najmniej raz na 12 miesięcy,
- przy każdej istotnej zmianie zakresu przetwarzania (nowa kategoria danych, nowy procesor, zmiana podstawy prawnej),
- po każdym incydencie naruszenia danych.
```

- [ ] **Step 2: Commit**

```bash
git add docs/gdpr/dpia-participants.md
git commit -m "docs(gdpr): add DPIA for participant data"
```

---

### Task F5: Write DPA checklist (gitignored, operator-only)

**Files:**
- Create: `docs/gdpr/dpa-checklist.md` (will not be tracked by git per F1)

- [ ] **Step 1: Create the checklist file**

```markdown
# DPA Checklist — Operator action items

> This file is git-ignored (see `.gitignore`). It tracks personal action items
> for the operator. Update as items are completed.

## Email + identity

- [ ] Confirm `lukasz@leszy.run` mailbox / forwarding works (test send + receive)
- [ ] Add `lukasz@leszy.run` to password manager
- [ ] Set up daily inbox check reminder

## Processor DPAs (sign / accept)

- [ ] Supabase — accept DPA in dashboard (Settings → Legal)
- [ ] Vercel — accept DPA in dashboard (Settings → Security & Privacy)
- [ ] SMSAPI sp. z o.o. — request DPA via panel.smsapi.pl, sign and store PDF
- [ ] Twilio / SendGrid — accept Twilio MSA in account settings
- [ ] Google Ireland Ltd. — accept GA4 Data Processing Terms in GA admin

## Provider configuration

- [ ] GA4: set data retention to 14 months (Admin → Data Settings → Data Retention)
- [ ] GA4: confirm IP anonymization is ON (default in GA4, but verify)
- [ ] GA4: turn OFF Google Signals (Admin → Data Settings → Data Collection)
- [ ] Supabase: enable 2FA on operator account
- [ ] Vercel: enable 2FA on operator account
- [ ] GitHub: enable 2FA + signed commits

## Operational

- [ ] Confirm backup recipe in [docs/scrapers.md](docs/scrapers.md) works end-to-end
- [ ] Schedule weekly inbox check for `lukasz@leszy.run` (data subject requests)
- [ ] Add `lukasz@leszy.run` to monitoring / alerting destinations
```

- [ ] **Step 2: Verify the file is ignored**

```bash
git status --short docs/gdpr/dpa-checklist.md
```

Expected: no output.

- [ ] **Step 3: No commit needed** — the file is ignored. Continue.

---

## Workstream C5 — Schema (deleted_at columns)

Schema must land BEFORE C1-C4 implementations. Two migrations: local Drizzle + Supabase.

### Task C5a: Add `deleted_at` to local `participants` table

**Files:**
- Modify: [backend/src/db/schema.js](backend/src/db/schema.js) (around line 56)
- Create: `backend/src/db/migrations/NNNN_soft_delete.sql` (NNNN = next sequence number; check existing migrations)
- Modify: [backend/src/db/migrations/meta/_journal.json](backend/src/db/migrations/meta/_journal.json)

- [ ] **Step 1: Determine the next migration number**

```bash
ls backend/src/db/migrations/*.sql | sort | tail -3
```

Expected: shows the latest 3 migrations. Use next number (e.g. if last is `0017_*.sql`, new is `0018_soft_delete.sql`).

- [ ] **Step 2: Write the migration SQL**

Create `backend/src/db/migrations/<NNNN>_soft_delete.sql`:

```sql
ALTER TABLE participants ADD COLUMN deleted_at timestamptz;
CREATE INDEX participants_deleted_at_idx ON participants (deleted_at) WHERE deleted_at IS NULL;
```

(The partial index supports fast "active participants" queries.)

- [ ] **Step 3: Register the migration in the journal**

Open [backend/src/db/migrations/meta/_journal.json](backend/src/db/migrations/meta/_journal.json), find the `"entries"` array, and append:

```json
{
  "idx": <NNNN-as-integer>,
  "version": "7",
  "when": <current-unix-ms-timestamp>,
  "tag": "<NNNN>_soft_delete",
  "breakpoints": true
}
```

(Use `date +%s%3N` on macOS to get the timestamp.)

- [ ] **Step 4: Add the column to the Drizzle schema**

In [backend/src/db/schema.js](backend/src/db/schema.js), inside the `participants` pgTable definition (around line 56, between `syncedAt` and the closing `}`), add:

```js
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
```

- [ ] **Step 5: Restart the backend container to apply the migration**

```bash
docker compose restart backend
docker compose logs backend --tail 30
```

Expected: log line "Migrations complete" or similar, no errors.

- [ ] **Step 6: Verify the column exists in local DB**

```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun -c "\d participants" | grep deleted_at
```

Expected: `deleted_at | timestamp with time zone |`

- [ ] **Step 7: Commit**

```bash
git add backend/src/db/migrations/<NNNN>_soft_delete.sql backend/src/db/migrations/meta/_journal.json backend/src/db/schema.js
git commit -m "feat(gdpr): add deleted_at to participants for soft delete"
```

---

### Task C5b: Add `deleted_at` to Supabase `profiles` and `participants`

**Files:**
- Use Supabase MCP `apply_migration`

- [ ] **Step 1: Apply migration via MCP**

Call `mcp__supabase__apply_migration` with `name = "add_deleted_at_for_soft_delete"` and `query`:

```sql
ALTER TABLE public.profiles ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.participants ADD COLUMN deleted_at timestamptz;
CREATE INDEX profiles_active_idx ON public.profiles (id) WHERE deleted_at IS NULL;
CREATE INDEX participants_active_idx ON public.participants (id) WHERE deleted_at IS NULL;
```

**Wait for user confirmation per [CLAUDE.md](CLAUDE.md) database write safety rule before applying.**

- [ ] **Step 2: Verify**

Call `mcp__supabase__list_tables` and confirm both tables now have `deleted_at`.

- [ ] **Step 3: No git commit** — Supabase-only migrations don't live in repo for now. Note in commit message of next-related task.

---

## Workstream A — Public legal pages

### Task A1: Add the `POLICY_VERSION` constant

**Files:**
- Create: [public/src/lib/policyVersion.js](public/src/lib/policyVersion.js)

- [ ] **Step 1: Create the constant file**

```js
// Single source of truth for the privacy policy version.
// Bump this whenever the policy text changes materially — bumping forces all
// users to re-consent via the cookie banner.
export const POLICY_VERSION = '2026-06-04'
```

- [ ] **Step 2: Commit**

```bash
git add public/src/lib/policyVersion.js
git commit -m "feat(gdpr): add POLICY_VERSION constant"
```

---

### Task A2: Build the Polish privacy policy page

**Files:**
- Create: [public/src/pages/PolitykaPrywatnosci.jsx](public/src/pages/PolitykaPrywatnosci.jsx)

- [ ] **Step 1: Create the page component**

Create `public/src/pages/PolitykaPrywatnosci.jsx`. The full content follows the spec's A1 section (eleven sections). Reproduce it as static JSX. Use existing OVERDRIVE theme classes (`bg-apex-bg`, `text-apex-text`, `font-display`, `font-sans`).

```jsx
import { POLICY_VERSION } from '../lib/policyVersion'

export default function PolitykaPrywatnosci() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-bright">Polityka prywatności</h1>
        <p className="mt-2 text-sm text-apex-muted">Wersja {POLICY_VERSION}</p>
      </header>

      <section id="administrator">
        <h2 className="font-display text-2xl uppercase">1. Administrator danych osobowych</h2>
        <p className="mt-3">Łukasz Górnicki, prowadzący serwis Leszy.run. Kontakt: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
        <p className="mt-3"><strong>Leszy.run jest administratorem danych osobowych przetwarzanych w serwisie — niezależnie od tego, czy zostały podane bezpośrednio przy rejestracji konta, czy pozyskane od organizatora biegu przy imporcie listy startowej.</strong> Organizator biegu pozostaje administratorem danych w swoim własnym systemie zapisów, lecz po przekazaniu danych do Leszy.run administratorem tych danych w naszej bazie jest wyłącznie Leszy.run. Wszelkie wnioski (dostęp, usunięcie, sprostowanie, sprzeciw) należy kierować do <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
      </section>

      <section id="zakres" className="mt-8">
        <h2 className="font-display text-2xl uppercase">2. Zakres przetwarzanych danych</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Konto użytkownika:</strong> email, nazwa użytkownika, nazwa wyświetlana, telefon (opcjonalnie), data urodzenia, płeć, miasto, województwo, klub.</li>
          <li><strong>Uczestnik biegu (zaimportowany przez organizatora):</strong> imię, nazwisko, numer startowy, kategoria, tag RFID, telefon (opcjonalnie), email (opcjonalnie).</li>
          <li><strong>Pomiary czasu:</strong> surowe odczyty bramek, potwierdzenia przejść, obserwacje na punktach kontrolnych, wyniki końcowe.</li>
          <li><strong>Check-in:</strong> potwierdzenie akceptacji regulaminu biegu, znaczniki czasowe, dokumenty wymagane.</li>
          <li><strong>Analityka:</strong> pliki cookie Google Analytics 4 — wyłącznie po wyrażeniu zgody.</li>
        </ul>
      </section>

      <section id="cele" className="mt-8">
        <h2 className="font-display text-2xl uppercase">3. Cele i podstawy prawne przetwarzania</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Konto użytkownika:</strong> Art. 6(1)(b) RODO — wykonanie umowy o świadczenie usług elektronicznych.</li>
          <li><strong>Uczestnictwo w biegu (dane od organizatora):</strong> Art. 6(1)(f) RODO — uzasadniony interes Leszy.run (świadczenie usługi pomiaru czasu i prowadzenie archiwum sportowego). Uczestnik może w każdej chwili wnieść sprzeciw — wówczas dane zostaną zanonimizowane.</li>
          <li><strong>Pomiary czasu:</strong> Art. 6(1)(f) RODO — uzasadniony interes (integralność i weryfikowalność wyników).</li>
          <li><strong>Wyniki publiczne i archiwum:</strong> Art. 6(1)(f) RODO — uzasadniony interes (archiwum sportowe, transparentność).</li>
          <li><strong>SMS check-in:</strong> Art. 6(1)(b) RODO — wykonanie umowy.</li>
          <li><strong>Analityka:</strong> Art. 6(1)(a) RODO — zgoda wyrażana w banerze cookie.</li>
        </ul>
      </section>

      <section id="retencja" className="mt-8">
        <h2 className="font-display text-2xl uppercase">4. Okres przechowywania danych</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Dane konta użytkownika:</strong> bezterminowo, do żądania usunięcia konta.</li>
          <li><strong>Surowe odczyty bramek (gate_events, gate_crossings):</strong> 90 dni po zakończeniu biegu (purge automatyczny).</li>
          <li><strong>Wyniki biegu:</strong> bezterminowo (archiwum). Po usunięciu konta — anonimizowane w wynikach (oznaczone jako „Uczestnik anonimowy").</li>
          <li><strong>Logi zgody (consent_log):</strong> bezterminowo (dowód zgody).</li>
          <li><strong>Dane analityczne GA4:</strong> 14 miesięcy (konfiguracja Google).</li>
        </ul>
        <p className="mt-3"><strong>Po usunięciu konta na Leszy.run, ten sam adres email nie może już zostać użyty do ponownej rejestracji.</strong> Jest to celowa polityka — usunięcie konta jest ostateczne i nieodwracalne.</p>
      </section>

      <section id="odbiorcy" className="mt-8">
        <h2 className="font-display text-2xl uppercase">5. Odbiorcy danych</h2>
        <p className="mt-3">Pełna lista podmiotów przetwarzających dane wraz z linkami do ich umów DPA dostępna jest pod adresem: <a href="/podmioty-przetwarzajace" className="text-apex-yellow underline">/podmioty-przetwarzajace</a>.</p>
      </section>

      <section id="prawa" className="mt-8">
        <h2 className="font-display text-2xl uppercase">6. Prawa osoby, której dane dotyczą</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Prawo dostępu (Art. 15):</strong> przycisk „Pobierz moje dane" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo sprostowania (Art. 16):</strong> edycja profilu w <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo usunięcia (Art. 17):</strong> przycisk „Usuń konto" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo ograniczenia przetwarzania (Art. 18):</strong> kontakt <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</li>
          <li><strong>Prawo do przenoszenia danych (Art. 20):</strong> eksport JSON dostępny w <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo sprzeciwu (Art. 21):</strong> kontakt <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</li>
          <li><strong>Cofnięcie zgody:</strong> link „Zarządzaj cookies" w stopce w każdej chwili.</li>
        </ul>
      </section>

      <section id="skarga" className="mt-8">
        <h2 className="font-display text-2xl uppercase">7. Prawo wniesienia skargi do organu nadzorczego</h2>
        <p className="mt-3">Mają Państwo prawo wniesienia skargi do Prezesa Urzędu Ochrony Danych Osobowych (UODO): <a href="https://uodo.gov.pl/pl/p/skargi" className="text-apex-yellow underline" target="_blank" rel="noopener">https://uodo.gov.pl/pl/p/skargi</a>.</p>
      </section>

      <section id="cookies" className="mt-8">
        <h2 className="font-display text-2xl uppercase">8. Pliki cookie</h2>
        <p className="mt-3">Serwis korzysta z dwóch kategorii plików cookie:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Niezbędne</strong> (np. ustawienia motywu, sesja logowania) — używane bez konieczności wyrażenia zgody, na podstawie Art. 6(1)(f) RODO (działanie serwisu).</li>
          <li><strong>Analityczne</strong> (Google Analytics 4) — używane wyłącznie po wyrażeniu zgody w banerze cookie. Zgoda może być cofnięta w każdej chwili przez link „Zarządzaj cookies" w stopce.</li>
        </ul>
      </section>

      <section id="scrapers" className="mt-8">
        <h2 className="font-display text-2xl uppercase">9. Dane o wydarzeniach biegowych</h2>
        <p className="mt-3">Z publicznie dostępnych stron internetowych organizatorów biegów agregujemy wyłącznie informacje o wydarzeniach (nazwa, data, miejsce, dystanse, link do zapisów). <strong>Nie przetwarzamy danych osobowych organizatorów ani uczestników z tych źródeł.</strong></p>
      </section>

      <section id="zmiany" className="mt-8">
        <h2 className="font-display text-2xl uppercase">10. Zmiany polityki</h2>
        <p className="mt-3">Aktualna wersja polityki: <strong>{POLICY_VERSION}</strong>. Historia zmian dostępna jest w repozytorium publicznym: <a href="https://github.com/derberg/BeepBeep/commits/main/public/src/pages/PolitykaPrywatnosci.jsx" className="text-apex-yellow underline" target="_blank" rel="noopener">GitHub</a>.</p>
        <p className="mt-3">Przy istotnych zmianach polityki użytkownicy zostaną poproszeni o ponowne wyrażenie zgody w banerze cookie.</p>
      </section>

      <section id="kontakt" className="mt-8">
        <h2 className="font-display text-2xl uppercase">11. Kontakt</h2>
        <p className="mt-3">Wszystkie pytania dotyczące przetwarzania danych osobowych: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
      </section>
    </article>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/PolitykaPrywatnosci.jsx
git commit -m "feat(gdpr): add Polish privacy policy page (PolitykaPrywatnosci)"
```

---

### Task A3: Build the English mirror

**Files:**
- Create: [public/src/pages/PrivacyPolicy.jsx](public/src/pages/PrivacyPolicy.jsx)

- [ ] **Step 1: Create the page component**

Translate A2 section-by-section into English. Same structure, same `POLICY_VERSION` import, same wording about Leszy.run as sole controller. Use the same JSX structure as A2 but with English copy. (Translation work is mechanical — keep section IDs the same so cross-page anchor links work.)

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/PrivacyPolicy.jsx
git commit -m "feat(gdpr): add English privacy policy mirror"
```

---

### Task A4: Build the Regulamin (ToS) page

**Files:**
- Create: [public/src/pages/Regulamin.jsx](public/src/pages/Regulamin.jsx)

- [ ] **Step 1: Create the page component**

```jsx
import { POLICY_VERSION } from '../lib/policyVersion'

export default function Regulamin() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-bright">Regulamin serwisu Leszy.run</h1>
        <p className="mt-2 text-sm text-apex-muted">Wersja {POLICY_VERSION}</p>
      </header>

      <section>
        <h2 className="font-display text-2xl uppercase">§1. Definicje</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Usługodawca:</strong> Łukasz Górnicki, prowadzący serwis Leszy.run pod adresem www.leszy.run, kontakt: lukasz@leszy.run.</li>
          <li><strong>Serwis:</strong> witryna internetowa Leszy.run wraz z funkcjonalnościami dostępnymi po rejestracji konta.</li>
          <li><strong>Użytkownik:</strong> osoba fizyczna posiadająca konto w Serwisie.</li>
          <li><strong>Konto:</strong> indywidualny profil Użytkownika, identyfikowany adresem email.</li>
          <li><strong>Organizator:</strong> podmiot organizujący zawody biegowe, korzystający z usług pomiaru czasu Usługodawcy.</li>
          <li><strong>Uczestnik:</strong> osoba startująca w zawodach obsługiwanych przez Leszy.run.</li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§2. Warunki świadczenia usług elektronicznych</h2>
        <p className="mt-3">Usługodawca świadczy drogą elektroniczną nieodpłatne usługi obejmujące: rejestrację konta, prezentację kalendarza biegów, prezentację wyników biegów, składanie zgłoszeń wydarzeń i innych wkładów społecznościowych.</p>
        <p className="mt-3">Wymagania techniczne: przeglądarka internetowa z obsługą JavaScript i ciasteczek, aktywne połączenie internetowe.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§3. Rejestracja i konto</h2>
        <p className="mt-3">Rejestracja wymaga podania adresu email i akceptacji niniejszego Regulaminu oraz <a href="/polityka-prywatnosci" className="text-apex-yellow underline">Polityki prywatności</a>.</p>
        <p className="mt-3">Konto może posiadać wyłącznie osoba pełnoletnia. Konta osób małoletnich mogą być zakładane wyłącznie przez ich opiekunów prawnych.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§4. Zasady korzystania</h2>
        <p className="mt-3">Użytkownik zobowiązuje się do:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>nieumieszczania treści bezprawnych, obraźliwych lub naruszających dobra osobiste innych osób,</li>
          <li>niepodejmowania działań mogących zakłócić działanie Serwisu (np. ataki, scraping z nadmierną częstotliwością),</li>
          <li>podawania prawdziwych danych przy rejestracji,</li>
          <li>nieudostępniania konta osobom trzecim.</li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§5. Reklamacje</h2>
        <p className="mt-3">Reklamacje dotyczące działania Serwisu należy zgłaszać na adres <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>. Reklamacja zostanie rozpatrzona w terminie 28 dni od daty zgłoszenia.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§6. Rozwiązanie umowy</h2>
        <p className="mt-3">Użytkownik może w każdej chwili usunąć konto przez funkcjonalność „Usuń konto" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>. Usunięcie konta jest nieodwracalne — tego samego adresu email nie da się ponownie wykorzystać do rejestracji.</p>
        <p className="mt-3">Usługodawca może rozwiązać umowę z Użytkownikiem w przypadku rażącego naruszenia Regulaminu, po uprzednim wezwaniu do zaprzestania naruszeń.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§7. Prawo właściwe i sąd właściwy</h2>
        <p className="mt-3">Prawem właściwym dla niniejszego Regulaminu jest prawo polskie. Sądem właściwym jest sąd właściwy miejscowo dla siedziby Usługodawcy.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§8. Postanowienia końcowe</h2>
        <p className="mt-3">Regulamin wchodzi w życie z dniem {POLICY_VERSION}. Usługodawca może zmieniać Regulamin — o zmianach Użytkownicy będą informowani z 14-dniowym wyprzedzeniem przez komunikat w Serwisie.</p>
      </section>
    </article>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/Regulamin.jsx
git commit -m "feat(gdpr): add Regulamin serwisu (Terms of Service)"
```

---

### Task A5: Build the processor inventory page

**Files:**
- Create: [public/src/pages/PodmiotyPrzetwarzajace.jsx](public/src/pages/PodmiotyPrzetwarzajace.jsx)

- [ ] **Step 1: Create the page**

```jsx
const PROCESSORS = [
  { name: 'Supabase, Inc.', country: 'USA (EU SCC)', purpose: 'Baza danych, autentykacja, Edge Functions, Storage', dpa: 'https://supabase.com/legal/dpa' },
  { name: 'Vercel, Inc.', country: 'USA (EU SCC)', purpose: 'Hosting frontendu, CDN, serverless funkcje', dpa: 'https://vercel.com/legal/dpa' },
  { name: 'SMSAPI sp. z o.o.', country: 'Polska', purpose: 'Wysyłka wiadomości SMS check-in', dpa: 'https://www.smsapi.pl/dokumenty-prawne' },
  { name: 'Twilio Inc. / SendGrid', country: 'USA (EU SCC)', purpose: 'Wysyłka wiadomości email', dpa: 'https://www.twilio.com/legal/data-protection-addendum' },
  { name: 'Google Ireland Ltd.', country: 'Irlandia / USA (EU SCC)', purpose: 'Analityka GA4 (tylko po wyrażeniu zgody)', dpa: 'https://support.google.com/analytics/answer/9012600' },
  { name: 'Google Fonts (CDN)', country: 'Globalnie', purpose: 'Renderowanie czcionek', dpa: '—' },
]

export default function PodmiotyPrzetwarzajace() {
  return (
    <article className="mx-auto max-w-4xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-bright">Podmioty przetwarzające</h1>
        <p className="mt-3">Lista podmiotów, z którymi współpracujemy w zakresie przetwarzania danych osobowych. Każdy z nich działa w oparciu o własną umowę powierzenia (DPA) zgodną z RODO.</p>
      </header>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-apex-border">
            <th className="py-2 text-left font-display uppercase">Podmiot</th>
            <th className="py-2 text-left font-display uppercase">Lokalizacja</th>
            <th className="py-2 text-left font-display uppercase">Cel</th>
            <th className="py-2 text-left font-display uppercase">DPA</th>
          </tr>
        </thead>
        <tbody>
          {PROCESSORS.map(p => (
            <tr key={p.name} className="border-b border-apex-border">
              <td className="py-3 font-semibold">{p.name}</td>
              <td className="py-3">{p.country}</td>
              <td className="py-3">{p.purpose}</td>
              <td className="py-3">{p.dpa.startsWith('http') ? <a href={p.dpa} target="_blank" rel="noopener" className="text-apex-yellow underline">DPA</a> : p.dpa}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-8 text-sm text-apex-muted">Aktualizowane wraz ze zmianami w infrastrukturze. Pytania: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
    </article>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/PodmiotyPrzetwarzajace.jsx
git commit -m "feat(gdpr): add processor inventory page"
```

---

### Task A6: Build the Footer component with cookies-reopen link

**Files:**
- Create: [public/src/components/Footer.jsx](public/src/components/Footer.jsx)

- [ ] **Step 1: Create the component**

```jsx
export default function Footer() {
  function openCookieBanner() {
    window.dispatchEvent(new CustomEvent('leszy:cookies:open'))
  }

  return (
    <footer className="mt-12 border-t border-apex-border bg-apex-surface px-4 py-6 text-sm text-apex-muted">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>© Leszy.run {new Date().getFullYear()}</p>
        <nav className="flex flex-wrap gap-x-4 gap-y-1">
          <a href="/polityka-prywatnosci" className="hover:text-apex-yellow">Polityka prywatności</a>
          <a href="/regulamin" className="hover:text-apex-yellow">Regulamin</a>
          <a href="/podmioty-przetwarzajace" className="hover:text-apex-yellow">Podmioty przetwarzające</a>
          <button type="button" onClick={openCookieBanner} className="text-left hover:text-apex-yellow">Zarządzaj cookies</button>
        </nav>
      </div>
    </footer>
  )
}
```

- [ ] **Step 2: Add Footer to App layout**

In [public/src/App.jsx](public/src/App.jsx), find the main layout component (the one that wraps `<Routes>`), import Footer, and place `<Footer />` at the bottom of the layout JSX. Exact location depends on current structure — read the file to confirm.

- [ ] **Step 3: Commit**

```bash
git add public/src/components/Footer.jsx public/src/App.jsx
git commit -m "feat(gdpr): footer with legal links and cookie preferences"
```

---

### Task A7: Wire the four legal pages into routing

**Files:**
- Modify: [public/src/App.jsx](public/src/App.jsx)

- [ ] **Step 1: Read current App.jsx routes**

```bash
grep -n "Route " public/src/App.jsx | head -30
```

- [ ] **Step 2: Add four routes**

Import the new pages at the top:

```jsx
import PolitykaPrywatnosci from './pages/PolitykaPrywatnosci'
import PrivacyPolicy from './pages/PrivacyPolicy'
import Regulamin from './pages/Regulamin'
import PodmiotyPrzetwarzajace from './pages/PodmiotyPrzetwarzajace'
```

Add inside the `<Routes>` block (anywhere; order doesn't matter for these):

```jsx
<Route path="/polityka-prywatnosci" element={<PolitykaPrywatnosci />} />
<Route path="/privacy-policy" element={<PrivacyPolicy />} />
<Route path="/regulamin" element={<Regulamin />} />
<Route path="/podmioty-przetwarzajace" element={<PodmiotyPrzetwarzajace />} />
```

- [ ] **Step 3: Smoke test**

Start the public dev server:

```bash
cd public && npx vite --port 3002
```

In the browser, visit:
- http://localhost:3002/polityka-prywatnosci
- http://localhost:3002/privacy-policy
- http://localhost:3002/regulamin
- http://localhost:3002/podmioty-przetwarzajace

Confirm: each page renders, no console errors, footer appears.

- [ ] **Step 4: Commit**

```bash
git add public/src/App.jsx
git commit -m "feat(gdpr): route legal pages"
```

---

### Task A8: Pre-render legal pages for SEO

**Files:**
- Create: [public/scripts/generate-legal-pages.js](public/scripts/generate-legal-pages.js)
- Modify: [public/package.json](public/package.json) (build script)

- [ ] **Step 1: Create the generator script**

Pattern after [public/scripts/generate-landing-pages.js](public/scripts/generate-landing-pages.js). Read that file first to understand the existing pattern.

```bash
cat public/scripts/generate-landing-pages.js | head -60
```

Then create `public/scripts/generate-legal-pages.js`:

```js
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist')

const PAGES = [
  {
    slug: 'polityka-prywatnosci',
    title: 'Polityka prywatności — Leszy.run',
    description: 'Polityka prywatności serwisu Leszy.run — jak przetwarzamy Twoje dane osobowe zgodnie z RODO.',
    canonical: 'https://www.leszy.run/polityka-prywatnosci',
    lang: 'pl-PL',
  },
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy — Leszy.run',
    description: 'Privacy Policy for Leszy.run — how we process your personal data under GDPR.',
    canonical: 'https://www.leszy.run/privacy-policy',
    lang: 'en',
  },
  {
    slug: 'regulamin',
    title: 'Regulamin serwisu — Leszy.run',
    description: 'Regulamin serwisu Leszy.run.',
    canonical: 'https://www.leszy.run/regulamin',
    lang: 'pl-PL',
  },
  {
    slug: 'podmioty-przetwarzajace',
    title: 'Podmioty przetwarzające — Leszy.run',
    description: 'Lista podmiotów współpracujących z Leszy.run w zakresie przetwarzania danych osobowych.',
    canonical: 'https://www.leszy.run/podmioty-przetwarzajace',
    lang: 'pl-PL',
  },
]

async function loadTemplate() {
  const indexHtml = await fs.readFile(path.join(distDir, 'index.html'), 'utf-8')
  return indexHtml
}

async function generate() {
  const template = await loadTemplate()

  for (const page of PAGES) {
    const html = template
      .replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`)
      .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${page.description}"`)
      .replace(/<html lang="[^"]*"/, `<html lang="${page.lang}"`)
      .replace(/<link rel="canonical"[^>]*>\s*/, '')
      .replace('</head>', `  <link rel="canonical" href="${page.canonical}" />\n  </head>`)

    const outDir = path.join(distDir, page.slug)
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf-8')
    console.log(`  generated ${page.slug}/index.html`)
  }
}

generate().catch(err => {
  console.error('generate-legal-pages failed:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Wire into the build**

Open [public/package.json](public/package.json). Find the `"build"` script and append the new generator to it. Example:

```json
"build": "vite build && node scripts/generate-event-pages.js && node scripts/generate-landing-pages.js && node scripts/generate-legal-pages.js"
```

- [ ] **Step 3: Smoke test the build**

```bash
cd public && npm run build
ls dist/polityka-prywatnosci/ dist/regulamin/ dist/privacy-policy/ dist/podmioty-przetwarzajace/
```

Expected: each directory contains `index.html` with the right title in `<title>`.

```bash
grep -o "<title>[^<]*</title>" public/dist/polityka-prywatnosci/index.html
```

Expected: `<title>Polityka prywatności — Leszy.run</title>`

- [ ] **Step 4: Commit**

```bash
git add public/scripts/generate-legal-pages.js public/package.json
git commit -m "feat(gdpr): pre-render legal pages for SEO crawlability"
```

---

## Workstream B — Consent management

### Task B1: Upgrade CookieBanner with audit trail + version check + re-open listener

**Files:**
- Modify: [public/src/components/CookieBanner.jsx](public/src/components/CookieBanner.jsx)

- [ ] **Step 1: Replace the full file content**

```jsx
import { useState, useEffect, useCallback } from 'react'
import { POLICY_VERSION } from '../lib/policyVersion'

const GA_ID = 'G-8JRNXVX5Z9'
const CONSENT_KEY = 'leszy-cookie-consent'
const IS_DEV = import.meta.env.DEV

function loadGA() {
  if (IS_DEV) {
    console.log('[DEV] Google Analytics disabled in development mode')
    return
  }
  if (document.getElementById('ga-script')) return
  const script = document.createElement('script')
  script.id = 'ga-script'
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`
  document.head.appendChild(script)
  window.dataLayer = window.dataLayer || []
  function gtag() { window.dataLayer.push(arguments) }
  window.gtag = gtag
  gtag('js', new Date())
  gtag('config', GA_ID, { send_page_view: false })
}

function removeGA() {
  const script = document.getElementById('ga-script')
  if (script) script.remove()
  window.dataLayer = undefined
  document.cookie.split(';').forEach(c => {
    const name = c.trim().split('=')[0]
    if (name.startsWith('_ga') || name.startsWith('_gid')) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.${location.hostname}`
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
    }
  })
}

function readConsent() {
  const raw = localStorage.getItem(CONSENT_KEY)
  if (!raw) return null
  // Backwards-compat: legacy string format
  if (raw === 'accepted' || raw === 'rejected') {
    return { decision: raw, timestamp: null, policyVersion: 'pre-2026-06-04', userAgent: null }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeConsent(decision) {
  const record = {
    decision,
    timestamp: new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    userAgent: navigator.userAgent,
  }
  localStorage.setItem(CONSENT_KEY, JSON.stringify(record))
  return record
}

async function logConsentServerSide(record) {
  // Fire and forget — the server-side log is best-effort.
  // Only attempts when the user is logged in (auth-me check is cheap).
  try {
    const apiUrl = import.meta.env.VITE_SUPABASE_URL
    if (!apiUrl) return
    await fetch(`${apiUrl}/functions/v1/log-consent`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: record.decision,
        policyVersion: record.policyVersion,
      }),
    })
  } catch (err) {
    // Silent — server log is not critical for the UX
    console.warn('[consent] server-side log failed:', err)
  }
}

export default function CookieBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const consent = readConsent()
    if (!consent) {
      setVisible(true)
      return
    }
    if (consent.policyVersion !== POLICY_VERSION) {
      setVisible(true)
      return
    }
    if (consent.decision === 'accepted') loadGA()
  }, [])

  const openManually = useCallback(() => {
    setVisible(true)
  }, [])

  useEffect(() => {
    window.addEventListener('leszy:cookies:open', openManually)
    return () => window.removeEventListener('leszy:cookies:open', openManually)
  }, [openManually])

  function accept() {
    const record = writeConsent('accepted')
    loadGA()
    setVisible(false)
    logConsentServerSide(record)
  }

  function reject() {
    const record = writeConsent('rejected')
    removeGA()
    setVisible(false)
    logConsentServerSide(record)
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-apex-border bg-apex-surface p-4">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <p className="text-sm text-apex-text">
          Używamy plików cookie do analizy ruchu (Google Analytics). Wyrażenie zgody jest opcjonalne. Szczegóły w <a href="/polityka-prywatnosci" className="text-apex-yellow underline">polityce prywatności</a>.
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={reject}
            className="border border-apex-border px-4 py-1.5 text-sm font-semibold text-apex-text hover:border-apex-yellow hover:text-apex-yellow"
          >
            Odrzuć
          </button>
          <button
            onClick={accept}
            className="border border-apex-yellow bg-apex-yellow px-4 py-1.5 text-sm font-semibold text-apex-ink hover:bg-apex-yellow-bright"
          >
            Akceptuję
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Manual smoke test**

```bash
cd public && npx vite --port 3002
```

Clear localStorage manually in DevTools (Application → Local Storage → http://localhost:3002 → delete `leszy-cookie-consent`), refresh, confirm:
1. Banner appears.
2. Click Accept. Inspect localStorage — entry is a JSON object with `decision`, `timestamp`, `policyVersion`, `userAgent`.
3. Click the footer "Zarządzaj cookies" link. Banner re-appears.

- [ ] **Step 3: Commit**

```bash
git add public/src/components/CookieBanner.jsx
git commit -m "feat(gdpr): consent audit trail + version check + re-open"
```

---

### Task B2: Create `consent_log` table in Supabase

**Files:**
- Use Supabase MCP

- [ ] **Step 1: Apply migration via MCP**

Call `mcp__supabase__apply_migration` with `name = "create_consent_log"` and `query`:

```sql
create table public.consent_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('accepted','rejected','withdrawn')),
  policy_version text not null,
  ip_inet inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index consent_log_user_id_idx on public.consent_log(user_id);
create index consent_log_created_at_idx on public.consent_log(created_at);

alter table public.consent_log enable row level security;

create policy "consent_log: insert own"
  on public.consent_log for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "consent_log: select own"
  on public.consent_log for select
  to authenticated
  using (auth.uid() = user_id);
```

**Wait for user confirmation per [CLAUDE.md](CLAUDE.md) database write safety rule before applying.**

- [ ] **Step 2: Verify**

Call `mcp__supabase__list_tables` and confirm `consent_log` exists with all policies.

---

### Task B3: Write the `log-consent` edge function

**Files:**
- Create: [supabase/functions/log-consent/index.js](supabase/functions/log-consent/index.js)
- Create: [supabase/functions/tests/log-consent.test.js](supabase/functions/tests/log-consent.test.js)

- [ ] **Step 1: Read the existing function pattern**

```bash
cat supabase/functions/auth-logout/index.js
cat supabase/functions/_shared/session.js | head -50
```

These show the existing structure (Deno serve, session helper, response shape).

- [ ] **Step 2: Write the failing test**

Create `supabase/functions/tests/log-consent.test.js`:

```js
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { setupTestClient, makeAuthedRequest, makeAnonRequest } from './helpers.js'

Deno.test('log-consent: anonymous request returns 401', async () => {
  const req = makeAnonRequest('POST', { decision: 'accepted', policyVersion: '2026-06-04' })
  const handler = (await import('../log-consent/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 401)
})

Deno.test('log-consent: authenticated request inserts row', async () => {
  const { user, supabaseAdmin } = await setupTestClient()
  const req = makeAuthedRequest('POST', user, { decision: 'accepted', policyVersion: '2026-06-04' })
  const handler = (await import('../log-consent/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 200)

  const { data } = await supabaseAdmin
    .from('consent_log')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
  assertEquals(data[0].decision, 'accepted')
  assertEquals(data[0].policy_version, '2026-06-04')
})

Deno.test('log-consent: rejects invalid decision', async () => {
  const { user } = await setupTestClient()
  const req = makeAuthedRequest('POST', user, { decision: 'maybe', policyVersion: '2026-06-04' })
  const handler = (await import('../log-consent/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 400)
})
```

(If `setupTestClient`/`makeAuthedRequest`/`makeAnonRequest` helpers don't exist in [supabase/functions/tests/helpers.js](supabase/functions/tests/helpers.js), read that file and adapt the test to whatever pattern is already there.)

- [ ] **Step 3: Run the test, watch it fail**

```bash
cd supabase/functions && deno test tests/log-consent.test.js --allow-all
```

Expected: failure because `log-consent/index.js` does not exist.

- [ ] **Step 4: Write the edge function**

Create `supabase/functions/log-consent/index.js`:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getSession } from '../_shared/session.js'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const VALID_DECISIONS = new Set(['accepted', 'rejected', 'withdrawn'])

function json(body, status, req) {
  const headers = new Headers({
    'content-type': 'application/json',
    'access-control-allow-credentials': 'true',
  })
  const origin = req?.headers?.get?.('origin')
  if (origin) headers.set('access-control-allow-origin', origin)
  return new Response(JSON.stringify(body), { status, headers })
}

async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, req)
  }

  const session = await getSession(req)
  if (!session) return json({ error: 'Unauthorized' }, 401, req)

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400, req)
  }

  const { decision, policyVersion } = body || {}
  if (!VALID_DECISIONS.has(decision)) {
    return json({ error: 'Invalid decision' }, 400, req)
  }
  if (typeof policyVersion !== 'string' || !policyVersion.length) {
    return json({ error: 'Missing policyVersion' }, 400, req)
  }

  const ipHeader = req.headers.get('x-forwarded-for') || ''
  const ipInet = ipHeader.split(',')[0]?.trim() || null
  const userAgent = req.headers.get('user-agent') || null

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { error } = await supabaseAdmin.from('consent_log').insert({
    user_id: session.userId,
    decision,
    policy_version: policyVersion,
    ip_inet: ipInet,
    user_agent: userAgent,
  })
  if (error) {
    console.error('log-consent insert error:', error)
    return json({ error: 'Insert failed' }, 500, req)
  }

  return json({ logged: true }, 200, req)
}

export default handler
Deno.serve(handler)
```

- [ ] **Step 5: Run the test, watch it pass**

```bash
deno test tests/log-consent.test.js --allow-all
```

Expected: all 3 tests pass.

- [ ] **Step 6: Deploy via MCP**

Call `mcp__supabase__deploy_edge_function` with `name = "log-consent"` and the file contents.

**Confirm with user before deploying** — touching production edge functions.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/log-consent/ supabase/functions/tests/log-consent.test.js
git commit -m "feat(gdpr): log-consent edge function with server-side audit trail"
```

---

### Task B4: Add consent checkbox to Onboarding

**Files:**
- Modify: [public/src/pages/Onboarding.jsx](public/src/pages/Onboarding.jsx)

- [ ] **Step 1: Read current Onboarding to find form submit handler**

```bash
grep -n "onSubmit\|handleSubmit" public/src/pages/Onboarding.jsx
```

- [ ] **Step 2: Add checkbox state and required field validation**

Inside the Onboarding component:

```jsx
const [acceptedTerms, setAcceptedTerms] = useState(false)
// ... existing state
```

Inside the form JSX, before the submit button, add:

```jsx
<label className="flex items-start gap-2 text-sm text-apex-text">
  <input
    type="checkbox"
    required
    checked={acceptedTerms}
    onChange={e => setAcceptedTerms(e.target.checked)}
    className="mt-1 accent-apex-yellow"
  />
  <span>
    Akceptuję <a href="/regulamin" target="_blank" rel="noopener" className="text-apex-yellow underline">Regulamin</a> oraz <a href="/polityka-prywatnosci" target="_blank" rel="noopener" className="text-apex-yellow underline">Politykę prywatności</a> serwisu Leszy.run.
  </span>
</label>
```

- [ ] **Step 3: On submit, log server-side consent**

In the existing submit handler, AFTER successful onboarding completion but BEFORE navigation, call the log-consent endpoint. Reuse the helper from `CookieBanner` (extract to `public/src/lib/logConsent.js`) — see substep 3a.

- [ ] **Step 3a: Extract shared consent-logging helper**

Create [public/src/lib/logConsent.js](public/src/lib/logConsent.js):

```js
import { POLICY_VERSION } from './policyVersion'

export async function logConsentServerSide(decision = 'accepted') {
  try {
    const apiUrl = import.meta.env.VITE_SUPABASE_URL
    if (!apiUrl) return
    await fetch(`${apiUrl}/functions/v1/log-consent`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision,
        policyVersion: POLICY_VERSION,
      }),
    })
  } catch (err) {
    console.warn('[consent] server-side log failed:', err)
  }
}
```

Refactor `CookieBanner.jsx` to import from this module (remove the inline `logConsentServerSide` function).

- [ ] **Step 3b: Call helper from Onboarding submit**

```jsx
import { logConsentServerSide } from '../lib/logConsent'

// ... after the onboarding API call succeeds:
await logConsentServerSide('accepted')
```

- [ ] **Step 4: Manual smoke test**

```bash
cd public && npx vite --port 3002
```

Open onboarding flow, try submitting without checking the box — browser-native required-validation blocks. Check the box, submit — onboarding completes, no console errors.

- [ ] **Step 5: Commit**

```bash
git add public/src/pages/Onboarding.jsx public/src/lib/logConsent.js public/src/components/CookieBanner.jsx
git commit -m "feat(gdpr): require regulamin+privacy acceptance in onboarding, log to consent_log"
```

---

## Workstream C1–C4 — Data subject rights

### Task C1: Write the `export-my-data` edge function

**Files:**
- Create: [supabase/functions/export-my-data/index.js](supabase/functions/export-my-data/index.js)
- Create: [supabase/functions/tests/export-my-data.test.js](supabase/functions/tests/export-my-data.test.js)

- [ ] **Step 1: Write the failing test**

```js
import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { setupTestClient, makeAuthedRequest, makeAnonRequest } from './helpers.js'

Deno.test('export-my-data: anon returns 401', async () => {
  const req = makeAnonRequest('POST', {})
  const handler = (await import('../export-my-data/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 401)
})

Deno.test('export-my-data: returns user data JSON', async () => {
  const { user } = await setupTestClient()
  const req = makeAuthedRequest('POST', user, {})
  const handler = (await import('../export-my-data/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('content-type'), 'application/json')
  assertExists(res.headers.get('content-disposition'))

  const body = await res.json()
  assertExists(body.exported_at)
  assertExists(body.policy_version_at_export)
  assertExists(body.account)
  assertEquals(body.account.id, user.id)
  assertEquals(Array.isArray(body.contributions), true)
  assertEquals(Array.isArray(body.badges), true)
  assertEquals(Array.isArray(body.consent_log), true)
})
```

- [ ] **Step 2: Run test, watch it fail**

```bash
deno test tests/export-my-data.test.js --allow-all
```

- [ ] **Step 3: Write the edge function**

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getSession } from '../_shared/session.js'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const POLICY_VERSION = '2026-06-04'

function json(body, status, req, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json',
    'access-control-allow-credentials': 'true',
    ...extraHeaders,
  })
  const origin = req?.headers?.get?.('origin')
  if (origin) headers.set('access-control-allow-origin', origin)
  return new Response(JSON.stringify(body, null, 2), { status, headers })
}

async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  const session = await getSession(req)
  if (!session) return json({ error: 'Unauthorized' }, 401, req)

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const userId = session.userId

  const [profile, contributions, badges, consentLog] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', userId).single(),
    supabaseAdmin.from('contributions').select('*').eq('user_id', userId),
    supabaseAdmin.from('badges').select('*').eq('user_id', userId),
    supabaseAdmin.from('consent_log').select('*').eq('user_id', userId),
  ])

  const body = {
    exported_at: new Date().toISOString(),
    policy_version_at_export: POLICY_VERSION,
    account: profile.data || null,
    contributions: contributions.data || [],
    badges: badges.data || [],
    consent_log: consentLog.data || [],
  }

  const date = new Date().toISOString().slice(0, 10)
  return json(body, 200, req, {
    'content-disposition': `attachment; filename="leszy-run-dane-${userId}-${date}.json"`,
  })
}

export default handler
Deno.serve(handler)
```

- [ ] **Step 4: Run test, watch it pass**

```bash
deno test tests/export-my-data.test.js --allow-all
```

- [ ] **Step 5: Deploy via MCP (with user confirmation)**

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/export-my-data/ supabase/functions/tests/export-my-data.test.js
git commit -m "feat(gdpr): export-my-data edge function (Art. 15/20)"
```

---

### Task C2: Write the `delete-my-account` edge function with two-step OTP

**Files:**
- Create: [supabase/functions/delete-my-account/index.js](supabase/functions/delete-my-account/index.js)
- Create: [supabase/functions/tests/delete-my-account.test.js](supabase/functions/tests/delete-my-account.test.js)

- [ ] **Step 1: Read existing auth-request-code function for OTP issuance pattern**

```bash
cat supabase/functions/auth-request-code/index.js | head -80
```

Identify how it generates and stores the OTP, and what table it writes to (likely a `login_codes` table or similar). The delete-my-account function needs to issue an OTP with a distinguishable purpose, so a single OTP can't be used for both login and delete.

- [ ] **Step 2: Decide OTP storage strategy**

Two options:
1. Reuse the login_codes table with an extra `purpose` column (requires migration).
2. New `delete_codes` table.

Recommendation: option 1 (cleaner, single OTP system). Adds `purpose text not null default 'login'` to login_codes via Supabase migration.

Apply migration:

```sql
alter table public.login_codes add column purpose text not null default 'login' check (purpose in ('login','delete_account'));
```

**Confirm with user before applying.**

- [ ] **Step 3: Write failing tests**

```js
import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { setupTestClient, makeAuthedRequest, makeAnonRequest } from './helpers.js'

Deno.test('delete-my-account: anon returns 401', async () => {
  const req = makeAnonRequest('POST', { action: 'request' })
  const handler = (await import('../delete-my-account/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 401)
})

Deno.test('delete-my-account: request action issues OTP', async () => {
  const { user, supabaseAdmin } = await setupTestClient()
  const req = makeAuthedRequest('POST', user, { action: 'request' })
  const handler = (await import('../delete-my-account/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 200)

  const { data } = await supabaseAdmin
    .from('login_codes')
    .select('*')
    .eq('email', user.email)
    .eq('purpose', 'delete_account')
    .order('created_at', { ascending: false })
    .limit(1)
  assertExists(data[0])
})

Deno.test('delete-my-account: confirm with valid OTP soft-deletes profile', async () => {
  const { user, supabaseAdmin } = await setupTestClient()
  // request OTP
  const reqRequest = makeAuthedRequest('POST', user, { action: 'request' })
  const handler = (await import('../delete-my-account/index.js')).default
  await handler(reqRequest)

  // grab the code
  const { data: codes } = await supabaseAdmin
    .from('login_codes')
    .select('code')
    .eq('email', user.email)
    .eq('purpose', 'delete_account')
    .order('created_at', { ascending: false })
    .limit(1)
  const code = codes[0].code

  // confirm
  const reqConfirm = makeAuthedRequest('POST', user, { action: 'confirm', code })
  const res = await handler(reqConfirm)
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.deleted, true)

  // profile is soft-deleted
  const { data: profile } = await supabaseAdmin.from('profiles').select('*').eq('id', user.id).single()
  assertExists(profile.deleted_at)
  assertEquals(profile.email, null)
  assertEquals(profile.display_name, 'Uczestnik anonimowy')
})

Deno.test('delete-my-account: confirm with wrong OTP returns 401', async () => {
  const { user } = await setupTestClient()
  const req = makeAuthedRequest('POST', user, { action: 'confirm', code: '000000' })
  const handler = (await import('../delete-my-account/index.js')).default
  const res = await handler(req)
  assertEquals(res.status, 401)
})
```

- [ ] **Step 4: Run failing tests**

```bash
deno test tests/delete-my-account.test.js --allow-all
```

- [ ] **Step 5: Write the edge function**

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getSession } from '../_shared/session.js'
import { sendOtpEmail } from '../_shared/sendgrid.js' // assume exists; if not, extract from auth-request-code

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

function json(body, status, req) {
  const headers = new Headers({
    'content-type': 'application/json',
    'access-control-allow-credentials': 'true',
  })
  const origin = req?.headers?.get?.('origin')
  if (origin) headers.set('access-control-allow-origin', origin)
  return new Response(JSON.stringify(body), { status, headers })
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

async function handleRequest(supabaseAdmin, session) {
  const { data: profile } = await supabaseAdmin.from('profiles').select('email').eq('id', session.userId).single()
  if (!profile?.email) return { error: 'No email on file', status: 400 }

  const code = generateCode()
  const { error } = await supabaseAdmin.from('login_codes').insert({
    email: profile.email,
    code,
    purpose: 'delete_account',
  })
  if (error) return { error: 'Failed to issue code', status: 500 }

  await sendOtpEmail(profile.email, code, {
    subject: 'Potwierdź usunięcie konta na Leszy.run',
    intro: 'Otrzymaliśmy żądanie usunięcia Twojego konta na Leszy.run. Aby je potwierdzić, użyj poniższego kodu.',
  })

  return { status: 200, body: { sent: true } }
}

async function handleConfirm(supabaseAdmin, session, code) {
  const { data: profile } = await supabaseAdmin.from('profiles').select('id, email').eq('id', session.userId).single()
  if (!profile) return { error: 'Profile not found', status: 404 }

  const { data: codes } = await supabaseAdmin
    .from('login_codes')
    .select('id, expires_at')
    .eq('email', profile.email)
    .eq('purpose', 'delete_account')
    .eq('code', code)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
  if (!codes?.length) return { error: 'Invalid or expired code', status: 401 }

  // Invalidate the code
  await supabaseAdmin.from('login_codes').delete().eq('id', codes[0].id)

  const originalEmail = profile.email

  // Soft-delete profile
  await supabaseAdmin.from('profiles').update({
    email: null,
    username: 'usuniety-' + profile.id.slice(0, 8),
    display_name: 'Uczestnik anonimowy',
    phone: null,
    date_of_birth: null,
    gender: null,
    city: null,
    voivodeship: null,
    club_id: null,
    deleted_at: new Date().toISOString(),
  }).eq('id', profile.id)

  // Anonymize matching participants
  if (originalEmail) {
    await supabaseAdmin.from('participants').update({
      first_name: 'Uczestnik',
      last_name: 'anonimowy',
      phone: null,
      email: null,
      deleted_at: new Date().toISOString(),
    }).eq('email', originalEmail)
  }

  // Permanently ban the auth user — note: email stays claimed, blocking re-registration
  await supabaseAdmin.auth.admin.updateUserById(profile.id, {
    ban_duration: '876000h',
  })

  return { status: 200, body: { deleted: true } }
}

async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  const session = await getSession(req)
  if (!session) return json({ error: 'Unauthorized' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  if (body.action === 'request') {
    const result = await handleRequest(supabaseAdmin, session)
    if (result.error) return json({ error: result.error }, result.status, req)
    return json(result.body, result.status, req)
  }

  if (body.action === 'confirm') {
    if (typeof body.code !== 'string') return json({ error: 'Missing code' }, 400, req)
    const result = await handleConfirm(supabaseAdmin, session, body.code)
    if (result.error) return json({ error: result.error }, result.status, req)
    return json(result.body, result.status, req)
  }

  return json({ error: 'Invalid action' }, 400, req)
}

export default handler
Deno.serve(handler)
```

(If `sendOtpEmail` doesn't exist as a shared helper, extract from `auth-request-code/index.js` into `supabase/functions/_shared/sendgrid.js` first.)

- [ ] **Step 6: Run test, watch it pass**

```bash
deno test tests/delete-my-account.test.js --allow-all
```

- [ ] **Step 7: Deploy via MCP (with user confirmation)**

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/delete-my-account/ supabase/functions/tests/delete-my-account.test.js supabase/functions/_shared/sendgrid.js
git commit -m "feat(gdpr): delete-my-account with two-step OTP, soft delete + auth ban (Art. 17)"
```

---

### Task C3: Add "Pobierz moje dane" + "Usuń konto" UI to Profil

**Files:**
- Modify: [public/src/pages/Profil.jsx](public/src/pages/Profil.jsx)

- [ ] **Step 1: Read existing Profil.jsx structure**

```bash
wc -l public/src/pages/Profil.jsx
grep -n "function\|export" public/src/pages/Profil.jsx | head -20
```

- [ ] **Step 2: Add the new section at the bottom of the profile content**

```jsx
// New imports at top:
import { useState } from 'react'
// (useState may already be imported)

// New component (can be inline or extracted):
function DangerZone() {
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('idle') // 'idle' | 'confirm' | 'otp'
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)

  const apiUrl = import.meta.env.VITE_SUPABASE_URL

  async function downloadData() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiUrl}/functions/v1/export-my-data`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Eksport nie powiódł się')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'moje-dane.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function requestOtp() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiUrl}/functions/v1/delete-my-account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request' }),
      })
      if (!res.ok) throw new Error('Nie udało się wysłać kodu')
      setStep('otp')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiUrl}/functions/v1/delete-my-account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', code }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Niepoprawny kod')
      }
      window.location.href = '/'
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 border-t border-apex-border pt-8">
      <h2 className="font-display text-xl uppercase text-apex-bright">Twoje dane</h2>
      <div className="mt-4 space-y-3">
        <button
          onClick={downloadData}
          disabled={busy}
          className="border border-apex-border px-4 py-2 text-sm hover:border-apex-yellow hover:text-apex-yellow disabled:opacity-50"
        >
          Pobierz moje dane (JSON)
        </button>

        {step === 'idle' && (
          <button
            onClick={() => setStep('confirm')}
            className="block border border-apex-red px-4 py-2 text-sm text-apex-red hover:bg-apex-red hover:text-apex-ink"
          >
            Usuń konto
          </button>
        )}

        {step === 'confirm' && (
          <div className="border border-apex-red p-4">
            <h3 className="font-display uppercase text-apex-red">Co się stanie po usunięciu konta?</h3>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              <li>Twój profil zostanie usunięty, a wszystkie dane osobowe (imię, telefon, data urodzenia, lokalizacja) wymazane.</li>
              <li>Twoje wyniki w archiwach biegów pozostaną widoczne, ale podpisane jako <strong>Uczestnik anonimowy</strong>.</li>
              <li><strong>Tego adresu email nie da się już ponownie wykorzystać do rejestracji w Leszy.run</strong> — to celowe, by usunięcie było ostateczne.</li>
              <li>Tej operacji nie da się cofnąć. Aby potwierdzić, wyślemy Ci kod OTP na email.</li>
            </ul>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setStep('idle')} className="border border-apex-border px-4 py-1.5 text-sm">Anuluj</button>
              <button onClick={requestOtp} disabled={busy} className="border border-apex-red bg-apex-red px-4 py-1.5 text-sm text-apex-ink hover:bg-apex-red disabled:opacity-50">Wyślij kod OTP</button>
            </div>
          </div>
        )}

        {step === 'otp' && (
          <div className="border border-apex-red p-4">
            <p className="text-sm">Wysłaliśmy kod OTP na Twój email. Wpisz go poniżej, aby potwierdzić usunięcie konta.</p>
            <input
              type="text"
              value={code}
              onChange={e => setCode(e.target.value)}
              maxLength={6}
              className="mt-3 w-32 border border-apex-border bg-apex-bg px-3 py-1.5 font-mono"
              placeholder="000000"
            />
            <div className="mt-4 flex gap-2">
              <button onClick={() => { setStep('idle'); setCode('') }} className="border border-apex-border px-4 py-1.5 text-sm">Anuluj</button>
              <button onClick={confirmDelete} disabled={busy || code.length !== 6} className="border border-apex-red bg-apex-red px-4 py-1.5 text-sm text-apex-ink disabled:opacity-50">Potwierdź usunięcie</button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-apex-red">{error}</p>}
      </div>
    </section>
  )
}
```

Add `<DangerZone />` at the bottom of the existing Profil page JSX (inside the same outer container).

- [ ] **Step 3: Manual smoke test (skip the actual delete on real data)**

```bash
cd public && npx vite --port 3002
```

Login, navigate to /profil, confirm:
1. "Pobierz moje dane" downloads a JSON file with profile data
2. "Usuń konto" opens the confirm box
3. Cancel button works
4. "Wyślij kod OTP" transitions to OTP entry (do NOT submit on a real account)

- [ ] **Step 4: Commit**

```bash
git add public/src/pages/Profil.jsx
git commit -m "feat(gdpr): Pobierz moje dane + Usuń konto UI in /profil"
```

---

### Task C4: Render anonymized name in result components with tooltip

**Files:**
- Create: [packages/ui/src/lib/anonymizedName.js](packages/ui/src/lib/anonymizedName.js)
- Modify: result-rendering components in [packages/ui/src/](packages/ui/src/) (concrete files TBD by inspection)

- [ ] **Step 1: Inspect existing result components**

```bash
ls packages/ui/src/
grep -rln "first_name\|firstName\|display_name\|displayName" packages/ui/src/ | head
```

Identify every result-rendering component that displays a person's name.

- [ ] **Step 2: Write the helper**

Create `packages/ui/src/lib/anonymizedName.js`:

```js
/**
 * Returns the display name for a participant/profile, respecting soft-delete.
 *
 * @param {object} entity - participant or profile row
 * @returns {{ displayName: string, isAnonymized: boolean, tooltip: string|null }}
 */
export function anonymizedName(entity) {
  const isAnonymized = Boolean(entity?.deleted_at || entity?.deletedAt)
  if (isAnonymized) {
    return {
      displayName: 'Uczestnik anonimowy',
      isAnonymized: true,
      tooltip: 'Konto użytkownika zostało usunięte. Wynik pozostaje jako część archiwum biegu.',
    }
  }
  const first = entity?.firstName || entity?.first_name || ''
  const last = entity?.lastName || entity?.last_name || ''
  const display = entity?.displayName || entity?.display_name
  return {
    displayName: display || `${first} ${last}`.trim() || 'Uczestnik',
    isAnonymized: false,
    tooltip: null,
  }
}
```

- [ ] **Step 3: Apply in each result component**

For each component identified in Step 1, replace direct name access with the helper. Example pattern:

```jsx
import { anonymizedName } from '../lib/anonymizedName'

// in the row render:
const { displayName, isAnonymized, tooltip } = anonymizedName(participant)
return (
  <span title={tooltip || undefined} className={isAnonymized ? 'italic text-apex-muted' : ''}>
    {displayName}
  </span>
)
```

(For richer tooltips, integrate with the existing shadcn Tooltip primitive if available — check `packages/ui/src/components/`.)

- [ ] **Step 4: Smoke test against a soft-deleted test account**

In Supabase, manually set `deleted_at = now()` on one test profile + matching participants. View results pages — confirm name shows as "Uczestnik anonimowy" with hover text. Revert the test data afterwards.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/
git commit -m "feat(gdpr): render Uczestnik anonimowy for soft-deleted participants"
```

---

## Workstream D — Retention

### Task D1: Schedule pg_cron job to purge gate_events + gate_crossings

**Files:**
- Use Supabase MCP `apply_migration`
- Modify: [supabase/migrations/](supabase/migrations/) if local mirror exists

- [ ] **Step 1: Enable pg_cron if not already enabled**

```sql
create extension if not exists pg_cron;
```

Check via `mcp__supabase__list_extensions`.

- [ ] **Step 2: Apply migration via MCP**

```sql
select cron.schedule(
  'purge-rfid-logs',
  '0 3 * * *',
  $$
  delete from public.gate_events
  where race_run_id in (
    select id from public.race_runs
    where status in ('finished','cancelled')
      and finished_at < now() - interval '90 days'
  );

  delete from public.gate_crossings
  where race_run_id in (
    select id from public.race_runs
    where status in ('finished','cancelled')
      and finished_at < now() - interval '90 days'
  );
  $$
);
```

(If `race_runs` lacks a `finished_at` column on Supabase, use the local schema name. Check via `list_tables` first.)

**Confirm with user before applying.**

- [ ] **Step 3: Verify**

```sql
select * from cron.job where jobname = 'purge-rfid-logs';
```

via `mcp__supabase__execute_sql`. Expected: one row.

- [ ] **Step 4: Add equivalent cron to local DB via scheduler**

Add a file `scheduler/jobs/purgeRfidLogs.js`:

```js
import { db } from '../../backend/src/db/index.js'
// (or refactor to share connection — current pattern uses container exec)

export async function purgeRfidLogs() {
  // Delete from local Postgres via SQL
  await db.execute(`
    delete from gate_events
    where race_run_id in (
      select id from race_runs
      where status in ('finished','cancelled')
        and finished_at < now() - interval '90 days'
    );

    delete from gate_crossings
    where race_run_id in (
      select id from race_runs
      where status in ('finished','cancelled')
        and finished_at < now() - interval '90 days'
    );
  `)
}
```

Schedule daily at 03:00 Europe/Warsaw in `scheduler/index.js` using `node-cron`:

```js
cron.schedule('0 3 * * *', purgeRfidLogs, { timezone: 'Europe/Warsaw' })
```

- [ ] **Step 5: Commit**

```bash
git add scheduler/
git commit -m "feat(gdpr): daily purge of gate_events/gate_crossings older than 90 days post-race"
```

---

## Workstream E — Security hardening

### Task E1: Add security headers to vercel.json

**Files:**
- Modify: [vercel.json](vercel.json)

- [ ] **Step 1: Read current vercel.json**

```bash
cat vercel.json
```

- [ ] **Step 2: Add headers array**

If `headers` doesn't exist, add it. The CSP needs to permit Supabase, GA, Google Fonts, self. Start in `Content-Security-Policy-Report-Only` mode for one week, then promote to `Content-Security-Policy`.

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Content-Security-Policy-Report-Only", "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://www.google-analytics.com https://region1.google-analytics.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self';" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()" }
      ]
    }
  ]
}
```

- [ ] **Step 3: Smoke test in preview deploy**

```bash
git add vercel.json
git commit -m "feat(gdpr): security headers (CSP report-only, HSTS, X-Frame-Options, etc.)"
git push origin feat/gdpr-compliance
```

Wait for Vercel preview deploy, then:

```bash
curl -sI <preview-url> | grep -iE "content-security|strict-transport|x-frame|x-content|referrer|permissions"
```

Confirm all six headers present. Browse the preview site for a few minutes; check the DevTools console for any CSP report-only violations. Adjust the CSP if needed.

- [ ] **Step 4: After one week (or earlier if no violations), promote to enforcing**

Edit `vercel.json`: change `Content-Security-Policy-Report-Only` to `Content-Security-Policy`. Commit separately:

```bash
git commit -m "feat(gdpr): promote CSP from report-only to enforcing"
```

---

### Task E2: OTP rate limiting on auth-request-code

**Files:**
- Use Supabase MCP for migration
- Modify: [supabase/functions/auth-request-code/index.js](supabase/functions/auth-request-code/index.js)
- Create: [supabase/functions/tests/auth-request-code-throttle.test.js](supabase/functions/tests/auth-request-code-throttle.test.js)

- [ ] **Step 1: Apply throttle table migration via MCP**

```sql
create table public.otp_throttle (
  key text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now()
);
```

**Confirm with user before applying.**

- [ ] **Step 2: Write throttle helper**

Create `supabase/functions/_shared/throttle.js`:

```js
const WINDOW_MS = 15 * 60 * 1000

/**
 * Atomically check + increment a counter under a key.
 * @returns {Promise<{ allowed: boolean, retryAfterSec?: number }>}
 */
export async function checkAndIncrement(supabaseAdmin, key, limit) {
  const now = new Date()
  const cutoff = new Date(now.getTime() - WINDOW_MS)

  // Try to read existing row
  const { data: existing } = await supabaseAdmin
    .from('otp_throttle')
    .select('*')
    .eq('key', key)
    .single()

  if (!existing) {
    await supabaseAdmin.from('otp_throttle').insert({ key, attempts: 1 })
    return { allowed: true }
  }

  // Window expired? Reset.
  if (new Date(existing.window_started_at) < cutoff) {
    await supabaseAdmin
      .from('otp_throttle')
      .update({ attempts: 1, window_started_at: now.toISOString() })
      .eq('key', key)
    return { allowed: true }
  }

  if (existing.attempts >= limit) {
    const retryAfterSec = Math.ceil(
      (new Date(existing.window_started_at).getTime() + WINDOW_MS - now.getTime()) / 1000
    )
    return { allowed: false, retryAfterSec }
  }

  await supabaseAdmin
    .from('otp_throttle')
    .update({ attempts: existing.attempts + 1 })
    .eq('key', key)
  return { allowed: true }
}
```

- [ ] **Step 3: Write failing test**

```js
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { setupTestClient, makeAnonRequest } from './helpers.js'

Deno.test('auth-request-code: 6th request from same email within 15min returns 429', async () => {
  const { supabaseAdmin } = await setupTestClient()
  await supabaseAdmin.from('otp_throttle').delete().eq('key', 'email:throttle@test.com')

  const handler = (await import('../auth-request-code/index.js')).default

  for (let i = 0; i < 5; i++) {
    const req = makeAnonRequest('POST', { email: 'throttle@test.com' })
    const res = await handler(req)
    assertEquals(res.status, 200, `request ${i + 1} should succeed`)
  }

  const req = makeAnonRequest('POST', { email: 'throttle@test.com' })
  const res = await handler(req)
  assertEquals(res.status, 429)
})
```

- [ ] **Step 4: Wire throttle into auth-request-code/index.js**

Read the function:

```bash
cat supabase/functions/auth-request-code/index.js | head -80
```

After parsing the email but before generating/sending the code, add:

```js
import { checkAndIncrement } from '../_shared/throttle.js'

// ... inside handler, after email validated:
const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()

const emailThrottle = await checkAndIncrement(supabaseAdmin, `email:${email}`, 5)
if (!emailThrottle.allowed) {
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(emailThrottle.retryAfterSec) },
  })
}
if (ip) {
  const ipThrottle = await checkAndIncrement(supabaseAdmin, `ip:${ip}`, 20)
  if (!ipThrottle.allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(ipThrottle.retryAfterSec) },
    })
  }
}
```

- [ ] **Step 5: Run tests**

```bash
deno test tests/auth-request-code-throttle.test.js --allow-all
```

Expected: pass.

- [ ] **Step 6: Deploy + commit**

```bash
git add supabase/functions/auth-request-code/index.js supabase/functions/_shared/throttle.js supabase/functions/tests/auth-request-code-throttle.test.js
git commit -m "feat(gdpr): OTP rate limit (5/email, 20/IP per 15min)"
```

Deploy via MCP (with user confirmation).

---

### Task E3: Admin audit log

**Files:**
- Use Supabase MCP for migration
- Create: [supabase/functions/_shared/admin-audit.js](supabase/functions/_shared/admin-audit.js)
- Create: [backend/src/lib/adminAudit.js](backend/src/lib/adminAudit.js)
- Modify: every admin write site (start with [supabase/functions/admin-review-contribution/index.js](supabase/functions/admin-review-contribution/index.js))

- [ ] **Step 1: Apply migration**

```sql
create table public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id),
  action text not null,
  target_table text,
  target_id text,
  payload jsonb,
  ip_inet inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index admin_actions_admin_user_id_idx on public.admin_actions(admin_user_id);
create index admin_actions_created_at_idx on public.admin_actions(created_at);

alter table public.admin_actions enable row level security;
-- No policies for anon/authenticated — only service_role writes (which bypasses RLS).
```

**Confirm with user.**

- [ ] **Step 2: Write the shared helper for edge functions**

Create `supabase/functions/_shared/admin-audit.js`:

```js
export async function logAdminAction(supabaseAdmin, { userId, action, targetTable, targetId, payload, req }) {
  const ip = (req?.headers?.get?.('x-forwarded-for') || '').split(',')[0].trim() || null
  const ua = req?.headers?.get?.('user-agent') || null
  const { error } = await supabaseAdmin.from('admin_actions').insert({
    admin_user_id: userId,
    action,
    target_table: targetTable || null,
    target_id: targetId || null,
    payload: payload || null,
    ip_inet: ip,
    user_agent: ua,
  })
  if (error) console.error('admin-audit insert failed:', error)
}
```

- [ ] **Step 3: Wire into existing admin edge functions**

In [supabase/functions/admin-review-contribution/index.js](supabase/functions/admin-review-contribution/index.js), after the existing admin check passes (line ~27) and before the data mutation, add:

```js
import { logAdminAction } from '../_shared/admin-audit.js'

// before the mutation:
await logAdminAction(supabaseAdmin, {
  userId: session.userId,
  action: `admin_review_contribution_${action}`,
  targetTable: type,
  targetId: id,
  payload: { admin_note },
  req,
})
```

- [ ] **Step 4: Write the backend Fastify helper**

Create `backend/src/lib/adminAudit.js`:

```js
import { getSupabaseAdmin } from '../sync/supabase.js' // or wherever the service-role client lives

export async function logAdminAction({ userId, action, targetTable, targetId, payload, req }) {
  const supabaseAdmin = getSupabaseAdmin()
  if (!supabaseAdmin) return // Supabase not configured — skip
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null
  const ua = req.headers['user-agent'] || null
  await supabaseAdmin.from('admin_actions').insert({
    admin_user_id: userId,
    action,
    target_table: targetTable || null,
    target_id: targetId || null,
    payload: payload || null,
    ip_inet: ip,
    user_agent: ua,
  })
}
```

- [ ] **Step 5: Wire into Fastify admin routes (e.g., club merge)**

Identify every backend route that mutates data on behalf of an admin. For each, insert a `logAdminAction` call before the mutation.

```bash
grep -rln "admin" backend/src/routes/ | head -10
```

For each admin-only route, add the call.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/admin-audit.js supabase/functions/admin-review-contribution/index.js backend/src/lib/adminAudit.js backend/src/routes/
git commit -m "feat(gdpr): admin_actions audit log + call sites in admin edge functions and Fastify routes"
```

Deploy edge function via MCP (with user confirmation).

---

### Task E4: Audit + fix public profile exposure

**Files:**
- Create: [docs/gdpr/profile-exposure.md](docs/gdpr/profile-exposure.md)
- Modify: [supabase/functions/get-profile-data/index.js](supabase/functions/get-profile-data/index.js)

- [ ] **Step 1: Read get-profile-data current behavior**

```bash
cat supabase/functions/get-profile-data/index.js
```

Trace: when called by an anonymous visitor (no session), what fields are returned? Likely the function already gates this, but verify field-by-field against the spec's E4 projection table.

- [ ] **Step 2: Write the audit findings**

Create `docs/gdpr/profile-exposure.md`:

```markdown
# Profile exposure audit

**Date:** 2026-06-04
**Reviewed function:** [supabase/functions/get-profile-data/index.js](../../supabase/functions/get-profile-data/index.js)

## Method

Read the function, traced two code paths: caller is unauthenticated, caller is profile owner.

## Findings

| Field | Anon caller | Owner | OK? | Action |
|---|---|---|---|---|
| username | ✅ | ✅ | yes | none |
| display_name | ✅ | ✅ | yes | none |
| club name | ✅ | ✅ | yes | none |
| voivodeship | ✅ | ✅ | yes | none |
| city | <FILL IN> | <FILL IN> | | |
| date_of_birth | <FILL IN> | <FILL IN> | | |
| gender | <FILL IN> | <FILL IN> | | |
| phone | <FILL IN> | <FILL IN> | | |
| email | <FILL IN> | <FILL IN> | | |

## Fixes applied

- (List concrete code changes here after Step 3)

## Re-verified

- Date: 2026-06-04
- Method: <FILL IN — e.g., curl test of the endpoint with no auth header, compare response fields>
```

(Fill in the table by actually reading the code, not by guessing.)

- [ ] **Step 3: Fix any leaks**

If anon responses include `city`, `date_of_birth`, `gender`, `phone`, or `email`, fix the function to strictly project only the public-safe fields. Pattern:

```js
const isOwner = session?.userId === target.id
const projection = isOwner
  ? '*'
  : 'id, username, display_name, club_id, voivodeship, avatar_url'

const { data: profile } = await supabaseAdmin
  .from('profiles')
  .select(projection)
  .eq('id', target.id)
  .single()
```

- [ ] **Step 4: Update profile-exposure.md with the fix description**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/get-profile-data/index.js docs/gdpr/profile-exposure.md
git commit -m "feat(gdpr): tighten public profile projection, document audit"
```

Deploy via MCP (with user confirmation).

---

### Task E5: Supabase RLS audit

**Files:**
- Create: [docs/gdpr/rls-audit.md](docs/gdpr/rls-audit.md)

- [ ] **Step 1: Run security advisor**

Call `mcp__supabase__get_advisors` with `type: "security"`. Capture all warnings.

- [ ] **Step 2: List every table and its RLS state**

Call `mcp__supabase__list_tables`. For each table with PII or user-generated content, note RLS enabled/disabled.

- [ ] **Step 3: Read each policy**

For PII-containing tables (profiles, participants, contributions, badges, checkins, consent_log, admin_actions, login_codes), query:

```sql
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

via `mcp__supabase__execute_sql`.

- [ ] **Step 4: Write the audit doc**

Create `docs/gdpr/rls-audit.md`:

```markdown
# Supabase RLS Audit

**Date:** 2026-06-04
**Method:** mcp__supabase__get_advisors + read of pg_policies + manual review.

## Advisor findings

<paste from Step 1>

## Per-table review

### public.profiles

- RLS enabled: <YES/NO>
- Policies:
  | Name | Operation | USING | WITH CHECK | Threat model | Verdict |
  | --- | --- | --- | --- | --- | --- |
  | <name> | SELECT | <qual> | — | <who can read what> | <ok / tighten / fix> |
  | ... | ... | ... | ... | ... | ... |

(One section per PII-containing table.)

## Actions taken

- <list any policy changes applied during this audit>

## Open items

- <list any deferred fixes with reason>

## Sub-resource integrity (SRI) note

We do NOT use SRI on the Google Analytics gtag.js script because Google rotates the bundle contents without publishing stable SHA hashes. This is documented as an accepted trade-off — the primary XSS defense is React's automatic escaping plus the CSP `script-src` allowlist.
```

- [ ] **Step 5: Tighten any permissive policies found**

For each "tighten" verdict in Step 4, apply a migration via MCP (with user confirmation each time).

- [ ] **Step 6: Commit**

```bash
git add docs/gdpr/rls-audit.md
git commit -m "docs(gdpr): RLS audit + apply tightening migrations"
```

---

## Final tasks

### Task FINAL1: Update [CLAUDE.md](CLAUDE.md) — mention GDPR docs

- [ ] **Step 1: Add a short section in CLAUDE.md pointing to the GDPR docs**

After the `## Project summary` section, add:

```markdown
## GDPR compliance

This project is RODO/GDPR-compliant. Reference documents:
- [docs/gdpr/ropa.md](docs/gdpr/ropa.md) — Rejestr Czynności Przetwarzania (Art. 30)
- [docs/gdpr/dpia-participants.md](docs/gdpr/dpia-participants.md) — DPIA for participant data (Art. 35)
- [docs/gdpr/breach-response.md](docs/gdpr/breach-response.md) — Breach response runbook (Art. 33/34)
- [docs/gdpr/rls-audit.md](docs/gdpr/rls-audit.md) — Supabase RLS audit
- [docs/gdpr/profile-exposure.md](docs/gdpr/profile-exposure.md) — Public profile field exposure audit
- Public legal pages: `/polityka-prywatnosci`, `/regulamin`, `/podmioty-przetwarzajace`

**Bumping privacy policy version:** edit `POLICY_VERSION` in [public/src/lib/policyVersion.js](public/src/lib/policyVersion.js). The cookie banner detects mismatch and re-prompts every user.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: link GDPR programme from CLAUDE.md"
```

---

### Task FINAL2: Open PR + ship

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/gdpr-compliance
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --title "GDPR compliance programme" --body "$(cat <<'EOF'
## Summary

- Polish + English privacy policy pages, regulamin, processor inventory page (pre-rendered for SEO)
- Footer with cookies re-open link
- Cookie banner upgraded with audit trail + policy version check
- consent_log Supabase table + log-consent edge function
- Onboarding requires acceptance of regulamin + privacy policy
- export-my-data + delete-my-account edge functions (Art. 15/17/20)
- Soft delete: anonymizes profile + participants, bans auth user, releases nothing — email stays claimed forever
- Anonymized name display in result components with tooltip
- pg_cron job purges gate_events/gate_crossings 90 days post-race
- Security headers on Vercel (CSP report-only initially)
- OTP rate limiting (5/email, 20/IP per 15min)
- Admin audit log table + call sites in edge functions and Fastify routes
- Public profile projection tightened
- Internal docs: ROPA, DPIA, breach response, RLS audit, profile exposure audit
- DPA checklist (gitignored) for operator action items

## Spec + Plan

- Spec: [docs/superpowers/specs/2026-06-03-gdpr-compliance-design.md](docs/superpowers/specs/2026-06-03-gdpr-compliance-design.md)
- Plan: [docs/superpowers/plans/2026-06-04-gdpr-compliance.md](docs/superpowers/plans/2026-06-04-gdpr-compliance.md)

## Operator action items (not blocking merge — see docs/gdpr/dpa-checklist.md)

- Confirm lukasz@leszy.run mailbox
- Accept DPAs in Supabase, Vercel, SMSAPI, Twilio, Google panels
- Configure GA4 retention to 14 months
- Enable 2FA on Supabase / Vercel / GitHub
- Promote CSP from report-only to enforcing after 1 week of clean reports

## Test plan

- [ ] /polityka-prywatnosci, /privacy-policy, /regulamin, /podmioty-przetwarzajace render correctly
- [ ] Footer "Zarządzaj cookies" reopens banner
- [ ] Onboarding refuses to complete without the consent checkbox
- [ ] /profil → Pobierz moje dane downloads a complete JSON
- [ ] /profil → Usuń konto two-step OTP flow soft-deletes the account
- [ ] After delete, name shows as "Uczestnik anonimowy" with tooltip in results
- [ ] After delete, the same email cannot register again (Supabase auth rejects)
- [ ] 6th OTP request to same email within 15min → 429
- [ ] Every admin write produces a row in admin_actions
- [ ] curl -sI returns all six security headers
- [ ] Public /profil/:username does not leak DOB/phone/email/city to anon
EOF
)"
```

- [ ] **Step 3: After merge, complete operator action items**

Work through [docs/gdpr/dpa-checklist.md](docs/gdpr/dpa-checklist.md) outside the codebase.

---

## Self-review checklist (run after writing each workstream)

After completing each workstream, run the matching acceptance criteria from the spec:

- A: All four pages load at canonical URLs; `curl -s <preview-url>/polityka-prywatnosci` returns pre-rendered HTML body; footer renders on every page
- B: localStorage after accept contains the full audit object; logged-in user generates consent_log row; "Zarządzaj cookies" re-opens; bumping POLICY_VERSION re-prompts; onboarding refuses without checkbox
- C: Logged-in user can download a complete JSON; delete flow → email nulled, deleted_at set, session invalidated; results render Uczestnik anonimowy with tooltip; same email cannot re-register
- D: pg_cron job visible in cron.job; dry-run confirms gate_events/crossings purge but results untouched
- E: All six headers in curl response; 429 on 6th OTP attempt; admin_actions rows for every admin write; anon get-profile-data doesn't leak PII; mcp__supabase__get_advisors clean
- F: All four files in docs/gdpr/; ROPA covers seven activities; dpa-checklist gitignored
