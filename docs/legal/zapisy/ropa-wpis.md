# ROPA — wpisy dla zapisów online

**Status:** projekt do weryfikacji prawnej; po akceptacji przenieść do `docs/gdpr/ropa.md` jako wersję 1.3
**Podstawa:** art. 30 ust. 1 RODO (rejestr czynności administratora) i art. 30 ust. 2 RODO (rejestr kategorii czynności podmiotu przetwarzającego).

Obecny rejestr ma jedną część (administrator) i stwierdza w sekcji „Rola Leszy.run”, że nie występują relacje powierzenia z organizatorami. Zapisy online wymagają drugiej części — rejestru podmiotu przetwarzającego — oraz zmiany tego zdania:

> **Rola Leszy.run (proponowane brzmienie).** Leszy.run jest administratorem dla czynności 1–9 oraz 10–13 części A. Dla danych osób zapisujących się na zawody przez Serwis Leszy.run jest podmiotem przetwarzającym, działającym w imieniu Organizatora na podstawie umowy organizatora (część B). [DO WERYFIKACJI: czy czynność 2 (pomiar czasu, dane z importów) pozostaje w roli administratora.]

Wspólne dla wszystkich wpisów poniżej:
- **Administrator / podmiot przetwarzający:** Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice, NIP 6292248418, REGON 385416140, kontakt: lukasz@leszy.run. Inspektor ochrony danych: nie wyznaczono. [DO WERYFIKACJI: czy skala zapisów i dane osób niepełnoletnich nie wymagają wyznaczenia IOD — art. 37 ust. 1 lit. b RODO.]
- **Środki bezpieczeństwa (art. 30 ust. 1 lit. g, ust. 2 lit. d):** tabele zapisów z RLS i odebranymi uprawnieniami `anon`/`authenticated` (dostęp wyłącznie przez funkcje serwerowe z kluczem usługi); kontrola roli w klubie przy każdej operacji Organizatora; logowanie kodem jednorazowym z limitami prób i blokadą adresów usuniętych kont; operacje wielowierszowe jako atomowe funkcje bazy; tokeny linków losowe 32 B, przechowywane jako SHA-256, jednorazowe, z terminem ważności; weryfikacja sumy kontrolnej powiadomień dpay; rejestr działań Organizatora `organizer_actions` (append-only); historia zmian rachunku do wypłat z powiadomieniem e-mail; szyfrowanie TLS i szyfrowanie danych w spoczynku u Supabase; publiczne odczyty wyłącznie przez migawki CDN z ograniczonym zakresem pól.

---

## Część A — czynności, w których Leszy.run jest administratorem (art. 30 ust. 1)

### 10. Konta zakładane przy zapisie na zawody

Rozszerzenie czynności 1.
- **Cel:** założenie konta osobie zapisującej się (albo zalogowanie do istniejącego) — kod z e-maila jest jednocześnie potwierdzeniem zapisu i logowaniem; dostęp do własnych zgłoszeń, przekazanie pakietu, potwierdzenie regulaminu przez osobę zapisaną przez kogoś innego.
- **Podstawa prawna:** art. 6 ust. 1 lit. b RODO — umowa o świadczenie usług drogą elektroniczną (akceptacja Regulaminu serwisu w formularzu zapisu).
- **Kategorie osób:** osoby zapisujące się, opiekunowie osób niepełnoletnich, kapitanowie drużyn, dorośli członkowie drużyn i grup, osoby, którym przekazano pakiet.
- **Kategorie danych:** e-mail, identyfikator profilu, sesje logowania, kody jednorazowe (skrót), data akceptacji Regulaminu.
- **Odbiorcy:** Supabase, Inc.; Twilio Inc. / SendGrid.
- **Transfery poza EOG:** USA — [DO UZUPEŁNIENIA: SCC / EU-US DPF dla każdego dostawcy].
- **Okres przechowywania:** jak czynność 1; adres usuniętego konta pozostaje jako skrót SHA-256 w `deleted_email_hashes`.

### 11. Płatności, zwroty i wypłaty dla Organizatorów

