import { POLICY_VERSION } from '../lib/policyVersion'

export default function PrivacyPolicy() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-bright">Privacy Policy</h1>
        <p className="mt-2 text-sm text-apex-muted">Version {POLICY_VERSION}</p>
      </header>

      <section id="administrator">
        <h2 className="font-display text-2xl uppercase">1. Data Controller</h2>
        <p className="mt-3">Łukasz Górnicki, operating the Leszy.run service. Contact: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
        <p className="mt-3"><strong>Leszy.run is the sole data controller for all personal data processed within the service — regardless of whether the data was provided directly during account registration or obtained from a race organiser upon import of the start list.</strong> The race organiser remains the controller of data within their own registration system, but once data has been transferred to Leszy.run, the sole controller of that data within our database is Leszy.run. All requests (access, erasure, rectification, objection) should be directed to <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
      </section>

      <section id="zakres" className="mt-8">
        <h2 className="font-display text-2xl uppercase">2. Scope of Data Processed</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>User account:</strong> email address, username, display name, phone number (optional), date of birth, gender, city, voivodeship, club.</li>
          <li><strong>Race participant (imported by organiser):</strong> first name, last name, bib number, category, RFID tag, phone number (optional), email address (optional).</li>
          <li><strong>Timing measurements:</strong> raw gate readings, confirmed crossings, checkpoint observations, final results.</li>
          <li><strong>Check-in:</strong> acknowledgement of the race regulations, timestamps, required documents.</li>
          <li><strong>Analytics:</strong> Google Analytics 4 cookies — only after consent has been given.</li>
        </ul>
      </section>

      <section id="cele" className="mt-8">
        <h2 className="font-display text-2xl uppercase">3. Purposes and Legal Bases for Processing</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>User account:</strong> Art. 6(1)(b) GDPR — performance of a contract for the provision of electronic services.</li>
          <li><strong>Race participation (data from organiser):</strong> Art. 6(1)(f) GDPR — legitimate interest of Leszy.run (provision of race timing services and maintenance of a sports archive). A participant may object at any time — in such a case, their data will be anonymised.</li>
          <li><strong>Timing measurements:</strong> Art. 6(1)(f) GDPR — legitimate interest (integrity and verifiability of results).</li>
          <li><strong>Public results and archive:</strong> Art. 6(1)(f) GDPR — legitimate interest (sports archive, transparency).</li>
          <li><strong>SMS check-in:</strong> Art. 6(1)(b) GDPR — performance of a contract.</li>
          <li><strong>Analytics:</strong> Art. 6(1)(a) GDPR — consent given via the cookie banner.</li>
        </ul>
      </section>

      <section id="retencja" className="mt-8">
        <h2 className="font-display text-2xl uppercase">4. Retention Periods</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>User account data:</strong> indefinitely, until a request for account deletion is made.</li>
          <li><strong>Raw gate readings (gate_events, gate_crossings):</strong> 90 days after the race ends (automatic purge).</li>
          <li><strong>Race results:</strong> indefinitely (archive). Upon account deletion — anonymised in results (labelled as "Anonymous Participant").</li>
          <li><strong>Consent logs (consent_log):</strong> indefinitely (proof of consent).</li>
          <li><strong>GA4 analytics data:</strong> 14 months (Google configuration).</li>
        </ul>
        <p className="mt-3"><strong>After an account is deleted on Leszy.run, the same email address cannot be used to register again.</strong> This is a deliberate policy — account deletion is final and irreversible.</p>
      </section>

      <section id="odbiorcy" className="mt-8">
        <h2 className="font-display text-2xl uppercase">5. Recipients of Data</h2>
        <p className="mt-3">The full list of data processors, including links to their Data Processing Agreements (DPAs), is available at: <a href="/podmioty-przetwarzajace" className="text-apex-yellow underline">/podmioty-przetwarzajace</a>.</p>
        <p className="mt-3">We use the following processors: Supabase, Inc. (database and authentication), Vercel, Inc. (hosting), SMSAPI sp. z o.o. (SMS), Twilio Inc. / SendGrid (transactional email), Google Ireland Ltd. (GA4 analytics), Google Fonts (font CDN).</p>
      </section>

      <section id="prawa" className="mt-8">
        <h2 className="font-display text-2xl uppercase">6. Rights of Data Subjects</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Right of access (Art. 15):</strong> the "Download my data" button in the <a href="/profil" className="text-apex-yellow underline">/profil</a> section.</li>
          <li><strong>Right to rectification (Art. 16):</strong> profile editing in <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Right to erasure (Art. 17):</strong> the "Delete account" button in the <a href="/profil" className="text-apex-yellow underline">/profil</a> section.</li>
          <li><strong>Right to restriction of processing (Art. 18):</strong> contact <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</li>
          <li><strong>Right to data portability (Art. 20):</strong> JSON export available in <a href="/profil" className="text-apex-yellow underline">/profil</a>.</li>
          <li><strong>Right to object (Art. 21):</strong> contact <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</li>
          <li><strong>Withdrawal of consent:</strong> the "Manage cookies" link in the footer, available at any time.</li>
        </ul>
      </section>

      <section id="skarga" className="mt-8">
        <h2 className="font-display text-2xl uppercase">7. Right to Lodge a Complaint with a Supervisory Authority</h2>
        <p className="mt-3">You have the right to lodge a complaint with the President of the Personal Data Protection Office (UODO): <a href="https://uodo.gov.pl/pl/p/skargi" className="text-apex-yellow underline" target="_blank" rel="noopener">https://uodo.gov.pl/pl/p/skargi</a>.</p>
      </section>

      <section id="cookies" className="mt-8">
        <h2 className="font-display text-2xl uppercase">8. Cookies</h2>
        <p className="mt-3">The service uses two categories of cookies:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li><strong>Necessary</strong> (e.g. theme settings, login session) — used without requiring consent, on the basis of Art. 6(1)(f) GDPR (operation of the service).</li>
          <li><strong>Analytics</strong> (Google Analytics 4) — used only after consent has been given via the cookie banner. Consent may be withdrawn at any time via the "Manage cookies" link in the footer.</li>
        </ul>
      </section>

      <section id="scrapers" className="mt-8">
        <h2 className="font-display text-2xl uppercase">9. Race Event Data</h2>
        <p className="mt-3">From publicly available websites of race organisers, we aggregate only information about events (name, date, location, distances, link to registration). <strong>We do not process personal data of organisers or participants from those sources.</strong></p>
      </section>

      <section id="zmiany" className="mt-8">
        <h2 className="font-display text-2xl uppercase">10. Policy Changes</h2>
        <p className="mt-3">Current policy version: <strong>{POLICY_VERSION}</strong>. The change history is available in the public repository: <a href="https://github.com/derberg/BeepBeep/commits/main/public/src/pages/PolitykaPrywatnosci.jsx" className="text-apex-yellow underline" target="_blank" rel="noopener">GitHub</a>.</p>
        <p className="mt-3">In the event of material changes to this policy, users will be asked to re-consent via the cookie banner.</p>
      </section>

      <section id="kontakt" className="mt-8">
        <h2 className="font-display text-2xl uppercase">11. Contact</h2>
        <p className="mt-3">All questions regarding the processing of personal data: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
      </section>
    </article>
  )
}
