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

## Historia zmian

| Wersja | Data | Opis |
|---|---|---|
| 1.0 | 2026-06-04 | Pierwsza wersja ROPA — wdrożenie programu zgodności GDPR. |
