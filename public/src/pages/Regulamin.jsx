import { POLICY_VERSION } from '../lib/policyVersion'

export default function Regulamin() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-bright">Regulamin serwisu Leszy.run</h1>
        <p className="mt-2 text-sm text-apex-muted">Wersja {POLICY_VERSION}</p>
      </header>

      <section>
        <h2 className="font-display text-2xl uppercase">§1. Definicje</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Usługodawca:</strong> Łukasz Górnicki, prowadzący serwis Leszy.run pod adresem www.leszy.run, kontakt: lukasz@leszy.run.</li>
          <li><strong>Serwis:</strong> witryna internetowa Leszy.run wraz z funkcjonalnościami dostępnymi po rejestracji konta.</li>
          <li><strong>Użytkownik:</strong> osoba fizyczna posiadająca konto w Serwisie.</li>
          <li><strong>Konto:</strong> indywidualny profil Użytkownika, identyfikowany adresem email.</li>
          <li><strong>Organizator:</strong> podmiot organizujący zawody biegowe, korzystający z usług pomiaru czasu Usługodawcy.</li>
          <li><strong>Uczestnik:</strong> osoba startująca w zawodach obsługiwanych przez Leszy.run.</li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§2. Warunki świadczenia usług elektronicznych</h2>
        <p className="mt-3">Usługodawca świadczy drogą elektroniczną nieodpłatne usługi obejmujące: rejestrację konta, prezentację kalendarza biegów, prezentację wyników biegów, składanie zgłoszeń wydarzeń i innych wkładów społecznościowych.</p>
        <p className="mt-3">Wymagania techniczne: przeglądarka internetowa z obsługą JavaScript i ciasteczek, aktywne połączenie internetowe.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§3. Rejestracja i konto</h2>
        <p className="mt-3">Rejestracja wymaga podania adresu email i akceptacji niniejszego Regulaminu oraz <a href="/polityka-prywatnosci" className="text-apex-yellow underline">Polityki prywatności</a>.</p>
        <p className="mt-3">Konto może posiadać wyłącznie osoba pełnoletnia. Konta osób małoletnich mogą być zakładane wyłącznie przez ich opiekunów prawnych.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§4. Zasady korzystania</h2>
        <p className="mt-3">Użytkownik zobowiązuje się do:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>nieumieszczania treści bezprawnych, obraźliwych lub naruszających dobra osobiste innych osób,</li>
          <li>niepodejmowania działań mogących zakłócić działanie Serwisu (np. ataki, scraping z nadmierną częstotliwością),</li>
          <li>podawania prawdziwych danych przy rejestracji,</li>
          <li>nieudostępniania konta osobom trzecim.</li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§5. Reklamacje</h2>
        <p className="mt-3">Reklamacje dotyczące działania Serwisu należy zgłaszać na adres <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>. Reklamacja zostanie rozpatrzona w terminie 28 dni od daty zgłoszenia.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§6. Rozwiązanie umowy</h2>
        <p className="mt-3">Użytkownik może w każdej chwili usunąć konto przez funkcjonalność „Usuń konto" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>. Usunięcie konta jest nieodwracalne — tego samego adresu email nie da się ponownie wykorzystać do rejestracji.</p>
        <p className="mt-3">Usługodawca może rozwiązać umowę z Użytkownikiem w przypadku rażącego naruszenia Regulaminu, po uprzednim wezwaniu do zaprzestania naruszeń.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§7. Prawo właściwe i sąd właściwy</h2>
        <p className="mt-3">Prawem właściwym dla niniejszego Regulaminu jest prawo polskie. Sądem właściwym jest sąd właściwy miejscowo dla siedziby Usługodawcy.</p>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl uppercase">§8. Postanowienia końcowe</h2>
        <p className="mt-3">Regulamin wchodzi w życie z dniem {POLICY_VERSION}. Usługodawca może zmieniać Regulamin — o zmianach Użytkownicy będą informowani z 14-dniowym wyprzedzeniem przez komunikat w Serwisie.</p>
      </section>
    </article>
  )
}
