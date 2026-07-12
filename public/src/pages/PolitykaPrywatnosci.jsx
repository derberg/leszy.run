import { POLICY_VERSION } from '../lib/policyVersion'

export default function PolitykaPrywatnosci() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-text-bright">Polityka prywatności</h1>
        <p className="mt-2 text-sm text-apex-muted">Wersja {POLICY_VERSION}</p>
      </header>

      <section id="administrator">
        <h2 className="font-display text-2xl uppercase">1. Administrator danych osobowych</h2>
        <p className="mt-3">Łukasz Górnicki, prowadzący serwis Leszy.run. Kontakt: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
        <p className="mt-3"><strong>Leszy.run jest administratorem danych osobowych przetwarzanych w serwisie — niezależnie od tego, czy zostały podane bezpośrednio przy rejestracji konta, czy pozyskane od organizatora biegu przy imporcie listy startowej.</strong> Organizator biegu pozostaje administratorem danych w swoim własnym systemie zapisów, lecz po przekazaniu danych do Leszy.run administratorem tych danych w naszej bazie jest wyłącznie Leszy.run. Wszelkie wnioski (dostęp, usunięcie, sprostowanie, sprzeciw) należy kierować do <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
      </section>

      <section id="zakres" className="mt-8">
        <h2 className="font-display text-2xl uppercase">2. Zakres przetwarzanych danych</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Konto użytkownika:</strong> email, nazwa użytkownika, nazwa wyświetlana, telefon (opcjonalnie), data urodzenia, płeć, miasto, województwo, klub.</li>
          <li><strong>Uczestnik biegu (zaimportowany przez organizatora):</strong> imię, nazwisko, numer startowy, kategoria, tag RFID, telefon (opcjonalnie), email (opcjonalnie).</li>
          <li><strong>Pomiary czasu:</strong> surowe odczyty bramek, potwierdzenia przejść, obserwacje na punktach kontrolnych, wyniki końcowe.</li>
          <li><strong>Check-in:</strong> potwierdzenie akceptacji regulaminu biegu, znaczniki czasowe, dokumenty wymagane.</li>
          <li><strong>Analityka:</strong> pliki cookie Google Analytics 4 — wyłącznie po wyrażeniu zgody.</li>
          <li><strong>Obserwowane biegi (ulubione):</strong> lista biegów oznaczonych gwiazdką, powiązana z kontem użytkownika.</li>
        </ul>
      </section>

      <section id="cele" className="mt-8">
        <h2 className="font-display text-2xl uppercase">3. Cele i podstawy prawne przetwarzania</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Konto użytkownika:</strong> Art. 6(1)(b) RODO — wykonanie umowy o świadczenie usług elektronicznych.</li>
          <li><strong>Uczestnictwo w biegu (dane od organizatora):</strong> Art. 6(1)(f) RODO — uzasadniony interes Leszy.run (świadczenie usługi pomiaru czasu i prowadzenie archiwum sportowego). Uczestnik może w każdej chwili wnieść sprzeciw — wówczas dane zostaną zanonimizowane.</li>
          <li><strong>Pomiary czasu:</strong> Art. 6(1)(f) RODO — uzasadniony interes (integralność i weryfikowalność wyników).</li>
          <li><strong>Wyniki publiczne i archiwum:</strong> Art. 6(1)(f) RODO — uzasadniony interes (archiwum sportowe, transparentność).</li>
          <li><strong>SMS check-in:</strong> Art. 6(1)(b) RODO — wykonanie umowy.</li>
          <li><strong>Analityka:</strong> Art. 6(1)(a) RODO — zgoda wyrażana w banerze cookie.</li>
          <li><strong>Obserwowane biegi i powiadomienia:</strong> Art. 6(1)(b) RODO — wykonanie umowy (funkcja obserwowania biegów). Lista obserwowanych biegów jest przechowywana na koncie i służy do powiadomień w aplikacji o zmianach dotyczących biegu (odwołanie biegu, pojawienie się linku do zapisów, zbliżający się termin zapisów). Jeśli masz ustawiony klub, pozostali członkowie Twojego klubu widzą, które biegi obserwujesz — możesz to wyłączyć w ustawieniach prywatności w swoim profilu. Opcjonalny tygodniowy digest e-mailowy z obserwowanymi biegami jest wysyłany wyłącznie po wyrażeniu zgody (checkbox w profilu) i można go wyłączyć w dowolnym momencie — podstawa: Art. 6(1)(a) RODO. Dane obserwowanych biegów są uwzględniane w eksporcie danych (Art. 15/20) i usuwane przy likwidacji konta (Art. 17).</li>
        </ul>
      </section>

      <section id="retencja" className="mt-8">
        <h2 className="font-display text-2xl uppercase">4. Okres przechowywania danych</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Dane konta użytkownika:</strong> bezterminowo, do żądania usunięcia konta.</li>
          <li><strong>Surowe odczyty bramek (gate_events, gate_crossings):</strong> 90 dni po zakończeniu biegu (purge automatyczny).</li>
          <li><strong>Wyniki biegu:</strong> bezterminowo (archiwum). Po usunięciu konta — anonimizowane w wynikach (oznaczone jako „Uczestnik anonimowy").</li>
          <li><strong>Logi zgody (consent_log):</strong> bezterminowo (dowód zgody).</li>
          <li><strong>Dane analityczne GA4:</strong> 14 miesięcy (konfiguracja Google).</li>
        </ul>
        <p className="mt-3"><strong>Po usunięciu konta na Leszy.run, ten sam adres email nie może już zostać użyty do ponownej rejestracji.</strong> Jest to celowa polityka — usunięcie konta jest ostateczne i nieodwracalne.</p>
      </section>

      <section id="odbiorcy" className="mt-8">
        <h2 className="font-display text-2xl uppercase">5. Odbiorcy danych</h2>
        <p className="mt-3">Pełna lista podmiotów przetwarzających dane wraz z linkami do ich umów DPA dostępna jest pod adresem: <a href="/podmioty-przetwarzajace" className="text-apex-yellow underline">/podmioty-przetwarzajace</a>.</p>
        <p className="mt-3">Korzystamy z następujących podmiotów przetwarzających: Supabase, Inc. (baza danych i autentykacja), Vercel, Inc. (hosting), SMSAPI sp. z o.o. (SMS), Twilio Inc. / SendGrid (email transakcyjny), Google Ireland Ltd. (analityka GA4), Google Fonts (CDN czcionek).</p>
      </section>

      <section id="prawa" className="mt-8">
        <h2 className="font-display text-2xl uppercase">6. Prawa osoby, której dane dotyczą</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Prawo dostępu (Art. 15):</strong> przycisk „Pobierz moje dane" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo sprostowania (Art. 16):</strong> edycja profilu w <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo usunięcia (Art. 17):</strong> przycisk „Usuń konto" w sekcji <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo ograniczenia przetwarzania (Art. 18):</strong> kontakt <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</li>
          <li><strong>Prawo do przenoszenia danych (Art. 20):</strong> eksport JSON dostępny w <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Prawo sprzeciwu (Art. 21):</strong> kontakt <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</li>
          <li><strong>Cofnięcie zgody:</strong> link „Zarządzaj cookies" w stopce w każdej chwili.</li>
        </ul>
      </section>

      <section id="skarga" className="mt-8">
        <h2 className="font-display text-2xl uppercase">7. Prawo wniesienia skargi do organu nadzorczego</h2>
        <p className="mt-3">Mają Państwo prawo wniesienia skargi do Prezesa Urzędu Ochrony Danych Osobowych (UODO): <a href="https://uodo.gov.pl/pl/p/skargi" className="text-apex-yellow underline" target="_blank" rel="noopener">https://uodo.gov.pl/pl/p/skargi</a>.</p>
      </section>

      <section id="cookies" className="mt-8">
        <h2 className="font-display text-2xl uppercase">8. Pliki cookie</h2>
        <p className="mt-3">Serwis korzysta z dwóch kategorii plików cookie:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Niezbędne</strong> (np. ustawienia motywu, sesja logowania) — używane bez konieczności wyrażenia zgody, na podstawie Art. 6(1)(f) RODO (działanie serwisu).</li>
          <li><strong>Analityczne</strong> (Google Analytics 4) — używane wyłącznie po wyrażeniu zgody w banerze cookie. Zgoda może być cofnięta w każdej chwili przez link „Zarządzaj cookies" w stopce.</li>
        </ul>
      </section>

      <section id="scrapers" className="mt-8">
        <h2 className="font-display text-2xl uppercase">9. Dane o wydarzeniach biegowych</h2>
        <p className="mt-3">Z publicznie dostępnych stron internetowych organizatorów biegów agregujemy wyłącznie informacje o wydarzeniach (nazwa, data, miejsce, dystanse, link do zapisów). <strong>Nie przetwarzamy danych osobowych organizatorów ani uczestników z tych źródeł.</strong></p>
      </section>

      <section id="zmiany" className="mt-8">
        <h2 className="font-display text-2xl uppercase">10. Zmiany polityki</h2>
        <p className="mt-3">Aktualna wersja polityki: <strong>{POLICY_VERSION}</strong>. Historia zmian dostępna jest w repozytorium publicznym: <a href="https://github.com/derberg/BeepBeep/commits/main/public/src/pages/PolitykaPrywatnosci.jsx" className="text-apex-yellow underline" target="_blank" rel="noopener">GitHub</a>.</p>
        <p className="mt-3">Przy istotnych zmianach polityki użytkownicy zostaną poproszeni o ponowne wyrażenie zgody w banerze cookie.</p>
      </section>

      <section id="kontakt" className="mt-8">
        <h2 className="font-display text-2xl uppercase">11. Kontakt</h2>
        <p className="mt-3">Wszystkie pytania dotyczące przetwarzania danych osobowych: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
      </section>
    </article>
  )
}
