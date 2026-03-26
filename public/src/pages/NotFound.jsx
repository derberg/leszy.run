import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useSeo from '../hooks/useSeo.js'

export default function NotFound() {
  useSeo({
    title: '404 — Strona nie znaleziona',
    description: 'Strona nie została znaleziona. Sprawdź adres lub przejdź do strony głównej Leszy.run.',
  })

  return (
    <>
      <Navbar />
      <main id="main-content" className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <div className="font-mono text-6xl md:text-8xl font-bold text-apex-yellow mb-4">404</div>
          <h1 className="font-display font-extrabold text-2xl md:text-3xl tracking-wider uppercase text-apex-text-bright mb-3">
            Strona nie znaleziona
          </h1>
          <p className="text-apex-text mb-8">
            Szukana strona nie istnieje lub została przeniesiona.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to="/" className="font-display font-bold text-sm tracking-widest uppercase px-6 py-3 bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright transition-all">
              Strona główna
            </Link>
            <Link to="/kalendarz" className="font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-border text-apex-text-bright hover:border-apex-yellow hover:text-apex-yellow transition-all">
              Kalendarz biegów
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  )
}
