# DPIA — uzupełnienie: zapisy online

**Status:** projekt do weryfikacji; po akceptacji dołączyć do `docs/gdpr/dpia-participants.md` jako wersję 1.1 (lub osobny dokument, do którego ten odsyła)
**Uzupełnia:** DPIA „Dane uczestników biegów”, wersja 1.0 z 2026-06-04
**Podstawa:** art. 35 RODO; komunikat Prezesa UODO z 17.06.2019 r. w sprawie wykazu rodzajów operacji wymagających oceny skutków (M.P. 2019 poz. 666) — kryteria: dane osób wymagających szczególnej ochrony (dzieci), przetwarzanie na dużą skalę, łączenie zbiorów; art. 28 ust. 3 lit. f RODO — podmiot przetwarzający pomaga administratorowi w ocenie skutków.

**Uwaga o roli.** Dla danych z zapisów administratorem jest Organizator i to on formalnie odpowiada za DPIA. Ponieważ zakres przetwarzania, środki i ryzyka wynikają z Serwisu, LESZY.RUN przygotowuje tę ocenę i udostępnia ją Organizatorom (umowa organizatora §10 ust. 12 lit. b). Dla danych, których LESZY.RUN jest administratorem (konta, płatności, archiwum wyników), ocena jest oceną LESZY.RUN.

## 1. Co się zmienia względem DPIA 1.0

| Obszar | DPIA 1.0 | Zapisy online |
|---|---|---|
| Źródło danych | import listy od organizatora | formularz w Serwisie, wypełniany przez uczestnika, opiekuna, kapitana lub kupującego za kilka osób |
| Rola LESZY.RUN | administrator | podmiot przetwarzający (zapisy), administrator (konta, płatności, archiwum) |
| Nowe kategorie danych | — | data urodzenia (pełna), osoba do kontaktu w nagłych wypadkach, dane opiekuna, dane płatności (bez danych kart), akceptacje z IP i przeglądarką, przypisanie do partnera |
| Nowe kategorie osób | — | opiekunowie, osoby do kontaktu, osoby przyjmujące pakiet, przedstawiciele organizatorów |
| Nowe operacje | — | płatności i zwroty, przekazanie pakietu, wiadomości organizatora, publiczna lista startowa przed zawodami, eksport CSV przez organizatora, automatyczne konto dla każdego zapisującego |
| Nowi odbiorcy | — | Payments Lab sp. z o.o. (dpay.pl); organizatorzy i ich upoważnieni |

## 2. Konieczność i proporcjonalność nowych danych

| Dane | Niezbędne? | Uzasadnienie / ograniczenie |
|---|---|---|
| Pełna data urodzenia | TAK | Kategoria wiekowa i grupa dziecięca liczona na dzień zawodów; limity wieku konkurencji. Nigdy niepublikowana; publiczna jest tylko etykieta kategorii. |
| Osoba do kontaktu w nagłych wypadkach | OPCJONALNE (decyzja Organizatora per pole) | Bezpieczeństwo uczestnika. Usuwana 30 dni po zawodach. Nie jest daną o zdrowiu, ale jest używana w sytuacji zagrożenia zdrowia. |
| Dane opiekuna | TAK dla osoby niepełnoletniej | Umowę za dziecko zawiera opiekun (art. 98 KRO). Dziecko nie dostaje e-maili i nie ma konta. |
| Telefon | OPCJONALNE (decyzja Organizatora) | Kontakt w dniu zawodów. Usuwany 30 dni po zawodach. |
| Dane płatności | TAK dla zawodów płatnych | Tylko kwoty, status, identyfikator transakcji. Dane kart i bankowości wyłącznie u dpay (strona dpay). |
| IP i przeglądarka przy akceptacji | TAK | Dowód złożenia oświadczenia (rozliczalność, art. 5 ust. 2). |
| Status płatności na publicznej liście | WĄTPLIWE | Zob. ryzyko R6. |
| Miejscowość dziecka na publicznej liście | WĄTPLIWE | Zob. ryzyko R2. |
| Partner (przypisanie) | OPCJONALNE | Widoczne wyłącznie dla Organizatora; nigdy publicznie ani w wiadomościach do uczestnika. |

Formularz nie ma pól wolnego tekstu do danych o zdrowiu, a umowa organizatora zakazuje zbierania danych z art. 9 (§9 ust. 5).

## 3. Ryzyka i środki

