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
> W razie pytań — lukasz@leszy.run lub +48 784 640 977.
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
