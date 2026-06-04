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
