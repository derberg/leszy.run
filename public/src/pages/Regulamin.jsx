import { POLICY_VERSION } from '../lib/policyVersion'

export default function Regulamin() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-text-bright">Regulamin serwisu Leszy.run</h1>
        <p className="mt-2 text-sm text-apex-muted">Wersja {POLICY_VERSION}</p>
      </header>

      <section id="definicje">
        <h2 className="font-display text-2xl uppercase">§1. Definicje</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Usługodawca:</strong> Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice, NIP 6292248418, REGON 385416140, prowadzący serwis Leszy.run pod adresem www.leszy.run, kontakt: lukasz@leszy.run.</li>
          <li><strong>Serwis:</strong> witryna internetowa Leszy.run wraz z funkcjonalnościami dostępnymi po rejestracji konta.</li>
          <li><strong>Użytkownik:</strong> osoba fizyczna posiadająca konto w Serwisie.</li>
          <li><strong>Konto:</strong> indywidualny profil Użytkownika, identyfikowany adresem email.</li>
          <li><strong>Organizator:</strong> podmiot organizujący zawody biegowe, korzystający z usług pomiaru czasu Usługodawcy.</li>
          <li><strong>Uczestnik:</strong> osoba startująca w zawodach obsługiwanych przez Leszy.run.</li>
        </ul>
      </section>

      <section id="warunki" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§2. Warunki świadczenia usług elektronicznych</h2>
        <p className="mt-3">Usługodawca świadczy drogą elektroniczną nieodpłatnie następujące usługi:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>rejestrację i prowadzenie Konta,</li>
          <li>prezentację kalendarza biegów i wyników zawodów,</li>
          <li>tworzenie klubów i zarządzanie nimi,</li>
          <li>przyjmowanie zapisów na zawody,</li>
          <li>składanie zgłoszeń wydarzeń i innych wkładów społecznościowych.</li>
        </ul>
        <p className="mt-3">Organizatorowi Usługodawca świadczy ponadto usługi odpłatne, które Organizator może włączyć dla swoich zawodów:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>przyjmowanie płatności online za udział w zawodach,</li>
          <li>wysyłkę wiadomości email do Uczestników,</li>
          <li>wysyłkę wiadomości SMS do Uczestników.</li>
        </ul>
        <p className="mt-3">Cenę i warunki usługi odpłatnej Usługodawca przekazuje Organizatorowi przed jej włączeniem. Usługa jest świadczona dopiero po zaakceptowaniu tych warunków przez Organizatora.</p>
        <p className="mt-3">Dla Użytkowników i Uczestników korzystanie z Serwisu jest nieodpłatne. Wysokość opłaty startowej za udział w zawodach ustala Organizator.</p>
        <p className="mt-3">Wymagania techniczne: przeglądarka internetowa z obsługą JavaScript i ciasteczek, aktywne połączenie internetowe.</p>
      </section>

      <section id="rejestracja" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§3. Rejestracja i konto</h2>
        <p className="mt-3">Rejestracja wymaga podania adresu email i akceptacji niniejszego Regulaminu oraz <a href="/polityka-prywatnosci" className="text-apex-yellow underline">Polityki prywatności</a>.</p>
        <p className="mt-3">Konto może posiadać wyłącznie osoba pełnoletnia. Konta osób małoletnich mogą być zakładane wyłącznie przez ich opiekunów prawnych.</p>
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

      <section id="reklamacje" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§5. Reklamacje</h2>
        <p className="mt-3">Zasady składania i rozpatrywania reklamacji określa <a href="/reklamacje" className="text-apex-yellow underline">Procedura reklamacyjna</a>.</p>
      </section>

      <section id="rozwiazanie" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§6. Rozwiązanie umowy</h2>
        <p className="mt-3">Użytkownik może w każdej chwili usunąć konto przez funkcjonalność „Usuń konto" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>. Usunięcie konta jest nieodwracalne — tego samego adresu email nie da się ponownie wykorzystać do rejestracji.</p>
        <p className="mt-3">Usługodawca może rozwiązać umowę z Użytkownikiem w przypadku rażącego naruszenia Regulaminu, po uprzednim wezwaniu do zaprzestania naruszeń.</p>
      </section>

      <section id="prawo" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§7. Prawo właściwe i sąd właściwy</h2>
        <p className="mt-3">Prawem właściwym dla niniejszego Regulaminu jest prawo polskie. Sądem właściwym jest sąd właściwy miejscowo dla siedziby Usługodawcy.</p>
      </section>

      <section id="postanowienia" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§8. Postanowienia końcowe</h2>
        <p className="mt-3">Regulamin wchodzi w życie z dniem {POLICY_VERSION}. Usługodawca może zmieniać Regulamin — o zmianach Użytkownicy będą informowani z 14-dniowym wyprzedzeniem przez komunikat w Serwisie.</p>
      </section>
    </article>
  )
}
