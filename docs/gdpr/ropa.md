# Rejestr Czynności Przetwarzania (ROPA) — Leszy.run

**Administrator:** Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice, NIP 6292248418, REGON 385416140, prowadzący serwis Leszy.run
**Kontakt:** lukasz@leszy.run
**Data ostatniej aktualizacji:** 2026-10-29
**Wersja:** 1.3

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
- **Kategorie danych:** `orders` — adres e-mail kupującego (`buyer_email`), powiązanie z kontem, kwoty w groszach (opłaty startowe, wsparcie LESZY.RUN, opłata za obsługę płatności, razem), wybór wsparcia, status, terminy; `order_lines` — kwota per zgłoszenie i nazwa progu cenowego; `payment_attempts` — identyfikator transakcji dpay, kwota, status; `payment_events` — log komunikacji z dpay po redakcji (`redactDpay`): adres e-mail płatnika wyłącznie jako skrót SHA-256 (`email_sha256`), baza odrzuca klucz `email` i adres w treści; `refunds` — kwota, powód, wynik zwrotu; `operator_alerts` — zgłoszenia dla operatora (np. rozbieżna kwota, nieudany zwrot) z identyfikatorami transakcji i kwotami. Brak danych kart i rachunków płatnika (obsługuje je dpay).
- **Kategorie osób:** uczestnicy zawodów i osoby zapisujące (kupujący), wyłącznie zalogowani — zamówienie wymaga konta.
- **Odbiorcy:** Payments Lab sp. z o.o. z siedzibą w Warszawie (KRS 0000845085), operator dpay.pl — przyjmuje płatność i wykonuje zwrot jako dostawca usług płatniczych (odrębny administrator danych płatności po swojej stronie); Supabase, Inc. (baza danych, funkcje); Twilio / SendGrid (e-maile o płatności, przypomnienia, zwroty); Organizator — liczba opłaconych i oczekujących zgłoszeń oraz status płatności przy zgłoszeniu.
- **Transfery poza EOG:** jak w pkt 1 (Supabase, SendGrid); dpay przetwarza dane w Polsce.
- **Okres przechowywania:**
  - zamówienia z ruchem pieniędzy (opłacone lub zwrócone) wraz z próbami płatności, logiem `payment_events` i zwrotami — **5 lat od końca roku kalendarzowego, w którym dokonano płatności** (przepisy podatkowe); automatyczne usuwanie po tym okresie nie jest jeszcze wdrożone (pozycja do wdrożenia przed upływem pierwszego okresu);
  - zgłoszenie nieopłacone w terminie (wygasłe) oraz anulowane bez wpłaty — **30 dni** od wygaśnięcia / anulowania: dane osobowe zgłoszenia są anonimizowane, a w zamówieniu bez żadnego ruchu pieniędzy usuwany jest `buyer_email` (zadanie pg_cron `registration-purge-expired`, codziennie 01:45 UTC);
  - przy usunięciu konta (`delete-my-account`) zamówienie zachowuje kwoty, statusy i identyfikatory transakcji (art. 17 ust. 3 lit. b i e), a `buyer_email` jest usuwany; z treści zgłoszeń operatora dotyczących tych zamówień usuwany jest adres e-mail.
- **Prawa osób:** eksport (`export-my-data`) obejmuje zamówienia kupującego z kwotami, pozycjami, próbami płatności, zwrotami i zgłoszeniami operatora dotyczącymi zamówienia; dla właściciela klubu — historię zmian rachunku do wypłat wydarzenia (`event_payout_history`), które sam wprowadził. Bieżący rachunek do wypłat wydarzenia (`event_payout_details`) należy do klubu, nie do osoby; gdy odbiorcą jest osoba fizyczna bez konta, jej żądanie z art. 15 obsługiwane jest ręcznie.
- **Środki bezpieczeństwa:** wszystkie tabele z RLS i `REVOKE ALL … FROM anon, authenticated`, dostęp wyłącznie przez funkcje z kluczem usługi; kwoty liczone wyłącznie po stronie serwera, w całkowitych groszach; podpis każdego powiadomienia dpay weryfikowany przed decyzją; idempotencja potwierdzeń i zwrotów po stronie LESZY.RUN; sekrety dpay tylko w sekretach funkcji Supabase; zadania okresowe z sygnałem życia (`registration_job_heartbeats`) i alarmem e-mail przy zatrzymaniu.

## Historia zmian

| Wersja | Data | Opis |
|---|---|---|
| 1.3 | 2026-10-29 | Dodano sekcję 10 (zapisy online z płatnością przez dpay: zamówienia, płatności, zwroty, retencja 5 lat / 30 dni). |
| 1.2 | 2026-10-03 | Dodano sekcję 9 (rozpoznawanie numerów startowych z obrazu) — wdrożenie ekranu „Audyt kamery" i automatycznego purge po 30 dniach. |
| 1.1 | 2026-07-23 | Dodano sekcję 8 (członkostwo w klubach: `club_members`, `club_membership_log`) — pokrycie eksportu i usuwania danych po wdrożeniu soft-delete członkostwa. |
| 1.0 | 2026-06-04 | Pierwsza wersja ROPA — wdrożenie programu zgodności GDPR. |
