// „Informacja o danych” shown with the registration form (RA2): the data
// information of docs/legal/zapisy/informacja-o-danych-zawodnika.md (version
// below), with the event, the organizer and the organizer's contact address
// filled in from the event page snapshot. Drafting notes and the „Do
// weryfikacji” list of the source stay in the source; the organizer's postal
// address and NIP/KRS are not in the snapshot and are left out. Ruling
// P2-R21: lines about payment (dpay, paid status, payment records, unpaid
// entries) appear only for a paid event, the team name only with team
// competitions. Ruling P2-R31: nationality is named only when the event's
// form asks for it. Ruling P2-R33: image publication is a term of the
// regulamin (contract + legitimate interest, art. 81 of the copyright act),
// never described as consent.
//
// Keep in step with the source document when it changes.

export const RUNNER_DATA_INFO_VERSION = '2026-11-v2'

/**
 * @param {{ eventName: string, organizerName: string|null, contactEmail: string|null, paid?: boolean, teams?: boolean, nationality?: boolean }} p
 * @returns {{ title: string, sections: Array<{ heading: string, blocks: Array<string | { list: string[] } | { table: string[][] }> }> }}
 */
export function runnerDataInfo({ eventName, organizerName, contactEmail, paid = false, teams = false, nationality = false }) {
  const listed = ['imię', 'nazwisko', 'miejscowość', 'klub', 'konkurencja', 'kategoria wiekowa', ...(teams ? ['nazwa drużyny'] : [])]
  const listedText = paid
    ? `${listed.join(', ')} i informacja, czy zgłoszenie jest opłacone`
    : `${listed.slice(0, -1).join(', ')} i ${listed.at(-1)}`
  const only = (cond, x) => (cond ? [x] : [])
  const unpublished = ['Data urodzenia', 'adres e-mail', 'numer telefonu', ...only(nationality, 'narodowość')]
  const organizer = organizerName || 'Organizator zawodów'
  const contact = contactEmail
    ? `W sprawach danych możesz pisać do Organizatora: ${contactEmail}.`
    : 'W sprawach danych możesz pisać do Organizatora na adres podany na stronie zawodów.'
  return {
    title: 'Informacja o przetwarzaniu danych zawodnika',
    sections: [
      {
        heading: 'Kto jest administratorem Twoich danych',
        blocks: [
          `Administratorem Twoich danych podanych przy zapisie na ${eventName} jest Organizator: ${organizer}. ${contact}`,
          'Zapisy, płatności i — jeżeli tak podano na stronie zawodów — pomiar czasu prowadzi w imieniu Organizatora LESZY.RUN (Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice, NIP 6292248418, kontakt: lukasz@leszy.run), na podstawie umowy powierzenia przetwarzania danych (art. 28 RODO).',
        ],
      },
      {
        heading: 'Po co i na jakiej podstawie',
        blocks: [
          {
            table: [
              ['Cel', 'Podstawa prawna'],
              ['Przyjęcie zapisu, zawarcie i wykonanie umowy o udział w zawodach: lista startowa, przydział do kategorii, kontakt w sprawie zawodów, przekazanie pakietu innej osobie, zwrot opłaty', 'art. 6 ust. 1 lit. b RODO (umowa)'],
              ['Pomiar czasu i publikacja listy startowej oraz wyników w zakresie określonym w regulaminie zawodów', 'art. 6 ust. 1 lit. b RODO (umowa)'],
              ['Utrwalenie wizerunku podczas zawodów (zdjęcia, wideo) i jego publikacja przez Organizatora w relacjach i wynikach zawodów, zgodnie z regulaminem zawodów', 'art. 6 ust. 1 lit. b RODO (umowa: postanowienie regulaminu zawodów) oraz art. 6 ust. 1 lit. f RODO (prawnie uzasadniony interes Organizatora: relacjonowanie zawodów); rozpowszechnianie wizerunku — art. 81 ustawy o prawie autorskim i prawach pokrewnych'],
              ['Kontakt z osobą wskazaną na wypadek nagłego zdarzenia w trakcie zawodów', 'art. 6 ust. 1 lit. f RODO (prawnie uzasadniony interes Organizatora: bezpieczeństwo uczestników); w razie zagrożenia życia lub zdrowia — art. 6 ust. 1 lit. d RODO (żywotny interes)'],
              ['Rozliczenia, rachunkowość i podatki', 'art. 6 ust. 1 lit. c RODO (obowiązek prawny, w szczególności przepisy podatkowe)'],
              ['Ustalenie, dochodzenie i obrona roszczeń', 'art. 6 ust. 1 lit. f RODO (prawnie uzasadniony interes Organizatora)'],
            ],
          },
          'Podanie danych oznaczonych w formularzu jako wymagane jest warunkiem zapisu. Bez nich Organizator nie może przyjąć zgłoszenia. Pozostałe dane podajesz dobrowolnie.',
        ],
      },
      {
        heading: 'Co jest publikowane',
        blocks: [
          `Na publicznej liście startowej: ${listedText}. W wynikach: imię, nazwisko, klub, kategoria, numer startowy, czasy i miejsce. ${unpublished.join(', ')} i dane osoby do kontaktu w nagłych wypadkach nie są publikowane.`,
          'Podczas zawodów Organizator może utrwalać Twój wizerunek (zdjęcia, wideo) i publikować go w relacjach i wynikach zawodów. Jest to warunek udziału określony w regulaminie zawodów, a nie zgoda. Wobec publikacji opartej na prawnie uzasadnionym interesie Organizatora możesz wnieść sprzeciw (art. 21 RODO): napisz do Organizatora.',
        ],
      },
      {
        heading: 'Kto otrzymuje dane',
        blocks: [{
          list: [
            'LESZY.RUN, który prowadzi zapisy w imieniu Organizatora, oraz jego dostawcy usług: Supabase, Inc. (baza danych), Vercel, Inc. (hosting), Twilio Inc. / SendGrid (e-mail), SMSAPI sp. z o.o. (SMS przed zawodami, jeżeli Organizator z niego korzysta). Część z nich ma siedzibę w USA; dane są przekazywane na podstawie: standardowe klauzule umowne Komisji Europejskiej lub EU-US Data Privacy Framework (art. 46 ust. 2 lit. c / art. 45 RODO). Aktualna lista: www.leszy.run/podmioty-przetwarzajace.',
            ...only(paid, 'Payments Lab sp. z o.o. (dpay.pl) — operator płatności, w zakresie potrzebnym do przeprowadzenia płatności i zwrotu.'),
            'Osoby upoważnione przez Organizatora (np. obsługa biura zawodów).',
            'Wszyscy odwiedzający stronę zawodów — w zakresie listy startowej i wyników.',
            'Organy publiczne, jeżeli wymaga tego prawo.',
          ],
        }],
      },
      {
        heading: 'Jak długo',
        blocks: [{
          list: [
            'Numer telefonu i dane osoby do kontaktu w nagłych wypadkach: 30 dni po dniu zawodów.',
            ...only(paid, 'Zgłoszenie, które nie zostało opłacone w terminie: 30 dni po jego wygaśnięciu.'),
            'Pozostałe dane zgłoszenia: 12 miesięcy po dniu zawodów, a dłużej, jeżeli jest to potrzebne do obrony przed roszczeniami — do upływu terminu ich przedawnienia.',
            ...only(paid, 'Dane o płatnościach: 5 lat od końca roku kalendarzowego, w którym dokonano płatności (przepisy podatkowe).'),
            'Wyniki zawodów: bezterminowo, w archiwum wyników.',
            'Zdjęcia i nagrania z zawodów: przez czas publikacji relacji i wyników albo do uwzględnienia Twojego sprzeciwu.',
          ],
        }],
      },
      {
        heading: 'Twoje prawa',
        blocks: [
          'Masz prawo: dostępu do swoich danych i otrzymania ich kopii (art. 15 RODO), ich sprostowania (art. 16), usunięcia (art. 17), ograniczenia przetwarzania (art. 18), przenoszenia danych przetwarzanych na podstawie umowy (art. 20) oraz sprzeciwu wobec przetwarzania opartego na prawnie uzasadnionym interesie (art. 21). Napisz do Organizatora. Jeżeli masz konto LESZY.RUN, swoje zgłoszenia pobierzesz też w profilu („Pobierz moje dane”).',
          'Masz prawo wnieść skargę do Prezesa Urzędu Ochrony Danych Osobowych, ul. Stawki 2, 00-193 Warszawa (uodo.gov.pl).',
          'Twoje dane nie służą do zautomatyzowanego podejmowania decyzji ani profilowania w rozumieniu art. 22 RODO. Przydział do kategorii wiekowej na podstawie daty urodzenia jest wyliczeniem według regulaminu zawodów, a nie oceną.',
        ],
      },
      {
        heading: 'Osoba do kontaktu w nagłych wypadkach',
        blocks: [
          'Jeżeli formularz o nią prosi, podajesz imię i numer telefonu innej osoby. Powiedz jej o tym. Jej dane służą tylko do kontaktu w razie zdarzenia w czasie zawodów, nie są publikowane i są usuwane 30 dni po zawodach. Źródłem tych danych jesteś Ty (art. 14 ust. 2 lit. f RODO).',
        ],
      },
      {
        heading: 'Konto LESZY.RUN',
        blocks: [
          'Potwierdzając zapis kodem z e-maila, zakładasz konto w serwisie LESZY.RUN (albo logujesz się do istniejącego). Za dane konta odpowiada LESZY.RUN jako odrębny administrator — zasady opisuje Polityka prywatności: www.leszy.run/polityka-prywatnosci.',
        ],
      },
    ],
  }
}
