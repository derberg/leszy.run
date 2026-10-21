import { POLICY_VERSION } from '../lib/policyVersion'

export default function Regulamin() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-text-bright">Regulamin serwisu LESZY.RUN</h1>
        <p className="mt-2 text-sm text-apex-muted">Wersja {POLICY_VERSION}</p>
      </header>

      <section id="definicje">
        <h2 className="font-display text-2xl uppercase">§1. Definicje</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Usługodawca:</strong> Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice, NIP 6292248418, REGON 385416140, prowadzący serwis LESZY.RUN pod adresem www.leszy.run, kontakt: lukasz@leszy.run.</li>
          <li><strong>Serwis:</strong> witryna internetowa LESZY.RUN wraz z funkcjonalnościami dostępnymi po rejestracji konta.</li>
          <li><strong>Użytkownik:</strong> osoba fizyczna posiadająca konto w Serwisie.</li>
          <li><strong>Konto:</strong> indywidualny profil Użytkownika, identyfikowany adresem email.</li>
          <li><strong>Organizator:</strong> podmiot organizujący zawody biegowe, korzystający z usług pomiaru czasu Usługodawcy.</li>
          <li><strong>Uczestnik:</strong> osoba startująca w zawodach obsługiwanych przez LESZY.RUN.</li>
        </ul>
      </section>

      <section id="warunki" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§2. Warunki świadczenia usług elektronicznych</h2>
        <p className="mt-3">Usługodawca świadczy drogą elektroniczną nieodpłatnie następujące usługi:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>rejestrację i prowadzenie Konta,</li>
          <li>prezentację kalendarza biegów i wyników zawodów,</li>
          <li>tworzenie klubów i zarządzanie nimi,</li>
          <li>przyjmowanie zapisów na zawody, bez obsługi płatności online,</li>
          <li>składanie zgłoszeń wydarzeń i innych wkładów społecznościowych.</li>
        </ul>
        <p className="mt-3">Usługodawca może świadczyć Organizatorowi usługi dodatkowe, w tym odpłatne. Ich zakres, cenę i warunki Usługodawca przekazuje Organizatorowi przed włączeniem usługi, a usługa jest świadczona dopiero po zaakceptowaniu tych warunków.</p>
        <p className="mt-3">Dla Użytkowników i Uczestników korzystanie z Serwisu jest nieodpłatne. Wysokość opłaty startowej za udział w zawodach ustala Organizator.</p>
        <p className="mt-3">Wymagania techniczne: przeglądarka internetowa z obsługą JavaScript i ciasteczek, aktywne połączenie internetowe.</p>
      </section>

      <section id="rejestracja" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§3. Rejestracja i konto</h2>
        <p className="mt-3">Rejestracja wymaga podania adresu email i akceptacji niniejszego Regulaminu oraz <a href="/polityka-prywatnosci" className="text-apex-yellow underline">Polityki prywatności</a>.</p>
        <p className="mt-3">Konto może założyć osoba, która ukończyła 16 lat.</p>
      </section>

      <section id="zasady" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§4. Zasady korzystania</h2>
        <p className="mt-3">Użytkownik zobowiązuje się do:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>nieumieszczania treści bezprawnych, obraźliwych lub naruszających dobra osobiste innych osób,</li>
          <li>niepodejmowania działań mogących zakłócić działanie Serwisu (np. ataki, scraping z nadmierną częstotliwością),</li>
          <li>podawania prawdziwych danych przy rejestracji,</li>
          <li>nieudostępniania konta osobom trzecim.</li>
        </ul>
      </section>

      <section id="zapisy" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§5. Zapisy na zawody</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-6">
          <li>Zapisując się na zawody, Uczestnik zawiera umowę o udział w zawodach z Organizatorem. Usługodawca przyjmuje zapisy w imieniu Organizatora i nie jest stroną tej umowy.</li>
          <li>Za przebieg zawodów, ich odwołanie lub zmianę oraz zwrot opłat odpowiada Organizator, na zasadach określonych w regulaminie zawodów.</li>
          <li>Uczestnikowi nie przysługuje ustawowe prawo odstąpienia od umowy o udział w zawodach (art. 38 pkt 12 ustawy o prawach konsumenta). Zasady rezygnacji i ewentualnego zwrotu opłaty określa Organizator w regulaminie zawodów.</li>
        </ol>
      </section>

      <section id="tresci" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§6. Treści Użytkowników</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-6">
          <li>Treści bezprawne lub naruszające Regulamin można zgłosić na adres <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>. Zgłoszenie powinno wskazywać treść, jej lokalizację i powód zgłoszenia. Ten adres jest też punktem kontaktowym dla organów i Użytkowników, a korespondencja odbywa się w języku polskim.</li>
          <li>Usługodawca może usunąć treść lub zablokować Konto, jeśli narusza ono prawo lub Regulamin. O takiej decyzji informuje Użytkownika, podając jej uzasadnienie, a Użytkownik może się od niej odwołać w trybie reklamacji.</li>
        </ol>
      </section>

      <section id="reklamacje" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§7. Reklamacje</h2>
        <p className="mt-3">Zasady składania i rozpatrywania reklamacji określa <a href="/reklamacje" className="text-apex-yellow underline">Procedura reklamacyjna</a>.</p>
      </section>

      <section id="rozwiazanie" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§8. Rozwiązanie umowy</h2>
        <p className="mt-3">Użytkownik może w każdej chwili usunąć konto przez funkcjonalność „Usuń konto" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>. Usunięcie konta jest nieodwracalne — tego samego adresu email nie da się ponownie wykorzystać do rejestracji.</p>
        <p className="mt-3">Usługodawca może rozwiązać umowę z Użytkownikiem w przypadku rażącego naruszenia Regulaminu, po uprzednim wezwaniu do zaprzestania naruszeń.</p>
      </section>

      <section id="prawo" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§9. Prawo właściwe i sąd właściwy</h2>
        <p className="mt-3">Prawem właściwym dla niniejszego Regulaminu jest prawo polskie. Sądem właściwym jest sąd właściwy miejscowo dla siedziby Usługodawcy, z wyjątkiem Użytkowników będących konsumentami, wobec których sąd właściwy ustala się według przepisów ogólnych.</p>
      </section>

      <section id="postanowienia" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§10. Postanowienia końcowe</h2>
        <p className="mt-3">Regulamin wchodzi w życie z dniem {POLICY_VERSION}. O zmianie Regulaminu Usługodawca informuje Użytkowników mailowo i komunikatem w Serwisie co najmniej 14 dni przed jej wejściem w życie. Użytkownik, który nie akceptuje zmian, może przed tym terminem usunąć Konto.</p>
      </section>
    </article>
  )
}