Skala: prawdopodobieństwo / skutek — niskie, średnie, wysokie.

| # | Ryzyko | P | S | Środki (w Specyfikacji lub umowie) | Ryzyko rezydualne |
|---|---|---|---|---|---|
| R1 | Wyciek tabel zapisów (Supabase) — dane osobowe, daty urodzenia, kontakty awaryjne, dane dzieci | niskie | wysoki | RLS + `REVOKE ALL … FROM anon, authenticated` na każdej nowej tabeli; dostęp tylko przez funkcje z kluczem usługi; **blokada anon na tabelach wyścigowych (`feature/supabase-lockdown`) jako warunek uruchomienia płatności**; szyfrowanie w spoczynku; retencja 30 dni dla telefonu i kontaktu awaryjnego | średnie do czasu wdrożenia lockdownu, potem niskie |
| R2 | Dziecko identyfikowalne publicznie z miejscem i czasem obecności (imię, nazwisko, miejscowość, kategoria, godzina startu na liście startowej przed zawodami) | średnie | wysoki | lista bez daty urodzenia i numeru startowego; regulamin zawodów akceptowany przez opiekuna | **średnie** — rekomendacja: ukryć miejscowość (i rozważyć skrót nazwiska) osób niepełnoletnich na liście startowej |
| R3 | Opiekun lub kupujący podaje dane innych osób bez ich wiedzy (grupa, drużyna, kontakt awaryjny) | średnie | niski | e-mail do każdej dorosłej osoby z prośbą o potwierdzenie regulaminu i z informacją z art. 14; oświadczenie zapisującego o umocowaniu; jedna aktywna rejestracja na adres e-mail na zawody | niskie |
| R4 | Przejęcie konta właściciela klubu → zmiana rachunku do wypłat → kradzież środków Organizatora | niskie | wysoki | zmiany tylko przez właściciela; historia zmian; e-mail do właściciela przy każdej zmianie; kontrola historii przez operatora przed wypłatą; możliwość wstrzymania wypłaty (umowa §7 ust. 4) | niskie |
| R5 | Nadużycie panelu Organizatora: masowy eksport CSV, wiadomości o treści marketingowej lub phishingowej do uczestników | średnie | średni | kontrola roli w każdej funkcji; `organizer_actions` z treścią; wiadomości tylko tekstowe, z domeny Serwisu, z limitem na wydarzenie; zakaz informacji handlowych w umowie (§9 ust. 6); odpowiedzialność Organizatora za pobrane dane (§9 ust. 8) | średnie (eksport CSV poza kontrolą Serwisu) |
| R6 | Publiczny status „czeka na wpłatę” przy imieniu i nazwisku | wysokie (z założenia) | niski | brak | **do decyzji** — rekomendacja: na liście publicznej tylko liczby opłaconych/nieopłaconych na konkurencję, status per osoba tylko dla Organizatora i samego uczestnika |
| R7 | Dane płatnika w logach powiadomień dpay (`payment_events.payload`) przechowywane 5 lat | średnie | niski | weryfikacja sumy kontrolnej; tylko klucz usługi | **do sprawdzenia** — ustalić pola powiadomienia; jeżeli zawiera dane rachunku płatnika, przechowywać tylko pola potrzebne do rozliczeń |
| R8 | Przekazanie pakietu przez link „dla każdego, kto go ma” — link przechwycony przez osobę trzecią | niskie | niski | link jednorazowy, ważny do terminu przekazania, token jako SHA-256; e-mail do przekazującego z nazwiskiem osoby, która przyjęła; anulowanie do chwili przyjęcia | niskie |
| R9 | Masowe zakładanie kont na cudze adresy / wysyłanie kodów | niskie | niski | konto powstaje dopiero po wpisaniu kodu; limity kodów (5/e-mail, 20/IP, 3 próby/kod); pole-pułapka (honeypot); blokada adresów usuniętych kont | niskie |
| R10 | Telefon i kontakt awaryjny pozostają na urządzeniach pomiarowych (Mac, Raspberry Pi) po 30 dniach, bo czyszczenie tam uruchamia operator ręcznie | średnie | średni | skrypt operatora po zawodach | **średnie** — rekomendacja: automatyczne czyszczenie na hostach albo pozycja na liście kontrolnej po zawodach; szyfrowanie dysków urządzeń zabieranych na zawody |
| R11 | Organizator zbiera przez „zgody” w formularzu zgody RODO (np. marketingowe), które są wymagane do zapisu — zgoda nieważna (art. 7 ust. 4) | średnie | średni | zakaz w umowie (§9 ust. 4) | **średnie** — rekomendacja: w Serwisie nazwać te pola „oświadczeniami” i pokazać Organizatorowi ostrzeżenie przy dodawaniu |
| R12 | Dostęp do danych przez dostawców z USA | niskie | średni | dane w UE (Supabase eu-west-1, Vercel dub1); umowy DPA; SCC/DPF | niskie |
| R13 | Błąd w kwotach — pobranie kwoty, na którą uczestnik nie zgodził się świadomie | niskie | średni | kwoty liczone wyłącznie po stronie serwera; wymagane pole `total` z klienta i odrzucenie przy różnicy; Wsparcie LESZY.RUN jako wymagany wybór bez domyślnej odpowiedzi | niskie (ryzyko konsumenckie, nie RODO) |
| R14 | Utrata danych zgłoszeń przy usunięciu konta, potrzebnych Organizatorowi do zawodów | niskie | niski | `delete-my-account` anonimizuje zgłoszenia jak uczestników, zachowuje kwoty | niskie — do potwierdzenia, czy anonimizacja przed zawodami nie odbiera miejsca bez wiedzy uczestnika |

