# Ocena skutków dla ochrony danych (DPIA) — Dane uczestników biegów

**Wersja:** 1.0
**Data:** 2026-06-04
**Administrator:** Wookiee Łukasz Górnicki (NIP 6292248418), lukasz@leszy.run
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

## 9. Uzupełnienie 2026-10-29: zapisy grupowe (zapisy online, Plan 4)

Pełna ocena zapisów online jest w `docs/legal/zapisy/dpia-uzupelnienie.md`. Ten punkt opisuje, co zmieniają zapisy grupowe: jedna osoba zapisuje siebie, inne osoby dorosłe i dzieci jednym zgłoszeniem.

**Dziecko.** Zapisuje je rodzic lub opiekun ze swojego konta i składa za nie oświadczenia (`accepted_as = guardian`). Dziecko nie ma adresu e-mail, konta i nie dostaje wiadomości.

**Miejscowość dziecka.** Na publicznej liście startowej nie ma miejscowości osoby poniżej 18 lat (P3-R14). **Ryzyko rezydualne:** nazwa klubu dziecka, np. „UKS Sokół Pilchowice”, często wskazuje miejscowość, której lista nie podaje. Przyjęto (decyzja T7-F6), że klub zostaje na liście, bo jest częścią klasyfikacji klubowej, a wybór i nazwę klubu podaje opiekun. Opiekun może zostawić klub pusty, chyba że Organizator ustawił to pole jako wymagane. Rekomendacja dla Organizatorów: nie wymagać klubu w konkurencjach dziecięcych.

**Osoba dorosła zapisana przez kogoś innego (art. 14 RODO).**
- Zapisujący podaje jej dane, a ona dostaje jeden e-mail z linkiem do strony `/zgoda` i z informacją o danych. E-mail wskazuje zapisującego z imienia i nazwiska jako źródło danych (art. 14 ust. 2 lit. f).
- Na stronie z linku osoba potwierdza adres kodem, sprawdza i może poprawić swoje dane, a potem akceptuje regulamin zawodów i warunki serwisu.
- Token jest tylko w części `#` adresu, więc nie trafia do serwera, logów ani analityki. Strona usuwa go z paska adresu przed pierwszym zapytaniem. Baza przechowuje tylko skrót SHA-256 tokenu.
- Przypomnienia: jedno automatyczne 72 h przed końcem zapisów oraz ręczne, od zapisującego lub Organizatora, łącznie 3 na dobę. Każde przypomnienie unieważnia poprzedni link.
- Dopóki osoba nie zaakceptuje regulaminu, publiczna lista startowa jej nie pokazuje z imienia i nazwiska, a tylko ją liczy. Powód: nie zna jeszcze informacji o danych. Z tego samego powodu nie ma jej w publicznym widoku `participants_public` ani w wynikach (`/api/results`), choć jej wiersz uczestnika już istnieje dla hosta pomiaru czasu.

**Podpis w biurze zawodów.** Osoba, która nie kliknęła linku, może podpisać regulamin w biurze. Organizator odnotowuje to w panelu „Zgłoszenia” przyciskiem „Podpisany w biurze”, który wymaga potwierdzenia w miejscu. Wpis trafia do `organizer_actions`. Odnotowanie zapisuje akceptacje regulaminu i warunków zawodów, nigdy regulaminu serwisu LESZY.RUN, bo tego osoba nie zaakceptowała. **Ryzyko:** Organizator może kliknąć bez podpisu. Odpowiada za to jako administrator (umowa organizatora), a wpis w `organizer_actions` jest dowodem kto i kiedy.

**Wyrocznia „czy ta osoba jest zapisana”.** Odpowiedź „ta osoba jest już zapisana” ujawnia, że ktoś o danym adresie, albo dziecko o danym imieniu, nazwisku i dacie urodzenia, startuje w zawodach. Środki:
- odpowiedź wymaga potwierdzonego adresu zapisującego;
- najwyżej 5 takich odpowiedzi wskazujących osobę na zapisującego na dobę, potem odmowa bez wskazania osoby;
- 30 osób na zapisującego na dobę;
- 20 zapisów na adres IP na godzinę.

**Usunięcie konta.**
- Opiekun usuwa konto: zgłoszenie dziecka zostaje, bez danych kontaktowych opiekuna (`guardian_removed_at`), a Organizator widzi „kontakt opiekuna usunięty”. Telefon dziecka jest usuwany, jeśli to numer opiekuna (formularz domyślnie wpisuje dziecku telefon opiekuna); numer wpisany dla dziecka zostaje. Organizator ustala kontakt w biurze zawodów.
- Zapisujący usuwa konto: zgłoszenia innych dorosłych zostają, a `registered_by_profile_id` jest czyszczone.
- Osoba dorosła usuwa konto: jej prośba o akceptację (`consent_requests`) jest usuwana.

