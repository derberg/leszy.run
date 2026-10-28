// „Informacja o danych” shown with the registration form (RA2): the data
// information of docs/legal/zapisy/informacja-o-danych-zawodnika.md (version
// below), with the event, the organizer and the organizer's contact address
// filled in from the event page snapshot. Drafting notes and the „Do
// weryfikacji” list of the source stay in the source; the organizer's postal
// address and NIP/KRS are not in the snapshot and are left out.
//
// Keep in step with the source document when it changes.

export const RUNNER_DATA_INFO_VERSION = '2026-11-v1'

/**
 * @param {{ eventName: string, organizerName: string|null, contactEmail: string|null }} p
 * @returns {{ title: string, sections: Array<{ heading: string, blocks: Array<string | { list: string[] } | { table: string[][] }> }> }}
 */
export function runnerDataInfo({ eventName, organizerName, contactEmail }) {
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
          'Na publicznej liście startowej: imię, nazwisko, miejscowość, klub, konkurencja, kategoria wiekowa, nazwa drużyny i informacja, czy zgłoszenie jest opłacone. W wynikach: imię, nazwisko, klub, kategoria, numer startowy, czasy i miejsce. Data urodzenia, adres e-mail, numer telefonu i dane osoby do kontaktu w nagłych wypadkach nie są publikowane.',
        ],
      },
      {
        heading: 'Kto otrzymuje dane',
        blocks: [{
          list: [
            'LESZY.RUN, który prowadzi zapisy w imieniu Organizatora, oraz jego dostawcy usług: Supabase, Inc. (baza danych), Vercel, Inc. (hosting), Twilio Inc. / SendGrid (e-mail), SMSAPI sp. z o.o. (SMS przed zawodami, jeżeli Organizator z niego korzysta). Część z nich ma siedzibę w USA. Aktualna lista: www.leszy.run/podmioty-przetwarzajace.',
            'Payments Lab sp. z o.o. (dpay.pl) — operator płatności, w zakresie potrzebnym do przeprowadzenia płatności i zwrotu.',
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
            'Zgłoszenie, które nie zostało opłacone w terminie: 30 dni po jego wygaśnięciu.',
            'Pozostałe dane zgłoszenia: 12 miesięcy po dniu zawodów, a dłużej, jeżeli jest to potrzebne do obrony przed roszczeniami — do upływu terminu ich przedawnienia.',
            'Dane o płatnościach: 5 lat od końca roku kalendarzowego, w którym dokonano płatności (przepisy podatkowe).',
            'Wyniki zawodów: bezterminowo, w archiwum wyników.',
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
