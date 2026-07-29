import { Link } from 'react-router-dom'
import useBeta from '../hooks/useBeta.js'

export default function Footer() {
  const beta = useBeta() // dark-launch: hide add-event link when off
  function openCookieBanner() {
    window.dispatchEvent(new CustomEvent('leszy:cookies:open'))
  }

  return (
    <footer className="border-t border-apex-border py-10 px-6" role="contentinfo">
      <div className="max-w-[1100px] mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mb-8">
          {/* Brand */}
          <div>
            <Link to="/" className="font-display font-extrabold text-lg tracking-wider text-apex-text-bright no-underline">
              LESZY<span className="text-apex-yellow">.RUN</span>
            </Link>
            <p className="text-xs text-apex-muted mt-2 leading-relaxed">
              Profesjonalna obsługa biegów i wydarzeń sportowych. Pomiar czasu RFID, zapisy, wyniki na żywo.
            </p>
          </div>

          {/* Navigation */}
          <nav aria-label="Nawigacja stopki">
            <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-text-bright mb-3">Nawigacja</h2>
            <ul className="list-none p-0 m-0">
              <li><Link to="/" className="inline-block py-1.5 text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Strona główna</Link></li>
              <li><Link to="/kalendarz" className="inline-block py-1.5 text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Kalendarz biegów</Link></li>
              {beta && <li><Link to="/kalendarz/dodaj" className="inline-block py-1.5 text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Dodaj wydarzenie</Link></li>}
              <li><Link to="/events" className="inline-block py-1.5 text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Wydarzenia Leszy.run</Link></li>
            </ul>
          </nav>

          {/* Contact */}
          <div>
            <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-text-bright mb-3">Kontakt</h2>
            <ul className="list-none p-0 m-0">
              <li><a href="mailto:lukasz@leszy.run" className="inline-block py-1.5 text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">lukasz@leszy.run</a></li>
              <li><a href="tel:+48784640977" className="inline-block py-1.5 text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">+48 784 640 977</a></li>
            </ul>
          </div>
        </div>

        {/* text-apex-muted (not dim): 12px text needs 4.5:1 contrast, dim is 3.16:1 on bg.
            py-1.5 on links: WCAG 24px minimum tap target. */}
        <div className="border-t border-apex-border pt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-apex-muted">
          <p>
            &copy; {new Date().getFullYear()} Leszy.run &middot; Pomiar czasu i obsługa wydarzeń sportowych
          </p>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link to="/polityka-prywatnosci" className="inline-block py-1.5 text-apex-muted no-underline hover:text-apex-yellow transition-colors">Polityka prywatności</Link>
            <Link to="/regulamin" className="inline-block py-1.5 text-apex-muted no-underline hover:text-apex-yellow transition-colors">Regulamin</Link>
            <Link to="/podmioty-przetwarzajace" className="inline-block py-1.5 text-apex-muted no-underline hover:text-apex-yellow transition-colors">Podmioty przetwarzające</Link>
            <button type="button" onClick={openCookieBanner} className="inline-block py-1.5 text-left text-apex-muted hover:text-apex-yellow transition-colors">Zarządzaj cookies</button>
          </nav>
        </div>
      </div>
    </footer>
  )
}