- **Cel:** przyjmowanie opłat w imieniu Organizatorów, zwroty, rozliczenie i wypłata Organizatorom, wykazanie przepływów środków, obowiązki podatkowe Leszy.run, obrona przed roszczeniami.
- **Podstawa prawna:** art. 6 ust. 1 lit. c RODO (przepisy podatkowe — przechowywanie dokumentacji), art. 6 ust. 1 lit. b RODO (umowa organizatora; umowa z Uczestnikiem o obsługę płatności), art. 6 ust. 1 lit. f RODO (ustalenie, dochodzenie i obrona roszczeń).
- **Kategorie osób:** płatnicy (osoby zapisujące), osoby, za które zapłacono, przedstawiciele Organizatorów, odbiorcy wypłat (także beneficjenci zbiórek charytatywnych).
- **Kategorie danych:** `orders` (kwoty, wybór Wsparcia LESZY.RUN, e-mail kupującego, status, identyfikator transakcji dpay, daty), `order_lines`, `refunds` (kwota, kto zlecił), `payment_events` (pełna treść żądań i powiadomień dpay), zestawienia wypłat, dane odbiorcy wypłaty (nazwa, NIP/KRS, adres, IBAN).
- **Odbiorcy:** Payments Lab sp. z o.o. (dpay.pl) — odrębny administrator [DO WERYFIKACJI]; bank Leszy.run; biuro rachunkowe [DO UZUPEŁNIENIA, jeżeli jest]; Supabase, Inc.
- **Transfery poza EOG:** jak czynność 1 (Supabase).
- **Okres przechowywania:** 5 lat od końca roku kalendarzowego, w którym dokonano płatności. [DO WERYFIKACJI: termin z art. 86 Ordynacji podatkowej / art. 74 ustawy o rachunkowości dla formy opodatkowania Leszy.run.]

### 12. Organizatorzy: umowa, dane do wypłat, rejestr działań, lista oczekujących

- **Cel:** zawarcie i wykonanie umowy organizatora; ochrona środków Organizatorów przed zmianą rachunku przez osobę nieuprawnioną; rozliczalność działań w panelu (zwroty, wiadomości, przekazania, zmiany po publikacji, kody rabatowe); obsługa listy klubów oczekujących na włączenie zapisów.
- **Podstawa prawna:** art. 6 ust. 1 lit. b RODO (umowa organizatora); art. 6 ust. 1 lit. f RODO (bezpieczeństwo środków, rozliczalność, obrona roszczeń).
- **Kategorie osób:** właściciele i administratorzy klubów, osoby zgłaszające klub na listę oczekujących.
- **Kategorie danych:** `organizer_agreements` (konto akceptującego, nazwa klubu, wersja, data, IP, przeglądarka); `club_payout_details` i `club_payout_history` (nazwa, NIP, KRS, adres, IBAN, kto i kiedy zmienił, wartości przed i po); `organizer_actions` (wykonujący, klub, wydarzenie, czynność, cel, treść, IP, przeglądarka); `organizer_messages` (nadawca, treść, liczba odbiorców); `registration_waitlist` (klub, zgłaszający, data).
- **Odbiorcy:** Supabase, Inc.; Twilio Inc. / SendGrid (powiadomienia o zmianie rachunku, zgłoszenia na listę oczekujących).
- **Transfery poza EOG:** jak czynność 1.
- **Okres przechowywania:** przez czas trwania umowy i [DO UZUPEŁNIENIA: proponowane 6 lat] po jej rozwiązaniu; lista oczekujących — do włączenia zapisów klubowi lub usunięcia klubu. Eksport danych (`export-my-data`) obejmuje akceptacje umowy, działania, zmiany rachunku i zgłoszenia na listę wykonane przez daną osobę.

### 13. Archiwum wyników zawodów z zapisów online

- **Cel:** publiczne archiwum sportowe wyników po zakończeniu zawodów.
- **Podstawa prawna:** art. 6 ust. 1 lit. f RODO — uzasadniony interes Leszy.run (archiwum sportowe, weryfikowalność wyników), jak czynność 2. [DO WERYFIKACJI: art. 28 ust. 10 RODO — zob. „Do weryfikacji”, pkt 1.]
- **Kategorie danych:** imię, nazwisko, klub, kategoria, numer startowy, czasy, miejsce, status.
- **Okres przechowywania:** bezterminowo; anonimizacja na sprzeciw (art. 21) lub przy usunięciu konta.

---

## Część B — rejestr podmiotu przetwarzającego (art. 30 ust. 2)

### B1. Zapisy na zawody, płatności i pomiar czasu w imieniu Organizatorów

