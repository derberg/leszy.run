import { POLICY_VERSION } from '../lib/policyVersion'

export default function Reklamacje() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-text-bright">Procedura reklamacyjna</h1>
        <p className="mt-2 text-sm text-apex-muted">Wersja {POLICY_VERSION}</p>
      </header>

      <section id="zakres">
        <h2 className="font-display text-2xl uppercase">§1. Zakres</h2>
        <p className="mt-3">Procedura dotyczy usług świadczonych drogą elektroniczną w serwisie Leszy.run przez Usługodawcę: Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice, NIP 6292248418, REGON 385416140.</p>
        <p className="mt-3">Pojęcia pisane wielką literą mają znaczenie nadane im w <a href="/regulamin" className="text-apex-yellow underline">Regulaminie serwisu</a>.</p>
        <p className="mt-3">Sprawy dotyczące przebiegu zawodów, klasyfikacji i protestów co do wyników rozstrzyga Organizator zgodnie z regulaminem danych zawodów. Błąd w wyniku można zgłosić także Usługodawcy, który przekaże zgłoszenie Organizatorowi.</p>
      </section>

      <section id="zlozenie" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§2. Jak złożyć reklamację</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>mailowo na adres <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>,</li>
          <li>listownie na adres: Wookiee Łukasz Górnicki, ul. Wierzbowa 2, 44-144 Nieborowice.</li>
        </ul>
      </section>

      <section id="tresc" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§3. Co powinna zawierać reklamacja</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>imię i nazwisko lub adres email powiązany z Kontem,</li>
          <li>opis problemu i datę jego wystąpienia,</li>
          <li>oczekiwany sposób rozwiązania.</li>
        </ul>
        <p className="mt-3">Brak któregoś z tych elementów nie powoduje odrzucenia reklamacji. Jeśli do jej rozpatrzenia potrzebne są dodatkowe informacje, Usługodawca poprosi o nie.</p>
      </section>

      <section id="termin" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§4. Termin i odpowiedź</h2>
        <p className="mt-3">Usługodawca rozpatruje reklamację w terminie 14 dni od jej otrzymania. Odpowiedź zostanie wysłana na adres email, z którego przyszła reklamacja, a w przypadku reklamacji złożonej listownie na wskazany w niej adres.</p>
      </section>

      <section id="pozasadowe" className="mt-8">
        <h2 className="font-display text-2xl uppercase">§5. Pozasądowe rozwiązywanie sporów</h2>
        <p className="mt-3">Konsument może skorzystać z bezpłatnej pomocy miejskiego lub powiatowego rzecznika konsumentów, wojewódzkiego inspektoratu Inspekcji Handlowej lub organizacji konsumenckich. Informacje o tych możliwościach są dostępne na stronie <a href="https://uokik.gov.pl" className="text-apex-yellow underline" target="_blank" rel="noopener noreferrer">uokik.gov.pl</a>.</p>
      </section>
    </article>
  )
}