## 4. Osoby niepełnoletnie — szczegółowo

- Osobę poniżej 18 lat zapisuje rodzic lub opiekun prawny ze swojego konta; składa za nią oświadczenia (`accepted_as = guardian`). Podstawą przetwarzania jest umowa (art. 6 ust. 1 lit. b RODO) zawierana przez przedstawiciela ustawowego, nie zgoda — art. 8 RODO nie ma zastosowania.
- Dziecko nie ma konta i nie dostaje wiadomości.
- Wyniki dzieci są publiczne jak wyniki dorosłych (regulamin zawodów podpisany przez opiekuna obejmuje publikację); konkurencje dziecięce domyślnie bez pomiaru czasu, a migawka wyników pomija konkurencje bez pomiaru.
- Do decyzji: miejscowość na liście startowej (R2), status płatności (R6).

## 5. Ryzyko rezydualne i decyzja

Po wdrożeniu środków z kolumny „Środki” i przy założeniu, że `feature/supabase-lockdown` zostanie wdrożony przed płatnościami, ryzyko rezydualne jest **niskie**, z wyjątkiem R2, R6, R10 i R11, które pozostają **średnie lub do decyzji** do czasu przyjęcia rekomendacji.

Decyzja administratora (część LESZY.RUN): [DO UZUPEŁNIENIA: zatwierdzono / zatwierdzono z warunkami — podpis, data].
Udostępnienie Organizatorom: [DO UZUPEŁNIENIA: forma — np. link w panelu Organizatora].

Konsultacja z Prezesem UODO (art. 36) nie jest potrzebna, jeżeli rekomendacje dla R2, R6 i R11 zostaną przyjęte lub świadomie odrzucone z uzasadnieniem, a ryzyko rezydualne pozostanie niskie lub średnie.

## 6. Przegląd

Jak w DPIA 1.0, a dodatkowo: przed włączeniem zapisów pierwszemu klubowi spoza ZATYRANI, po pierwszych zawodach z płatnościami oraz przy włączeniu zespołowego pomiaru czasu lub nowych pól formularza.

---

## Do weryfikacji

1. **Kto przeprowadza DPIA** — czy przygotowanie oceny przez podmiot przetwarzający i udostępnienie jej Organizatorom spełnia obowiązek administratora (art. 35 ust. 1), czy każdy Organizator musi ją formalnie przyjąć (np. przy akceptacji umowy).
2. **Czy DPIA jest w ogóle obowiązkowa** — kryteria z wykazu UODO (dzieci, duża skala) przy kilkudziesięciu–kilkuset uczestnikach na zawody i kilku organizatorach na start.
3. **Kontakt awaryjny a dane o zdrowiu** — czy sam fakt wskazania kontaktu na wypadek zdarzenia medycznego nie czyni go daną o zdrowiu (raczej nie, ale potwierdzić).
4. **R2 i R6** — publikacja miejscowości dzieci i statusu płatności; decyzja produktowa wpływa na ocenę.
5. **R14** — skutek usunięcia konta przed zawodami dla aktywnego zgłoszenia.
6. **Skala „dużej skali”** dla danych dzieci — wytyczne WP248 rev.01.