- **Administratorzy (art. 30 ust. 2 lit. a):** Organizatorzy, którzy zaakceptowali umowę organizatora. Aktualny wykaz z nazwą, NIP/KRS, adresem i datą akceptacji prowadzi Serwis w tabelach `organizer_agreements` i `club_payout_details`; wykaz jest częścią rejestru i może być wygenerowany na żądanie organu nadzorczego. Przedstawiciel administratora: właściciel klubu wskazany w Serwisie.
- **Kategorie przetwarzania (art. 30 ust. 2 lit. b):**
  1. przyjmowanie zgłoszeń przez formularz, potwierdzanie adresów e-mail;
  2. prowadzenie listy zgłoszeń w panelu Organizatora, eksport CSV na polecenie Organizatora;
  3. publikacja listy startowej (imię, nazwisko, miejscowość, klub, konkurencja, kategoria, drużyna, status opłacenia);
  4. wysyłka wiadomości: potwierdzenia, przypomnienia o płatności, prośby o potwierdzenie regulaminu, przekazania pakietów, zwroty, wiadomości Organizatora;
  5. przekazanie do dpay danych niezbędnych do płatności i zwrotu;
  6. przekazywanie pakietów między osobami;
  7. zapis akceptacji regulaminu zawodów i oświadczeń (`consent_acceptances`);
  8. synchronizacja zgłoszeń opłaconych do tabeli `participants` i na urządzenia pomiarowe (gdy pomiar prowadzi Leszy.run);
  9. pomiar czasu i publikacja wyników na polecenie Organizatora;
  10. kody rabatowe i przypisanie zgłoszeń do partnerów (widoczne wyłącznie dla Organizatora);
  11. usuwanie danych po upływie okresów retencji.
- **Kategorie osób:** uczestnicy (także niepełnoletni), opiekunowie, osoby do kontaktu w nagłych wypadkach, członkowie drużyn, osoby przyjmujące pakiet.
- **Kategorie danych:** jak w umowie organizatora §10 ust. 7; brak danych szczególnych kategorii (art. 9) i danych kart płatniczych.
- **Dalsze podmioty przetwarzające:** Supabase, Inc.; Vercel, Inc.; Twilio Inc. / SendGrid; SMSAPI sp. z o.o. (tylko SMS przed zawodami); Payments Lab sp. z o.o. w zakresie, w jakim działa na polecenie [DO WERYFIKACJI].
- **Transfery do państw trzecich (art. 30 ust. 2 lit. c):** USA — Supabase, Inc., Vercel, Inc., Twilio Inc. jako podmioty z siedzibą w USA, przy przechowywaniu danych w UE (Supabase eu-west-1, Vercel dub1) i wysyłce e-mail przez infrastrukturę SendGrid. Zabezpieczenie: [DO UZUPEŁNIENIA: SCC / EU-US DPF dla każdego].
- **Okres przechowywania (informacyjnie, wynika z poleceń administratora):** telefon i kontakt w nagłych wypadkach — 30 dni po zawodach (w Supabase automatycznie, na urządzeniach pomiarowych skryptem uruchamianym przez operatora); dane zgłoszeń wygasłych — 30 dni; pozostałe dane zgłoszenia — [DO UZUPEŁNIENIA: 12 miesięcy] po zawodach; surowe odczyty bramek — 90 dni; zdjęcia z kamery na mecie — 30 dni.
- **Środki bezpieczeństwa (art. 30 ust. 2 lit. d):** jak we wstępie.

---

## Historia zmian (do dopisania w `docs/gdpr/ropa.md`)

| Wersja | Data | Opis |
|---|---|---|
| 1.3 | [DO UZUPEŁNIENIA] | Zapisy online: czynności 10–13 (administrator), część B (podmiot przetwarzający dla Organizatorów), zmiana sekcji „Rola Leszy.run”. |

---

## Do weryfikacji

1. **Archiwum wyników (czynność 13)** — czy Leszy.run może przejąć wyniki do archiwum jako administrator, skoro w trakcie zawodów przetwarzał je jako podmiot przetwarzający (art. 28 ust. 10 RODO). Alternatywy: Organizator udostępnia wyniki Leszy.run (wtedy Leszy.run informuje na podstawie art. 14), albo archiwum jest częścią powierzenia i kończy się z umową.
2. **Czynność 2 (pomiar czasu z importów)** — czy zostaje w roli administratora; dwa modele w jednym serwisie wymagają jasnego kryterium (zawody z zapisami w Serwisie vs. lista z importu).
3. **IOD** — czy przetwarzanie danych osób niepełnoletnich na dużą skalę wymaga wyznaczenia inspektora (art. 37 ust. 1 lit. b RODO; wytyczne WP243).
4. **Wykaz administratorów w części B** — czy odesłanie do tabel w bazie spełnia art. 30 ust. 3 (forma pisemna, w tym elektroniczna).
5. **`payment_events` z pełną treścią powiadomień dpay** — sprawdzić, jakie dane płatnika zawiera powiadomienie (np. nazwa rachunku, IBAN płatnika) i czy przechowywanie całości przez 5 lat jest konieczne.
6. **Retencja telefonów na urządzeniach pomiarowych** zależy od ręcznego uruchomienia skryptu przez operatora — czy to wystarczający środek.
