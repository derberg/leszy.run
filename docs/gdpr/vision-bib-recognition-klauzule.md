# Rozpoznawanie numerów startowych z obrazu: klauzule do wdrożenia

**Status:** propozycja, do akceptacji przed uruchomieniem systemu
**Dotyczy:** kamera na mecie odczytująca numery startowe (projekt opisany w `docs/superpowers/specs/2026-09-30-vision-bib-recognition-design.md`)
**Data:** 2026-09-30

Ten plik zbiera gotowe teksty do wklejenia. Nic z tego nie obowiązuje, dopóki system nie zostanie uruchomiony na zawodach.

## Dlaczego podstawą jest umowa, a nie zgoda

Zgoda w rozumieniu RODO musi być dobrowolna i możliwa do wycofania w każdej chwili (art. 7 ust. 3 RODO). Zgoda, której uczestnik nie może odmówić i nadal wystartować, nie jest ważną zgodą (art. 7 ust. 4 RODO). Gdyby regulamin nazywał to zgodą i jednocześnie uzależniał od niej start, organ nadzorczy mógłby uznać ją za nieważną, a wtedy przetwarzanie zostaje bez podstawy prawnej.

Dlatego podpisanie regulaminu jest zawarciem umowy, nie wyrażeniem zgody. Pomiar czasu opiera się na art. 6 ust. 1 lit. b RODO (wykonanie umowy). Przy tej podstawie nie ma prawa do wycofania, co odpowiada temu, jak zawody działają w praktyce.

Wykorzystanie zdjęć do relacji i promocji to osobny cel i osobna podstawa: art. 6 ust. 1 lit. f RODO (prawnie uzasadniony interes). Ta podstawa daje uczestnikowi prawo sprzeciwu, a pierwsza nie. Dlatego oba cele muszą być rozdzielone w tekście, a nie zlepione w jedno zdanie.

## Klauzula do regulaminu zawodów

Do wklejenia jako osobny paragraf.

> **§ X. Rejestracja obrazu na linii mety**
>
> 1. Organizator prowadzi na linii mety rejestrację obrazu w celu odczytu numerów startowych i przypisania uczestnikom czasów końcowych.
> 2. Przetwarzanie obejmuje odczyt numeru startowego widocznego na numerze uczestnika. Organizator nie stosuje rozpoznawania twarzy, nie tworzy wzorców biometrycznych i nie identyfikuje uczestników na podstawie wizerunku.
> 3. Na zarejestrowanych zdjęciach mogą być widoczne twarze uczestników. Zdjęcia stanowią dane osobowe i podlegają zasadom określonym w ust. 5 i 6.
> 4. Podstawą przetwarzania w celu pomiaru czasu jest art. 6 ust. 1 lit. b RODO, to jest wykonanie umowy, której przedmiotem jest udział w zawodach. Podstawą wykorzystania zdjęć do relacji z wydarzenia i promocji jest art. 6 ust. 1 lit. f RODO, to jest prawnie uzasadniony interes Organizatora.
> 5. Zdjęcia przechowywane są wyłącznie na urządzeniu Organizatora znajdującym się na mecie. Nie są przesyłane do chmury ani udostępniane podmiotom zewnętrznym.
> 6. Zdjęcia usuwane są automatycznie po upływie 30 dni od dnia zawodów.
> 7. Uczestnikowi przysługuje prawo dostępu do danych, ich sprostowania, usunięcia oraz ograniczenia przetwarzania. W zakresie przetwarzania opartego na art. 6 ust. 1 lit. f RODO uczestnikowi przysługuje prawo wniesienia sprzeciwu.

## Akapit do polityki prywatności

Do wklejenia w sekcji o danych uczestników zawodów.

> **Rejestracja obrazu na mecie.** Na linii mety niektórych zawodów prowadzimy rejestrację obrazu, aby odczytać numery startowe i przypisać zawodnikom czasy końcowe. Odczytujemy wyłącznie numer startowy. Nie stosujemy rozpoznawania twarzy ani żadnej innej identyfikacji biometrycznej. Na zdjęciach mogą być widoczne twarze uczestników. Zdjęcia pozostają na urządzeniu znajdującym się na mecie, nie trafiają do chmury i są automatycznie usuwane po 30 dniach od zawodów. Podstawą przetwarzania w celu pomiaru czasu jest wykonanie umowy (art. 6 ust. 1 lit. b RODO), a w celu relacji z wydarzenia prawnie uzasadniony interes administratora (art. 6 ust. 1 lit. f RODO).

Zmiana polityki prywatności wymaga podbicia `POLICY_VERSION` w `public/src/lib/policyVersion.js`. Baner cookie wykryje różnicę i zapyta ponownie każdego użytkownika, więc termin tej zmiany warto zaplanować.

## Wpis do rejestru czynności przetwarzania

Do dopisania w `docs/gdpr/ropa.md` w momencie uruchomienia systemu, nie wcześniej.

- **Cel:** Odczyt numerów startowych z obrazu zarejestrowanego na linii mety w celu przypisania czasów końcowych oraz weryfikacji wyników, których nie zarejestrował pomiar chipowy.
- **Podstawa prawna:** Art. 6 ust. 1 lit. b RODO (wykonanie umowy) dla pomiaru czasu. Art. 6 ust. 1 lit. f RODO (prawnie uzasadniony interes) dla relacji z wydarzenia.
- **Kategorie danych:** zdjęcia uczestników wykonane na linii mety, numer startowy odczytany ze zdjęcia, znacznik czasu.
- **Kategorie osób:** uczestnicy zawodów prowadzonych przez Leszy.run.
- **Odbiorcy:** brak. Zdjęcia nie opuszczają urządzenia Organizatora.
- **Transfery poza EOG:** brak.
- **Okres przechowywania:** 30 dni od dnia zawodów, usuwanie automatyczne.
- **Środki bezpieczeństwa:** urządzenie pod kontrolą Organizatora, brak synchronizacji do Supabase, brak kopii w chmurze, automatyczne usuwanie po upływie okresu przechowywania.

## Ocena skutków

Systematyczna rejestracja obrazu wszystkich uczestników jest nową czynnością przetwarzania i wymaga przeglądu wobec `docs/gdpr/dpia-participants.md`. Przegląd ma odpowiedzieć, czy potrzebna jest odrębna ocena skutków w rozumieniu art. 35 RODO.

Argumenty, które ten przegląd może wziąć pod uwagę:

- Przetwarzanie ogranicza się do odczytu numeru wydrukowanego na kartce. Nie powstaje profil, wzorzec biometryczny ani powiązanie wizerunku z tożsamością.
- Dane nie opuszczają urządzenia. Nie ma odbiorców, procesorów ani transferu poza EOG.
- Okres przechowywania jest krótki i egzekwowany automatycznie.
- Uczestnicy są informowani w regulaminie przed startem.

## Zakaz rozszerzania celu

Rozpoznawanie twarzy, porównywanie wizerunku z bazą zdjęć i każda inna identyfikacja biometryczna pozostają poza zakresem tego systemu. Nie jest to opis bieżącej wersji, tylko stała granica. Dodanie takiej funkcji oznacza inny cel, inną podstawę prawną i wymaga oceny skutków przed napisaniem kodu, ponieważ dane biometryczne służące do identyfikacji osoby należą do szczególnych kategorii danych z art. 9 RODO.
