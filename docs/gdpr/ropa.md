# Rejestr Czynności Przetwarzania (ROPA) — Leszy.run

**Administrator:** Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice, NIP 6292248418, REGON 385416140, prowadzący serwis Leszy.run
**Kontakt:** lukasz@leszy.run
**Data ostatniej aktualizacji:** 2026-11-01
**Wersja:** 1.8

## Rola Leszy.run

Leszy.run / Łukasz Górnicki jest **jedynym administratorem (controller)** dla wszystkich czynności wymienionych poniżej. Nie występują relacje wspólnego administrowania (joint controllership) ani relacje powierzenia danych (processor) z organizatorami biegów. Organizatorzy są **źródłem danych** — administrowanie przechodzi na Leszy.run w momencie zaimportowania listy startowej.

## 1. Rejestracja i prowadzenie kont użytkowników

- **Cel:** Umożliwienie użytkownikom zakładania kont, edycji profili, śledzenia własnej aktywności biegowej.
- **Podstawa prawna:** Art. 6(1)(b) RODO — wykonanie umowy o świadczenie usług elektronicznych.
- **Kategorie danych:** email, username, display_name, telefon (opcjonalnie), data urodzenia, płeć, miasto, województwo, klub.
- **Kategorie osób:** zarejestrowani użytkownicy serwisu Leszy.run (osoby fizyczne).
- **Odbiorcy:** Supabase, Inc. (hosting bazy danych); Twilio / SendGrid (dostarczanie emaili transakcyjnych).
- **Transfery poza EOG:** Supabase i SendGrid mogą przetwarzać dane w USA pod EU Standard Contractual Clauses.
- **Okres przechowywania:** bezterminowo, aż do żądania usunięcia konta przez użytkownika (soft delete).
- **Środki bezpieczeństwa:** szyfrowanie at-rest (Supabase), RLS (Row-Level Security), uwierzytelnianie magic-link OTP, rate limiting na endpointach OTP, audit log działań administracyjnych.

## 2. Pomiar czasu w biegach

- **Cel:** Pomiar czasu uczestników biegów organizowanych przez organizatorów współpracujących z Leszy.run, publikacja wyników w archiwum sportowym.
- **Podstawa prawna:** Art. 6(1)(f) RODO — uzasadniony interes administratora (świadczenie usługi pomiaru czasu, prowadzenie archiwum sportowego, weryfikowalność wyników).
- **Kategorie danych:** imię, nazwisko, numer startowy, kategoria, tag RFID, telefon (opcjonalnie do SMS check-in), email (opcjonalnie), surowe odczyty bramek (gate_events), potwierdzenia przejść (gate_crossings), wyniki.
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
- **Okres przechowywania:** bezterminowo dla uczestników z kontem (do usunięcia konta lub wniosku osoby); dla uczestników bez konta — 12 miesięcy od daty biegu, następnie automatyczna anonimizacja w logach SMSAPI.
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

## 8. Członkostwo w klubach (club_members, club_membership_log)

- **Cel:** Umożliwienie użytkownikom tworzenia klubów, dołączania do nich i zarządzania członkostwem; prowadzenie historii zmian członkostwa (dołączenia, wyjścia, usunięcia, zmiany roli) dla zapewnienia integralności historycznej przynależności klubowej (przypisywanie wyników biegowych do klubu).
- **Podstawa prawna:** Art. 6(1)(b) RODO — wykonanie umowy o świadczenie usług elektronicznych (funkcja klubowa serwisu); Art. 6(1)(f) RODO — uzasadniony interes administratora (integralność historii członkostwa, wiarygodność przypisania wyników do klubu).
- **Kategorie danych:** `club_members` — ID użytkownika, ID klubu, rola, status członkostwa (aktywny/opuścił/usunięty), data dołączenia, data opuszczenia, ustawienia widoczności (hidden_public). `club_membership_log` — ID użytkownika, ID klubu, typ zdarzenia (dołączenie/wyjście/usunięcie/zmiana roli), rola, ID użytkownika wykonującego akcję (actor_id), znacznik czasowy.
- **Kategorie osób:** zarejestrowani użytkownicy serwisu będący członkami lub byłymi członkami klubów.
- **Odbiorcy:** Supabase, Inc. (hosting bazy danych).
- **Transfery poza EOG:** jak w pkt 1.
- **Okres przechowywania:** przez czas istnienia konta użytkownika; trwale usuwane w ramach procesu usunięcia konta (`delete-my-account`) — wiersze `club_members` i `club_membership_log` są kasowane, nie tylko anonimizowane.
- **Środki bezpieczeństwa:** RLS (Row-Level Security), zapis do `club_membership_log` wyłącznie przez service_role (append-only), eksport danych własnych (`export-my-data`) obejmuje wszystkie wiersze członkostwa (dowolny status) oraz pełną historię zmian.

## 9. Rozpoznawanie numerów startowych z obrazu (kamera na mecie)

