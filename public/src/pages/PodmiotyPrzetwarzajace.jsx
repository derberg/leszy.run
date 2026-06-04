const PROCESSORS = [
  { name: 'Supabase, Inc.', country: 'USA (EU SCC)', purpose: 'Baza danych, autentykacja, Edge Functions, Storage', dpa: 'https://supabase.com/legal/dpa' },
  { name: 'Vercel, Inc.', country: 'USA (EU SCC)', purpose: 'Hosting frontendu, CDN, serverless funkcje', dpa: 'https://vercel.com/legal/dpa' },
  { name: 'SMSAPI sp. z o.o.', country: 'Polska', purpose: 'Wysyłka wiadomości SMS check-in', dpa: 'https://www.smsapi.pl/dokumenty-prawne' },
  { name: 'Twilio Inc. / SendGrid', country: 'USA (EU SCC)', purpose: 'Wysyłka wiadomości email', dpa: 'https://www.twilio.com/legal/data-protection-addendum' },
  { name: 'Google Ireland Ltd.', country: 'Irlandia / USA (EU SCC)', purpose: 'Analityka GA4 (tylko po wyrażeniu zgody)', dpa: 'https://support.google.com/analytics/answer/9012600' },
  { name: 'Google Fonts (CDN)', country: 'Globalnie', purpose: 'Renderowanie czcionek', dpa: '—' },
]

export default function PodmiotyPrzetwarzajace() {
  return (
    <article className="mx-auto max-w-4xl px-4 py-12 text-apex-text">
      <header className="mb-8">
        <h1 className="font-display text-4xl font-extrabold uppercase text-apex-bright">Podmioty przetwarzające</h1>
        <p className="mt-3">Lista podmiotów, z którymi współpracujemy w zakresie przetwarzania danych osobowych. Każdy z nich działa w oparciu o własną umowę powierzenia (DPA) zgodną z RODO.</p>
      </header>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-apex-border">
            <th className="py-2 text-left font-display uppercase">Podmiot</th>
            <th className="py-2 text-left font-display uppercase">Lokalizacja</th>
            <th className="py-2 text-left font-display uppercase">Cel</th>
            <th className="py-2 text-left font-display uppercase">DPA</th>
          </tr>
        </thead>
        <tbody>
          {PROCESSORS.map(p => (
            <tr key={p.name} className="border-b border-apex-border">
              <td className="py-3 font-semibold">{p.name}</td>
              <td className="py-3">{p.country}</td>
              <td className="py-3">{p.purpose}</td>
              <td className="py-3">{p.dpa.startsWith('http') ? <a href={p.dpa} target="_blank" rel="noopener" className="text-apex-yellow underline">DPA</a> : p.dpa}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-8 text-sm text-apex-muted">Aktualizowane wraz ze zmianami w infrastrukturze. Pytania: <a href="mailto:lukasz@leszy.run" className="text-apex-yellow underline">lukasz@leszy.run</a>.</p>
    </article>
  )
}