**Ocena.** Ryzyko rezydualne dla tych operacji: **niskie**, z wyjątkiem klubu dziecka, ocenionego jako **niskie do średniego** i przyjętego świadomie.

## 10. Uzupełnienie 2026-11-01: drużyny i sztafety (zapisy online, Plan 5)

Ten punkt opisuje, co zmieniają drużyny: kapitan zapisuje jednym zgłoszeniem cały skład, płaci jedną opłatę i zmienia skład do zamknięcia zapisów. Zasady zapisu innych osób są takie same jak w pkt 9.

**Nazwa drużyny.** To tekst swobodny, publiczny, wpisany przez kapitana. Może zawierać nazwisko albo inną informację o osobach z drużyny, np. „Rodzina Kowalskich”. **Ryzyko:** nazwa przetrwałaby ludzi, bo zgłoszenia są anonimizowane, a nazwa zostawała na liście startowej. **Środki:**
- informacja o danych mówi, że nazwa jest publiczna;
- 30 dni po zawodach `purge_registration_contact_data` zastępuje nazwę neutralną;
- drużyna, której zamówienie wygasło lub zostało anulowane, traci nazwę razem z danymi osób: `purge_expired_registrations` zastępuje ją neutralną 30 dni po wygaśnięciu lub anulowaniu;
- usunięcie konta kapitana zastępuje nazwy wszystkich jego drużyn od razu, także drużyn zwolnionych;
- nazwa nie trafia na hosty pomiaru czasu ani do wyników.

Nazwa jest zastępowana, a nie usuwana, bo drużyna zajmuje miejsce na liście i odpowiada za nią opłata. **Ryzyko rezydualne:** nazwa jest publiczna do 30 dni po zawodach, a kopie w wyszukiwarkach lub zrzuty ekranu mogą przetrwać dłużej. Żadna kontrola formularza nie rozpozna nazwiska w nazwie.

**Kapitan a dane innych osób (art. 14 RODO).** Kapitan podaje dane członków, a każda dorosła osoba dostaje e-mail z linkiem, jak w pkt 9. Dopóki nie zaakceptuje regulaminu, lista startowa ją tylko liczy. Kapitan widzi w składzie imiona, nazwiska, wiek i stan zgody, nigdy adresu, telefonu ani daty urodzenia członka. **Ryzyko:** kapitan może wpisać osobę bez jej wiedzy. E-mail z linkiem ją o tym informuje, a osoba dorosła, która nie zaakceptuje, nie jest publikowana.

**Zmiana składu.** Osoba usunięta ze składu potwierdzonej drużyny dostaje e-mail, a jej zgłoszenie jest anulowane. Na hoście uczestnik dostaje `removed_at` i zachowuje numer startowy oraz chip, bo tych nie wolno użyć ponownie. Osoba dodana pojawia się jako nowy uczestnik bez numeru.

Dane osoby usuniętej ze składu są anonimizowane w chwili wymiany, w tej samej transakcji (`team_squad_edit`): imię, nazwisko, e-mail, telefon, data urodzenia, miejscowość, klub, narodowość, kontakt ICE, dane opiekuna i powiązanie z kontem, a w akceptacjach adres IP i user agent. Na potwierdzonej drużynie anonimizowany jest też uczestnik (imię, nazwisko, e-mail, telefon, data urodzenia, klub); numer startowy i chip zostają. Zgłoszenie zostaje jako anulowane, przy drużynie i zamówieniu, bo opłata za drużynę dotyczy zamówienia. **Ryzyko:** bez tego dane osoby wymienionej ze składu nie miały końca przechowywania, bo nie obejmowało ich żadne czyszczenie, a osoba z drużyny czekającej na wpłatę nie dostała żadnej informacji (art. 14 RODO). **Środek:** anonimizacja w chwili wymiany. E-mail do osoby usuniętej z potwierdzonej drużyny wychodzi z adresu odczytanego przed anonimizacją i nie jest nigdzie zapisywany.

**Kapitan usuwa konto.** Drużyna zostaje na liście startowej pod neutralną nazwą, bez imienia i miejscowości kapitana, a zgłoszenia pozostałych członków zostają. Skład może potem zmieniać tylko Organizator. Dane opiekuna przy dzieciach kapitana są usuwane jak w pkt 9.

**Ocena.** Ryzyko rezydualne dla tych operacji: **niskie**. Publiczna nazwa drużyny do 30 dni po zawodach została przyjęta świadomie, bo jest częścią publicznej listy startowej.