- **Cel:** Odczyt numeru startowego z fotografii wykonanych na mecie, jako **drugie źródło** czasu dla zawodników, których nie zarejestrował chip RFID, oraz diagnostyka poprawności działania kamery (ekran „Audyt kamery" w panelu administracyjnym). Czas z chipa ma zawsze pierwszeństwo — obraz go nie zastępuje.
- **Podstawa prawna:** Art. 6(1)(b) RODO — wykonanie umowy z uczestnikiem (pomiar czasu jest przedmiotem umowy zawieranej przez akceptację regulaminu biegu). **Nie jest to zgoda** — zgoda musi być dobrowolna i odwoływalna, a zgoda, której uczestnik nie może odmówić pozostając w biegu, jest nieważna.
- **Kategorie danych:** fotografie klatek z kamery (zawierają wizerunek całej sylwetki i twarz), wycinki samego numeru startowego (tylko cyfry), numer startowy odczytany automatycznie, pewność odczytu, liczba klatek, znacznik czasu przejścia, powiązanie z uczestnikiem z listy startowej.
- **Kategorie osób:** uczestnicy biegów przekraczający linię mety oraz osoby postronne, które weszły w kadr.
- **Odbiorcy:** **BRAK.** Fotografie nie opuszczają komputera, który je zarejestrował (Raspberry Pi na mecie). Nie są wysyłane do Supabase, do chmury, ani do żadnego podmiotu przetwarzającego. Tabele `vision_sessions` i `vision_sightings` są wyłącznie lokalne i celowo nie podlegają synchronizacji.
- **Transfery poza EOG:** brak.
- **Okres przechowywania:** **30 dni od biegu**, po czym automatyczny purge (`backend/scripts/purge-vision-evidence.js`, cron 03:20 w kontenerze scheduler) kasuje najpierw pliki zdjęć, a następnie wiersze. Okres jest krótszy niż 90 dni dla `gate_events`, ponieważ fotografia osoby jest danymi wrażliwszymi niż odczyt tagu, a jej użyteczność kończy się z chwilą zatwierdzenia wyników.
- **Środki bezpieczeństwa:** brak jakiegokolwiek połączenia sieciowego i klienta bazy danych w pakiecie `vision/` (zapis wyłącznie do plików na dysku lokalnego); serwowanie obrazów wyłącznie przez lokalny backend, z walidacją nazwy pliku odporną na path traversal i nagłówkiem `Cache-Control: private`; pełna klatka dostępna wyłącznie po jawnym kliknięciu, nigdy na liście; lista pokazuje wyłącznie wycinek numeru (bez sylwetki i twarzy).
- **Czego system NIE robi (zakaz stały, nie opis bieżącej wersji):** nie wykrywa twarzy, nie prowadzi rozpoznawania twarzy, nie buduje szablonów biometrycznych i nie porównuje osób ze zbiorem wzorców. Obrazy **zawierają** twarze i są danymi osobowymi w pełnym zakresie, ale **nie są** danymi biometrycznymi szczególnej kategorii w rozumieniu art. 9 RODO, ponieważ nic nie wyprowadza z nich identyfikatora biometrycznego. Dodanie rozpoznawania twarzy byłoby odrębnym przedsięwzięciem na odrębnej podstawie prawnej i wymagałoby nowej oceny skutków.
- **Uwaga wdrożeniowa:** klauzule do regulaminu i polityki prywatności są przygotowane w `docs/gdpr/vision-bib-recognition-klauzule.md`, ale **nie zostały jeszcze przyjęte**. Kamera nie powinna pracować na biegu, którego regulamin nie wymienia rozpoznawania numerów z obrazu.

## 10. Zapisy online z płatnością (zamówienia, płatności dpay, zwroty)

- **Rola:** dane zgłoszenia (osoba zapisana, kontakty, akceptacje) LESZY.RUN przetwarza **w imieniu Organizatora** zawodów, na podstawie umowy organizatora (art. 28 RODO) — dla tych danych ten wpis jest rejestrem z art. 30 ust. 2. Dla **danych płatności** (zamówienie, kwoty, transakcje, zwroty) i konta kupującego administratorem jest LESZY.RUN, który przyjmuje płatność jako pośrednik Organizatora.
- **Cel:** przyjęcie opłaty startowej za zgłoszenie, potwierdzenie zgłoszenia po wpłacie, wygaszenie nieopłaconego zgłoszenia i zwolnienie miejsca, zwrot podwójnej lub spóźnionej wpłaty, rozliczenie z Organizatorem, księgowość.
- **Podstawa prawna:** art. 6(1)(b) RODO — wykonanie umowy (zapis i płatność); art. 6(1)(c) — obowiązki podatkowe i rachunkowe (przechowywanie dowodów płatności); art. 6(1)(f) — ustalenie, dochodzenie i obrona roszczeń (spory o płatność, reklamacje).
- **Kategorie danych:** `orders` — adres e-mail kupującego (`buyer_email`), powiązanie z kontem, kwoty w groszach (opłaty startowe, produkty dodatkowe, darowizna, razem), status, terminy; `order_lines` — kwota per zgłoszenie i nazwa progu cenowego; `payment_attempts` — identyfikator transakcji dpay, kwota, status; `payment_events` — log komunikacji z dpay po redakcji (`redactDpay`): adres e-mail płatnika wyłącznie jako skrót SHA-256 (`email_sha256`), baza odrzuca klucz `email` i adres w treści; `refunds` — kwota, powód, wynik zwrotu oraz, przy zwrocie Organizatora rozstrzygniętym ręcznie, notatka operatora (`resolved_by`: kto sprawdził i co pokazał panel dpay, np. inicjały i data — dane operatora, nigdy zawodnika; poza eksportem danych zawodnika); `operator_alerts` — zgłoszenia dla operatora (np. rozbieżna kwota, nieudany zwrot) z identyfikatorami transakcji i kwotami. Brak danych kart i rachunków płatnika (obsługuje je dpay).
- **Kategorie osób:** uczestnicy zawodów i osoby zapisujące (kupujący), wyłącznie zalogowani — zamówienie wymaga konta.
- **Odbiorcy:** Payments Lab sp. z o.o. z siedzibą w Warszawie (KRS 0000845085), operator dpay.pl — przyjmuje płatność i wykonuje zwrot jako dostawca usług płatniczych (odrębny administrator danych płatności po swojej stronie); Supabase, Inc. (baza danych, funkcje); Twilio / SendGrid (e-maile o płatności, przypomnienia, zwroty); Organizator — liczba opłaconych i oczekujących zgłoszeń oraz status płatności przy zgłoszeniu.
- **Transfery poza EOG:** jak w pkt 1 (Supabase, SendGrid); dpay przetwarza dane w Polsce.
- **Okres przechowywania:**
  - zamówienia z ruchem pieniędzy (opłacone lub zwrócone) wraz z próbami płatności, logiem `payment_events` i zwrotami — **5 lat od końca roku kalendarzowego, w którym dokonano płatności** (przepisy podatkowe); automatyczne usuwanie po tym okresie nie jest jeszcze wdrożone (pozycja do wdrożenia przed upływem pierwszego okresu);
  - zgłoszenie nieopłacone w terminie (wygasłe) oraz anulowane bez wpłaty — **30 dni** od wygaśnięcia / anulowania: dane osobowe zgłoszenia są anonimizowane, a w zamówieniu bez żadnego ruchu pieniędzy usuwany jest `buyer_email` (zadanie pg_cron `registration-purge-expired`, codziennie 01:45 UTC);
  - przy usunięciu konta (`delete-my-account`) zamówienie zachowuje kwoty, statusy i identyfikatory transakcji (art. 17 ust. 3 lit. b i e), a `buyer_email` jest usuwany; z treści zgłoszeń operatora dotyczących tych zamówień usuwany jest adres e-mail.
- **Prawa osób:** eksport (`export-my-data`) obejmuje zamówienia kupującego z kwotami, pozycjami, próbami płatności, zwrotami i zgłoszeniami operatora dotyczącymi zamówienia; dla właściciela klubu — historię zmian rachunku do wypłat wydarzenia (`event_payout_history`), które sam wprowadził. Bieżący rachunek do wypłat wydarzenia (`event_payout_details`) należy do klubu, nie do osoby; gdy odbiorcą jest osoba fizyczna bez konta, jej żądanie z art. 15 obsługiwane jest ręcznie.
- **Środki bezpieczeństwa:** wszystkie tabele z RLS i `REVOKE ALL … FROM anon, authenticated`, dostęp wyłącznie przez funkcje z kluczem usługi; kwoty liczone wyłącznie po stronie serwera, w całkowitych groszach; podpis każdego powiadomienia dpay weryfikowany przed decyzją; idempotencja potwierdzeń i zwrotów po stronie LESZY.RUN; sekrety dpay tylko w sekretach funkcji Supabase; zadania okresowe z sygnałem życia (`registration_job_heartbeats`) i alarmem e-mail przy zatrzymaniu.

## 11. Zapisy grupowe: opiekunowie, osoby dorosłe zapisane przez kogoś innego, prośby o akceptację regulaminu

- **Rola:** jak w pkt 10 — dane zgłoszeń LESZY.RUN przetwarza w imieniu Organizatora (art. 28 RODO, rejestr z art. 30 ust. 2); konto zapisującego i dane płatności — LESZY.RUN jako administrator.
- **Cel:** zapisanie jednym zgłoszeniem kilku osób (do 10): siebie, innych osób dorosłych i dzieci, w różnych konkurencjach; uzyskanie od każdej dorosłej osoby zapisanej przez kogoś innego akceptacji regulaminu zawodów i przekazanie jej informacji z art. 14 RODO; przypomnienia o akceptacji; odnotowanie podpisu złożonego w biurze zawodów.
- **Podstawa prawna:** art. 6(1)(b) RODO — umowa o udział w zawodach (za dziecko zawiera ją rodzic lub opiekun prawny, art. 98 KRO; osoba dorosła zawiera ją sama, akceptując regulamin po kliknięciu linku albo w biurze zawodów); art. 6(1)(f) — ochrona formularza przed nadużyciem (limity zapytań).
- **Kategorie danych:**
  - `registrations.registered_by_profile_id` — konto osoby, która złożyła zgłoszenie za innych;
  - dane opiekuna przy zgłoszeniu dziecka: `guardian_profile_id`, `guardian_name`, `guardian_email`, a po usunięciu konta opiekuna znacznik `guardian_removed_at`;
  - `orders.buyer_name` — imię i nazwisko wpisane przez zapisującego, podawane osobie dorosłej jako źródło jej danych (art. 14 ust. 2 lit. f);
  - `registrations.consent_state` (`awaiting` / `accepted` / `office`);
  - `consent_requests` — skrót SHA-256 tokenu z linku (sam token istnieje tylko w e-mailu), daty wysłania, przypomnień (ręcznego i automatycznego), użycia i wygaśnięcia;
  - `consent_acceptances` z `accepted_as = guardian` (oświadczenia opiekuna za dziecko, z IP i przeglądarką) albo złożone przez samą osobę dorosłą przez link;
  - liczniki limitów w `otp_throttle` (adres IP, konto zapisującego).
  Dziecko nie ma adresu e-mail ani konta.
- **Kategorie osób:** opiekunowie (rodzice) i zapisane przez nich dzieci; osoby dorosłe zapisane przez członka rodziny lub drużyny; osoby zapisujące innych bez własnego startu („Nie startuję — zapisuję tylko inne osoby”).
- **Odbiorcy:** jak w pkt 10. Osoba dorosła zapisana przez kogoś innego dostaje dokładnie jeden e-mail z linkiem do strony `/zgoda` i z informacją o danych (`/events/<slug>/informacja-o-danych`), jedno automatyczne przypomnienie 72 h przed końcem zapisów i przypomnienia na żądanie zapisującego lub Organizatora (łącznie 3 na dobę na zgłoszenie). Dziecko nie dostaje żadnych wiadomości. Organizator widzi w panelu stan akceptacji, imię i nazwisko zapisującego i opiekuna, bez ich adresów; adres e-mail opiekuna dziecka zawiera dopiero eksport CSV (pkt 13). Publiczna lista startowa nie pokazuje osoby dorosłej z imienia i nazwiska, dopóki nie zaakceptuje regulaminu (jest tylko liczona), ani miejscowości osoby poniżej 18 lat.
- **Transfery poza EOG:** jak w pkt 1.
- **Okres przechowywania:**
  - `consent_requests` — przez czas istnienia zgłoszenia; link wygasa z końcem zapisów, a każde przypomnienie unieważnia poprzedni token;
  - dane opiekuna (`guardian_name`, `guardian_email`) — usuwane razem z kontaktami 30 dni po zawodach (`purge_registration_contact_data`), `guardian_removed_at` zostaje jako informacja dla Organizatora;
  - pozostałe dane zgłoszeń — jak w pkt 10.
- **Prawa osób:**
  - eksport (`export-my-data`) zawiera zgłoszenia osoby (z polem `registered_by` — imię i nazwisko zapisującego — oraz datami prośby o akceptację, bez skrótu tokenu), zgłoszenia dzieci, dla których jest opiekunem (`registrations_as_guardian`), i zamówienia z `buyer_name`; zgłoszenia innych dorosłych zapisanych przez tę osobę są danymi tamtych osób i nie są eksportowane;
  - usunięcie konta (`delete-my-account`) anonimizuje własne zgłoszenia osoby i usuwa ich `consent_requests` (klucz obcy RESTRICT — przed ewentualnym usunięciem zgłoszenia); przy zgłoszeniach dzieci usuwa dane opiekuna i ustawia `guardian_removed_at` (zgłoszenie dziecka zostaje, Organizator widzi „kontakt opiekuna usunięty”); przy zgłoszeniach innych osób czyści `registered_by_profile_id`; w zamówieniach usuwa `buyer_email` i `buyer_name`.
- **Środki bezpieczeństwa:**
  - token w linku tylko w części `#` adresu (nie trafia do serwera, logów ani analityki); strona usuwa go z paska adresu przed pierwszym zapytaniem;
  - dostęp do danych po linku dopiero po kodzie z e-maila;
  - limity: 20 zapisów na adres IP na godzinę, 30 osób na zapisującego na dobę, 5 odpowiedzi ujawniających, że osoba jest już zapisana, na zapisującego na dobę (potem odmowa bez wskazania osoby), 30 odczytów strony zgody na token na godzinę;
  - podpis w biurze zawodów Organizator potwierdza w panelu, z wpisem do `organizer_actions`;
  - tabele z RLS i `REVOKE ALL … FROM anon, authenticated`.

## 12. Drużyny i sztafety w zapisach online

- **Rola:** jak w pkt 10 — dane zgłoszeń LESZY.RUN przetwarza w imieniu Organizatora (art. 28 RODO, rejestr z art. 30 ust. 2); konto kapitana i dane płatności — LESZY.RUN jako administrator.
- **Cel:** zapisanie drużyny jednym zgłoszeniem i jedną opłatą; publikacja drużyny na liście startowej; zarządzanie składem przez kapitana do zamknięcia zapisów; przekazanie członków składu do pomiaru czasu.
- **Podstawa prawna:** art. 6(1)(b) RODO — umowa o udział w zawodach; art. 6(1)(f) — ochrona formularza przed nadużyciem (limity zapytań).
- **Kategorie danych:**
  - `teams.name` — nazwa wpisana przez kapitana, tekst swobodny, który może zawierać nazwisko (np. „Rodzina Kowalskich”), a więc traktowany jak dana osobowa;
  - `teams.captain_registration_id` — wskazanie kapitana;
  - `registrations.team_id`, `registrations.team_leg` — przynależność do drużyny i numer zmiany;
  - dane członków jak w pkt 10 i 11. Dane pozostałych członków podaje kapitan (art. 14 ust. 2 lit. f), osoba dorosła dostaje e-mail z linkiem jak w pkt 11, a kapitan składa oświadczenia za dziecko, którego jest rodzicem lub opiekunem.
- **Kategorie osób:** kapitanowie, dorośli członkowie drużyn, dzieci zapisane przez kapitana.
- **Odbiorcy:** jak w pkt 10. Publiczna lista startowa pokazuje nazwę drużyny, imiona członków bez nazwisk, liczbę osób i miejscowość kapitana; dorosła osoba, która nie zaakceptowała regulaminu, jest tylko liczona. Drużyna czekająca na wpłatę jest tylko liczbą. Kapitan widzi w składzie imiona, nazwiska, wiek i stan zgody członków, bez adresów, telefonów i dat urodzenia. Do hostów pomiaru czasu trafiają uczestnicy (`participants`); tabela `teams` i nazwa drużyny nie opuszczają Supabase.
- **Transfery poza EOG:** jak w pkt 1.
- **Okres przechowywania:**
  - `teams.name` — 30 dni po zawodach; `purge_registration_contact_data` zastępuje ją neutralną nazwą („Drużyna” i osiem znaków identyfikatora drużyny albo, gdy ta nazwa jest już zajęta w konkurencji, cały identyfikator), także przy drużynie zwolnionej. Przy zamówieniu wygasłym lub anulowanym — 30 dni po wygaśnięciu lub anulowaniu; `purge_expired_registrations` zastępuje nazwę razem z anonimizacją zgłoszeń;
  - osoba usunięta ze składu: dane osobowe zgłoszenia (imię, nazwisko, e-mail, telefon, data urodzenia, miejscowość, klub, narodowość, kontakt ICE, dane opiekuna, powiązanie z kontem) oraz adres IP i user agent akceptacji są anonimizowane w chwili wymiany, w tej samej transakcji (`team_squad_edit`), na drużynie czekającej na wpłatę i na potwierdzonej. Zgłoszenie zostaje jako anulowane, przy drużynie i zamówieniu, bo opłata jest rozliczana na zamówieniu. Uczestnik ze znacznikiem `removed_at` traci imię, nazwisko, e-mail, telefon, datę urodzenia i klub, a zachowuje numer startowy i chip na hoście, bo tych nie wolno użyć ponownie;
  - pozostałe dane zgłoszeń — jak w pkt 10 i 11.
- **Prawa osób:**
  - eksport (`export-my-data`) daje kapitanowi listę `teams` (nazwa, konkurencja, wydarzenie, liczba osób, stan), a członkowi nazwę drużyny przy jego zgłoszeniu (`team_name`). Zgłoszenia dzieci są w `registrations_as_guardian`; zgłoszenia innych dorosłych członków są danymi tamtych osób i nie są eksportowane;
  - usunięcie konta (`delete-my-account`) przez kapitana zastępuje nazwę każdej jego drużyny neutralną nazwą (`anonymise_team_names`), także drużyny zwolnionej. Drużyna zostaje na liście startowej, zgłoszenia pozostałych członków zostają, a imię kapitana i jego miejscowość znikają z listy. Skład może potem zmieniać tylko Organizator. Usunięcie konta przez innego członka nie zmienia nazwy drużyny.
- **Środki bezpieczeństwa:**
  - tabela `teams` z RLS i `REVOKE ALL … FROM anon, authenticated`, odczyt tylko przez funkcje brzegowe i `start_list`;
  - strona składu tylko dla sesji kapitana, każdemu innemu odpowiada 404;
  - limity: 30 zmian składu i 120 odczytów na drużynę na godzinę, a każda osoba dodana do składu liczy się do limitu 30 osób na zapisującego na dobę z pkt 11.

## 13. Panel zgłoszeń Organizatora: wiadomości do zawodników i eksport CSV

- **Rola:** jak w pkt 10 — dane zgłoszeń LESZY.RUN przetwarza w imieniu Organizatora (art. 28 RODO, rejestr z art. 30 ust. 2). Wiadomość i eksport wykonuje właściciel lub administrator klubu Organizatora; członek klubu bez tej roli nie ma do nich dostępu.
- **Cel:** wiadomości Organizatora do osób zapisanych (organizacja zawodów, zmiany, przypomnienia), wiadomość do jednego zawodnika („Napisz do zawodnika”); przekazanie Organizatorowi listy zgłoszeń w pliku CSV do obsługi biura zawodów i pomiaru czasu; rozliczalność tych operacji.
- **Podstawa prawna:** art. 6(1)(b) RODO — umowa o udział w zawodach (informacje o zawodach, wydanie pakietów, pomiar czasu); art. 6(1)(f) — rozliczalność (dziennik `organizer_actions`) i ochrona przed nadużyciem (limity wysyłki).
- **Kategorie danych:**
  - wiadomości: adresy odbiorców są ustalane **w chwili wysyłki** z bieżących zgłoszeń (jeden e-mail na adres; dziecko przez adres opiekuna; nic do zgłoszeń anulowanych, wygasłych i nieopłaconych po terminie) i **nie są zapisywane per odbiorca**. W `organizer_messages` zostaje: wydarzenie, konto nadawcy (`sent_by`), temat, treść, filtr odbiorców (konkurencje, status, członkowie drużyn albo kapitanowie; przy wiadomości do jednego zawodnika — identyfikator jego zgłoszenia) i liczba wysłanych e-maili. Treść pisze Organizator, więc może zawierać dane osobowe. W `organizer_actions` — wpis `message_sent` (identyfikator wiadomości, liczba wysłanych i nieudanych, filtr) albo `message_test_sent` (wiadomość próbna, tylko na adres nadawcy);
  - eksport CSV: numer startowy, imię, nazwisko, data urodzenia, płeć, kategoria wiekowa, konkurencja, nazwa drużyny, klub, miejscowość, narodowość, e-mail, telefon, kontakt ICE (imię i telefon), opiekun (imię i nazwisko oraz e-mail opiekuna dziecka), status, wpłata i kwota zwrócona, stan akceptacji regulaminu, partner, data zapisu — dla wierszy wybranych filtrem panelu. Plik powstaje na żądanie i nie jest zapisywany po stronie LESZY.RUN. Każdy eksport zapisuje w `organizer_actions` wpis `csv_exported`: liczbę wierszy, **nazwy** użytych filtrów (konkurencja, status, partner) i to, czy użyto wyszukiwania — **nigdy wpisanego tekstu wyszukiwania**;
  - każdy wpis `organizer_actions` zawiera konto osoby działającej, klub, wydarzenie, adres IP i user agent.
- **Kategorie osób:** zawodnicy i osoby zapisujące, opiekunowie dzieci (odbiorcy wiadomości i osoby w eksporcie); właściciele i administratorzy klubów (nadawcy, autorzy eksportu).
- **Odbiorcy:** Twilio / SendGrid (wysyłka wiadomości, nadawca „<klub> przez LESZY.RUN”, odpowiedź na adres kontaktowy wydarzenia, nigdy na prywatny adres członka klubu); Supabase, Inc.; Organizator — plik CSV pobrany przez właściciela lub administratora klubu, od tej chwili w jego posiadaniu i na jego odpowiedzialność jako administratora danych zgłoszeń.
- **Transfery poza EOG:** jak w pkt 1 (Supabase, SendGrid).
- **Okres przechowywania:** `organizer_messages` i `organizer_actions` — razem z wydarzeniem, bez automatycznego usuwania (do wdrożenia razem z retencją zgłoszeń); przy usunięciu konta autora wpisy `organizer_actions` tracą adres IP i user agent. Przy usunięciu konta zawodnika wiadomości napisane tylko do niego (a także te do zgłoszenia jego dziecka, które dostał jako opiekun) są usuwane w całości, bo treść może go wskazywać; zostaje wpis `message_sent` w `organizer_actions` (identyfikatory i liczby, bez tematu i treści), wskazujący zgłoszenie już zanonimizowane. Wiadomość do wielu osób zostaje — nie wskazuje nikogo. Adresów odbiorców wiadomości nie ma czego usuwać — nie są zapisywane.
- **Prawa osób:** eksport (`export-my-data`) zawiera wpisy `organizer_actions` osoby, która działała jako Organizator (w tym wysyłki i eksporty CSV). Eksport zawodnika zawiera wiadomości napisane tylko do niego („Napisz do zawodnika”): wydarzenie, temat, treść i datę wysłania, z informacją, że pochodzą od Organizatora wydarzenia, bez wskazania osoby nadawcy; wiadomość do zgłoszenia dziecka trafia do eksportu opiekuna, który ją dostał. Wiadomości do wielu osób nie są zapisane per odbiorca, więc nie ma ich w eksporcie.
- **Środki bezpieczeństwa:**
  - dostęp tylko dla właściciela i administratora klubu, wydarzenie ustalane po stronie serwera z rekordu zgłoszenia, nigdy z żądania;
  - limity wysyłki (licznik w `otp_throttle`, przy awarii licznika wysyłka jest odmawiana): wiadomość zbiorcza 5 na wydarzenie na dobę, „Napisz do zawodnika” 30 na wydarzenie na godzinę, wiadomość próbna 10 na nadawcę na godzinę;
  - eksport, którego nie udało się zapisać w `organizer_actions`, nie jest wydawany (odpowiedź 503);
  - komórki CSV zabezpieczone przed formułami arkusza (tekst zawodnika zaczynający się od `=`, `+`, `-`, `@` jest poprzedzony apostrofem); odpowiedź bez zapisu w pamięci podręcznej (`Cache-Control: no-store`);
  - żaden adres nie trafia do logów funkcji.

## 14. Kody rabatowe, partnerzy i przekazanie pakietu innej osobie

- **Rola:** jak w pkt 10 — dane zgłoszeń LESZY.RUN przetwarza w imieniu Organizatora (art. 28 RODO, rejestr z art. 30 ust. 2); konta i dane płatności — LESZY.RUN jako administrator.
- **Cel:** obniżenie opłaty kodem rabatowym i przypisanie zgłoszenia partnerowi Organizatora (np. sklepowi, który rozdał kod) na potrzeby rozliczeń Organizatora; przekazanie opłaconego pakietu startowego innej osobie przez zawodnika (zaproszenie e-mailem) albo przez Organizatora w panelu.
- **Podstawa prawna:** art. 6(1)(b) RODO — umowa o udział w zawodach (przekazanie pakietu jest jej wykonaniem na żądanie zawodnika); art. 6(1)(f) — prawnie uzasadniony interes Organizatora w rozliczeniu z partnerami i ochrona formularza przed nadużyciem (limity zapytań).
- **Kategorie danych:**
  - `registrations.voucher_id`, `registrations.partner_id` — kod użyty przy zgłoszeniu i partner przypisany do zgłoszenia; `vouchers.note` i `partners.note` to notatki Organizatora, nie dane zawodnika;
  - `transfers.to_email` — adres osoby zaproszonej do przejęcia pakietu, podany przez zawodnika przekazującego (źródło danych w rozumieniu art. 14 ust. 2 lit. f) albo wpisany przez Organizatora;
  - `transfers.token_hash` — wyłącznie skrót SHA-256 tokenu z linku; sam token jest tylko we fragmencie adresu (`/przekazanie#…`) i nie trafia do bazy, logów ani odpowiedzi;
  - `transfers.from_profile_id`, `transfers.accepted_by_profile_id`, `registration_id`, `new_registration_id` i daty (utworzenie, ważność, przyjęcie, cofnięcie);
  - dane nowego zgłoszenia osoby przejmującej — jak w pkt 10 (osoba przyjmująca sama wypełnia formularz i akceptuje regulamin; przy przekazaniu przez Organizatora dostaje prośbę o akceptację jak w pkt 11, a jako źródło jej danych wskazany jest Organizator).
- **Kategorie osób:** zawodnicy przekazujący pakiet, osoby zaproszone i osoby przejmujące pakiet (także z przekazanego dalej linku).
- **Odbiorcy:**
  - partner, kod i notatki są widoczne wyłącznie dla Organizatora (panel zgłoszeń, eksport CSV); nie trafiają na listę startową, stronę zawodów, stronę zamówienia, stronę przekazania, do eksportu zawodnika ani do żadnego e-maila do zawodnika;
  - osoba zaproszona widzi tylko imię przekazującego (bez nazwiska, adresu, telefonu i daty urodzenia), zawody, konkurencję i cenę pakietu;
  - przekazujący dostaje e-mail z imieniem i nazwiskiem osoby, która przejęła pakiet, nigdy z jej adresem (osoba z przekazanego dalej linku jest nazwana tak samo);
  - przy przekazaniu przez Organizatora dotychczasowy zawodnik dostaje tylko informację, że pakiet przekazano innej osobie, bez jej imienia, nazwiska i adresu (minimalizacja danych: nie on wybrał tę osobę);
  - po zamknięciu zapisów uczestnik przekazujący zostaje na hoście pomiaru czasu, a alert dla operatora wskazuje identyfikator zgłoszenia, wydarzenie i numer startowy, bez imienia i nazwiska.
- **Transfery poza EOG:** jak w pkt 1.
- **Okres przechowywania:** wiersz `transfers` zostaje jako zapis tego, gdzie trafił pakiet (opłata zostaje przy pierwotnym zamówieniu, pkt 10). Link wygasa z końcem dnia `transfer_until` (czas warszawski). Dane zgłoszeń — jak w pkt 10 i 11.
- **Prawa osób:**
  - eksport (`export-my-data`) zawiera `transfers.sent` (przekazania pakietów tej osoby: rodzaj, stan, daty, wydarzenie; adres, który sama wpisała — przy przekazaniu przez Organizatora bez danych osoby przejmującej) i `transfers.received` (zaproszenia na jej adres i pakiety przez nią przejęte, z `from_name` — imieniem przekazującego albo nazwą klubu Organizatora — jako źródłem jej adresu; adres zaproszenia tylko wtedy, gdy jest jej własny). Skrót tokenu, partner, kod i notatki nie są eksportowane;
  - usunięcie konta (`delete-my-account`, funkcja `forget_transfer_parties`): jako przekazujący — otwarte zaproszenia zgłoszeń, które są anonimizowane, są cofane, a ich linki przestają działać; jako osoba zaproszona — otwarte zaproszenia na jej adres są cofane, a potem `to_email` jest usuwany ze wszystkich przekazań na ten adres. Wiersze przekazań zostają bez adresu.
- **Środki bezpieczeństwa:**
  - tabele `vouchers`, `partners` i `transfers` z RLS i `REVOKE ALL … FROM anon, authenticated`, dostęp tylko przez funkcje brzegowe i funkcje bazy dla service_role;
  - jedno przekazanie oczekujące na zgłoszenie; przyjęcie w jednej transakcji, warunkowane `UPDATE … WHERE status = 'pending' AND expires_at > now()`;
  - osoba przyjmująca potwierdza swój adres kodem wysłanym e-mailem (albo sesją na ten adres); limity: 10 wywołań na token i 30 na adres IP na godzinę, 5 zaproszeń na zgłoszenie na dobę;
  - e-maile z linkiem z tokenem bez śledzenia kliknięć (link nie jest przepisywany).

## Historia zmian

| Wersja | Data | Opis |
|---|---|---|
| 1.8 | 2026-11-01 | Dodano sekcję 14 (kody rabatowe i partnerzy widoczni tylko dla Organizatora; przekazanie pakietu: adres osoby zaproszonej podany przez przekazującego, przekazujący widzi imię i nazwisko osoby przejmującej, przy przekazaniu przez Organizatora dotychczasowy zawodnik nie dostaje danych osoby przejmującej; eksport i usuwanie konta). |
| 1.7 | 2026-11-01 | Sekcja 13: wiadomość do jednego zawodnika zawiera identyfikator jego zgłoszenia, więc jest w jego eksporcie (bez wskazania osoby nadawcy) i jest usuwana przy usunięciu konta; to samo dotyczy opiekuna przy wiadomości do zgłoszenia dziecka. Sekcja 10: `refunds.resolved_by` (notatka operatora przy ręcznym rozstrzygnięciu zwrotu) wskazuje operatora. |
| 1.6 | 2026-11-01 | Dodano sekcję 13 (panel zgłoszeń Organizatora: wiadomości do zawodników — adresy ustalane przy wysyłce, nie zapisywane per odbiorca — oraz eksport CSV z wpisem `csv_exported` w `organizer_actions`, bez tekstu wyszukiwania); w sekcji 11 doprecyzowano, że adres opiekuna dziecka zawiera eksport CSV. |
| 1.5 | 2026-11-01 | Dodano sekcję 12 (drużyny i sztafety: nazwa drużyny jako dana osobowa i jej usuwanie po 30 dniach oraz przy usunięciu konta kapitana, eksport, dane członków podawane przez kapitana, anonimizacja osoby usuniętej ze składu w chwili wymiany, nazwa drużyny przy zamówieniu wygasłym lub anulowanym). |
| 1.4 | 2026-10-29 | Dodano sekcję 11 (zapisy grupowe: opiekunowie, osoby dorosłe zapisane przez kogoś innego, prośby o akceptację regulaminu, podpis w biurze; eksport i usuwanie konta). |
| 1.3 | 2026-10-29 | Dodano sekcję 10 (zapisy online z płatnością przez dpay: zamówienia, płatności, zwroty, retencja 5 lat / 30 dni). |
| 1.2 | 2026-10-03 | Dodano sekcję 9 (rozpoznawanie numerów startowych z obrazu) — wdrożenie ekranu „Audyt kamery" i automatycznego purge po 30 dniach. |
| 1.1 | 2026-07-23 | Dodano sekcję 8 (członkostwo w klubach: `club_members`, `club_membership_log`) — pokrycie eksportu i usuwania danych po wdrożeniu soft-delete członkostwa. |
| 1.0 | 2026-06-04 | Pierwsza wersja ROPA — wdrożenie programu zgodności GDPR. |
