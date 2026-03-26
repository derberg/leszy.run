import { Link } from 'react-router-dom'

export default function Footer() {
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
            <ul className="space-y-1.5 list-none p-0 m-0">
              <li><Link to="/" className="text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Strona główna</Link></li>
              <li><Link to="/kalendarz" className="text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Kalendarz biegów</Link></li>
              <li><Link to="/kalendarz/dodaj" className="text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Dodaj wydarzenie</Link></li>
              <li><Link to="/events" className="text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">Wydarzenia Leszy.run</Link></li>
            </ul>
          </nav>

          {/* Contact */}
          <div>
            <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-text-bright mb-3">Kontakt</h2>
            <ul className="space-y-1.5 list-none p-0 m-0">
              <li><a href="mailto:lpgornicki@gmail.com" className="text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">lpgornicki@gmail.com</a></li>
              <li><a href="tel:+48784640977" className="text-xs text-apex-muted no-underline hover:text-apex-yellow transition-colors">+48 784 640 977</a></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-apex-border pt-6 text-center text-xs text-apex-dim">
          <p>
            &copy; {new Date().getFullYear()} Leszy.run &middot; Pomiar czasu i obsługa wydarzeń sportowych
          </p>
        </div>
      </div>
    </footer>
  )
}
