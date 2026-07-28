# Punkty kontrolne — instrukcja

Punkt kontrolny to miejsce na trasie, w którym rejestrujemy, że zawodnik tamtędy
przebiegł. Rejestracja może się odbywać na dwa sposoby — jeden punkt może
korzystać z obu naraz, a przejścia i tak się nie zdublują:

- **Ręcznie** — wolontariusz wpisuje numery startowe na telefonie (strona
  `/volunteer`). Nic nie trzeba instalować.
- **Automatycznie przez RFID** — Raspberry Pi z czytnikiem Impinj R700 czyta
  chipy zawodników i sam wysyła przejścia do chmury (`checkpoint-agent`).
  Instrukcja sprzętowa: [../checkpoint-agent/README.md](../checkpoint-agent/README.md).

Obie ścieżki zapisują to samo — przejścia pojawiają się w tych samych miejscach
(wyniki na żywo, „Blisko Mety", podium). Obowiązuje zasada **pierwsze przejście
wygrywa**: jeśli i wolontariusz, i antena zarejestrują ten sam numer na tym
samym punkcie, liczy się pierwszy zapis.

---

## Część 1 — Dodanie punktu kontrolnego (panel admina)

Wykonuje organizator w panelu, przed zawodami. To samo dotyczy punktów ręcznych
i RFID — antena nie tworzy punktów, tylko dołącza do już istniejącego.

1. Otwórz wydarzenie w panelu admina → zakładka **Punkty kontrolne**.
2. Kliknij **Dodaj punkt** i wypełnij:
   - **Nazwa** (wymagana) — np. `Km 5 – Górka`.
   - **Km marker** — kilometr trasy (np. `5.0`). Steruje kolejnością punktów przy
     szacowaniu pozycji na żywo. Zostaw puste, jeśli nie znasz.
   - **Kategorie** — puste = punkt dotyczy wszystkich kategorii. Zaznacz
     konkretne, jeśli punkt jest tylko na jednej z tras.
   - **Prywatny** — punkt widoczny wyłącznie w panelu admina, ukryty na stronie
     publicznej.
   - **Blisko mety** — włącza publiczną zakładkę „Blisko Mety". Tylko jeden punkt
     w wydarzeniu może być tak oznaczony.
3. **Zapisz**.

Na liście każdy punkt ma **link dla wolontariusza** (`…/volunteer?checkpoint=…`).
Skopiuj go („Kopiuj link" albo „Kopiuj wszystkie linki") i wyślij osobie, która
będzie wpisywać numery na telefonie. Jeśli punkt obsługuje wyłącznie antena RFID,
link możesz zignorować.

> Usunięcie punktu kasuje też wszystkie zarejestrowane na nim przejścia — usuwaj
> tylko punkty utworzone omyłkowo.

---

## Część 2 — Konfiguracja punktu RFID (Raspberry Pi + czytnik)

Potrzebne tylko dla punktów z anteną. Pełny opis sprzętu, instalacji na Pi i
listy kontrolnej przed startem jest w
[../checkpoint-agent/README.md](../checkpoint-agent/README.md); tutaj jest sama
ścieżka „krok po kroku" na dzień zawodów.

### 2a. Wygeneruj PIN punktów kontrolnych (panel admina, raz na wydarzenie)

1. Otwórz wydarzenie → zakładka **Ustawienia**.
2. Karta **PIN punktów kontrolnych** → **Regeneruj PIN**.
3. Przepisz PIN — wpiszesz go na każdym Pi.

Ten PIN jest **inny niż PIN check-in** i autoryzuje pobranie listy „numer
startowy ↔ chip" na urządzenie. Nie udostępniaj go uczestnikom. Jeśli wycieknie
— zregeneruj: pracujące już anteny działają dalej (mają listę zapisaną), nowy
PIN potrzebny jest tylko przy kolejnej konfiguracji.

### 2b. Uruchom agenta na Pi i skonfiguruj punkt

1. Włącz Raspberry Pi z podłączonym czytnikiem R700 i uruchom agenta (patrz
   README — na stałe najlepiej przez `systemd`, żeby wstawał sam po zasilaniu).
2. Połącz telefon/laptop z siecią Pi i otwórz **`http://<adres-pi>:8080`**.
3. W kreatorze podaj po kolei:
   - **PIN** z kroku 2a,
   - **Wydarzenie** (lista pobiera się sama),
   - **Punkt kontrolny** (ten utworzony w Części 1),
   - **IP czytnika** — adres R700 w sieci Pi.
   - *Zaawansowane (opcjonalnie):* login/hasło czytnika, ręczny adres brokera MQTT.
4. **Zapisz i pobierz listę** — agent ściągnie listę numerów i pokaże, ile
   chipów wczytał.
5. **START** — agent skonfiguruje czytnik i zacznie nagrywać.

Od tej chwili każde przejście zawodnika trafia na pulpit agenta i do chmury, a
stamtąd do wyników — dokładnie jak wpis wolontariusza.

### 2c. Pulpit — co obserwować w trakcie

- **Odczyty / potwierdzone / w zasięgu** — czy antena w ogóle widzi chipy.
- **Kolejka** — ile przejść czeka na wysłanie. Rośnie przy słabym zasięgu LTE,
  spada po odzyskaniu łącza. Nic nie ginie — wysyłka dogania po powrocie sieci.
- **Ostatni upload** — zielony < 30 s, żółty < 2 min, czerwony dłużej lub przy
  błędzie. Trwały czerwony = sprawdź internet na Pi.
- **Nieznane tagi** — chipy spoza listy. Jeśli *wszystko* jest nieznane, wybrano
  złe wydarzenie — zresetuj i skonfiguruj ponownie.
- **Czytnik** — czerwony baner „CZYTNIK NIEDOSTĘPNY" znaczy, że R700 nie
  odpowiada (zasilanie/kabel PoE). Agent sam przywróci konfigurację, gdy czytnik
  wróci.

Po restarcie Pi w trakcie zawodów agent **sam wznawia** nagrywanie i nie liczy
przejść ponownie. Przy niezsynchronizowanym zegarze start jest zablokowany
(zły znacznik czasu psuje kolejność na trasie) — poczekaj na synchronizację NTP
lub wymuś start świadomie.

---

## Część 3 — Test bez czytnika (na sucho)

Można przejść całą ścieżkę bez R700 — przydatne do nauki przed zawodami:

1. W kreatorze rozwiń **Zaawansowane** i zaznacz **„Tryb testowy bez czytnika
   (symulacja)"** — pole IP czytnika przestaje być wymagane.
2. Skonfiguruj (PIN → wydarzenie → punkt) i wciśnij **START**. Pulpit pokaże
   badge „TRYB TESTOWY — BEZ CZYTNIKA".
3. Zasymuluj przejście zawodnika (na maszynie z działającym Mosquitto):
   ```bash
   cd checkpoint-agent
   node scripts/simulate-reads.js --epc <EPC uczestnika z tego wydarzenia>
   ```
4. Po ~3 s pulpit pokaże potwierdzenie, a przejście pojawi się w wynikach — tak
   samo jak z prawdziwą anteną. Ćwiczy całą ścieżkę oprócz samego R700.
