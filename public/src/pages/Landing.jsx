import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useTheme from '../hooks/useTheme.js'

function HeroSection() {
  const { isDark } = useTheme()

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center text-center overflow-hidden px-6 pt-20 pb-16 hero-scanlines" aria-label="Główna">
      {/* Radial glow */}
      <div className="absolute w-[400px] h-[400px] md:w-[600px] md:h-[600px] rounded-full top-1/2 left-1/2 -translate-x-1/2 -translate-y-[55%] z-0"
        style={{
          background: isDark
            ? 'radial-gradient(circle, rgba(45,90,39,0.1) 0%, rgba(45,90,39,0.04) 40%, transparent 70%)'
            : 'radial-gradient(circle, rgba(45,90,39,0.08) 0%, rgba(107,128,0,0.03) 40%, transparent 70%)',
          animation: 'hero-pulse 6s ease-in-out infinite',
        }} />

      {/* Logo */}
      <img
        src="/logo-bez-napisu.svg"
        alt="Leszy.run — duch lasu"
        className={`w-[280px] md:w-[500px] h-auto mb-6 relative z-10 ${isDark ? 'hero-logo-dark' : 'hero-logo-light'}`}
      />

      <p className="font-sans font-semibold text-base md:text-lg tracking-widest uppercase text-apex-muted mt-2 relative z-10">
        Pomiar czasu &middot; Zapisy &middot; Wyniki na żywo
      </p>

      <p className="text-base md:text-[17px] text-apex-text mt-5 max-w-[500px] leading-relaxed relative z-10">
        Profesjonalna obsługa biegów i wydarzeń sportowych. Zapisy, pomiar czasu, wyniki online — wszystko w jednym miejscu.
      </p>

      <div className="flex flex-col sm:flex-row gap-4 mt-9 relative z-10 w-full sm:w-auto">
        <Link to="/kalendarz" className="font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 bg-apex-yellow text-apex-ink no-underline hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all text-center">
          Znajdź bieg
        </Link>
        <a href="#kontakt" className="font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 border-2 border-apex-border-bright text-apex-text-bright no-underline hover:border-apex-yellow hover:text-apex-yellow transition-all text-center">
          Organizujesz wydarzenie?
        </a>
      </div>

      <div className="absolute bottom-6 left-1/2 text-apex-dim text-xs tracking-widest uppercase z-10"
        style={{ animation: 'hero-bob 2s ease-in-out infinite' }}>
        &#9660; Przewiń w dół
      </div>
    </section>
  )
}

function FeatureCard({ icon, title, description }) {
  return (
    <div className="bg-apex-surface border border-apex-border p-6 md:p-8 relative group transition-all hover:border-apex-border-mid">
      <div className="absolute top-0 left-0 w-[3px] h-0 bg-apex-yellow transition-all group-hover:h-full" />
      <div className="font-mono text-2xl text-apex-yellow mb-4">{icon}</div>
      <h3 className="font-display font-bold text-xl tracking-wide uppercase text-apex-text-bright mb-2">{title}</h3>
      <p className="text-sm text-apex-muted leading-relaxed">{description}</p>
    </div>
  )
}

function OfertaSection() {
  return (
    <section id="oferta" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto" aria-label="Oferta">
      <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Co oferujemy</p>
      <h2 className="font-display font-extrabold text-3xl md:text-[42px] tracking-wider uppercase text-apex-text-bright mb-4">Wszystko czego potrzebujesz</h2>
      <p className="text-base text-apex-text max-w-[600px] leading-relaxed mb-12">Od rejestracji zawodników po wyniki na mecie. Obsługujemy Twoje wydarzenie od A do Z.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0.5">
        <FeatureCard icon="···" title="Pomiar czasu" description="Precyzyjny pomiar z dokładnością do setnych sekundy. Wyniki widoczne natychmiast po przekroczeniu mety." />
        <FeatureCard icon="▶" title="Wyniki na żywo" description="Uczestnicy i kibice śledzą wyniki w czasie rzeczywistym na telefonie. Podium aktualizuje się automatycznie." />
        <FeatureCard icon="✎" title="Zapisy online (wkrótce)" description="Formularz zapisów, zarządzanie kategoriami, lista startowa. Wszystko gotowe w kilka minut." />
        <FeatureCard icon="★" title="Obsługa od A do Z" description="Nie musisz się martwić o technologie. Przyjedziemy, ustawimy bramki i zajmiemy się resztą." />
      </div>
    </section>
  )
}

function CharitySection() {
  return (
    <section className="bg-apex-surface border-t-[3px] border-t-apex-yellow border-b border-b-apex-border py-16 md:py-20 px-6 text-center" aria-label="Wydarzenia charytatywne">
      <div className="max-w-[700px] mx-auto">
        <h2 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-yellow mb-4">
          Wydarzenia charytatywne? Za darmo.
        </h2>
        <p className="text-[17px] text-apex-text leading-relaxed mb-8">
          Organizujesz bieg charytatywny? Zapisy, obsługa i pomiar czasu — wszystko za darmo. Jedyne co musisz zrobić to skontaktować się z nami i ustalić termin.
        </p>
        <a href="#kontakt" className="inline-block font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 bg-apex-yellow text-apex-ink no-underline hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all">
          Skontaktuj się
        </a>
      </div>
    </section>
  )
}

function Countdown({ targetDate }) {
  const [diff, setDiff] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 })

  useEffect(() => {
    const update = () => {
      const now = new Date()
      const target = new Date(targetDate + 'T08:00:00')
      const ms = target - now
      if (ms <= 0) { setDiff({ days: 0, hours: 0, minutes: 0, seconds: 0 }); return }
      setDiff({
        days: Math.floor(ms / 86400000),
        hours: Math.floor((ms % 86400000) / 3600000),
        minutes: Math.floor((ms % 3600000) / 60000),
        seconds: Math.floor((ms % 60000) / 1000),
      })
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [targetDate])

  const unit = (val, label) => (
    <div className="flex flex-col items-center">
      <span className="font-mono text-2xl md:text-4xl font-bold text-apex-yellow">{String(val).padStart(2, '0')}</span>
      <span className="font-mono text-[9px] tracking-widest uppercase text-apex-muted mt-1">{label}</span>
    </div>
  )

  return (
    <div className="flex gap-4 md:gap-6">
      {unit(diff.days, 'dni')}
      <span className="font-mono text-2xl md:text-4xl text-apex-dim self-start">:</span>
      {unit(diff.hours, 'godz')}
      <span className="font-mono text-2xl md:text-4xl text-apex-dim self-start">:</span>
      {unit(diff.minutes, 'min')}
      <span className="font-mono text-2xl md:text-4xl text-apex-dim self-start">:</span>
      {unit(diff.seconds, 'sek')}
    </div>
  )
}

function EventsSection() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    supabase
      .from('events')
      .select('id, name, date, location, slug, event_url')
      .gte('date', today)
      .order('date', { ascending: true })
      .limit(5)
      .then(({ data, error }) => {
        if (error) console.error('Events fetch error:', error.message)
        setEvents(data || [])
        setLoading(false)
      })
  }, [])

  const nextEvent = events[0]

  return (
    <section id="wydarzenia" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto" aria-label="Nadchodzące wydarzenia">
      <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Nadchodzące wydarzenia</p>
      <h2 className="font-display font-extrabold text-3xl md:text-[42px] tracking-wider uppercase text-apex-text-bright mb-4">Najbliższe biegi</h2>
      <p className="text-base text-apex-text max-w-[600px] leading-relaxed mb-12">Wydarzenia obsługiwane przez Leszy.run. Kliknij aby zobaczyć wyniki na żywo.</p>

      {loading && <div className="text-apex-muted">Ładowanie...</div>}

      {nextEvent && (
        <Link to={`/events/${nextEvent.slug}/results/live`} className="block bg-apex-surface border-2 border-apex-yellow/30 p-6 md:p-10 mb-4 hover:border-apex-yellow/60 transition-all no-underline text-inherit group">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <div className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">
                {new Date(nextEvent.date).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
              <div className="font-display font-extrabold text-2xl md:text-3xl tracking-wider uppercase text-apex-text-bright group-hover:text-apex-yellow transition-colors">
                {nextEvent.name}
              </div>
              {nextEvent.location && <div className="text-sm text-apex-muted mt-1">{nextEvent.location}</div>}
              <div className="flex gap-4 mt-3">
                <span className="font-mono text-[10px] tracking-widest uppercase text-apex-cyan">Wyniki na żywo &rarr;</span>
                {nextEvent.event_url && (
                  <a href={nextEvent.event_url} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
                    className="font-mono text-[10px] tracking-widest uppercase text-apex-yellow hover:text-apex-yellow-bright">
                    Strona wydarzenia &rarr;
                  </a>
                )}
              </div>
            </div>
            <Countdown targetDate={nextEvent.date} />
          </div>
        </Link>
      )}

      {events.slice(1).map(ev => (
        <Link key={ev.id} to={`/events/${ev.slug}/results/live`} className="grid grid-cols-[80px_1fr] md:grid-cols-[100px_1fr_auto] items-center gap-4 md:gap-6 bg-apex-surface border border-apex-border px-4 md:px-6 py-4 md:py-5 mb-0.5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all no-underline text-inherit">
          <div className="font-mono text-[13px] font-semibold text-apex-yellow">{ev.date}</div>
          <div>
            <div className="font-display font-bold text-base md:text-lg tracking-wide uppercase text-apex-text-bright">{ev.name}</div>
            {ev.location && <div className="text-xs text-apex-muted mt-0.5">{ev.location}</div>}
          </div>
          <div className="hidden md:block text-apex-dim text-lg">&rarr;</div>
        </Link>
      ))}

      {!loading && events.length === 0 && (
        <p className="text-apex-muted">Brak nadchodzących wydarzeń.</p>
      )}
    </section>
  )
}

function KalendarzTeaser() {
  const [events, setEvents] = useState([])

  useEffect(() => {
    supabase
      .from('calendar_events')
      .select('id, name, date, location, leszyrun_event_id')
      .gte('date', new Date().toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(5)
      .then(({ data, error }) => {
        if (error) console.error('Calendar events fetch error:', error.message)
        setEvents(data || [])
      })
  }, [])

  return (
    <section id="kalendarz" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto" aria-label="Kalendarz biegów">
      <div className="bg-apex-surface border border-apex-border p-8 md:p-12 grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center">
        <div>
          <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Kalendarz biegów</p>
          <h3 className="font-display font-extrabold text-2xl md:text-4xl tracking-wider uppercase text-apex-text-bright mb-3">
            Wszystkie wydarzenia sportowe w Polsce w jednym miejscu
          </h3>
          <p className="text-[15px] text-apex-text leading-relaxed mb-6">
            Przeglądaj setki biegów, marszów nordic walking i wydarzeń sportowych z całej Polski. Filtruj po regionie, dystansie i typie.
          </p>
          <Link to="/kalendarz" className="inline-block font-display font-bold text-[15px] tracking-widest uppercase py-3.5 px-9 bg-apex-yellow text-apex-ink no-underline hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all">
            Otwórz kalendarz
          </Link>
        </div>

        <div className="flex flex-col gap-1.5">
          {events.map(ev => (
            <div key={ev.id} className="flex items-center gap-3 px-3.5 py-2.5 bg-apex-surface-2 border border-apex-border text-[13px]">
              <span className="font-mono text-[11px] text-apex-yellow-dim min-w-[50px]">
                {new Date(ev.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })}
              </span>
              <span className="font-semibold text-apex-text-bright truncate">{ev.name}</span>
              {ev.leszyrun_event_id && (
                <span className="font-mono text-[9px] font-semibold tracking-wide px-1.5 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20 ml-auto flex-shrink-0">
                  LESZY.RUN
                </span>
              )}
              {!ev.leszyrun_event_id && <span className="text-apex-muted text-xs ml-auto flex-shrink-0">{ev.location}</span>}
            </div>
          ))}
          {events.length === 0 && (
            <div className="text-apex-muted text-sm py-4 text-center">Kalendarz wkrótce...</div>
          )}
        </div>
      </div>
    </section>
  )
}

function ContactSection() {
  return (
    <section id="kontakt" className="py-16 md:py-24 px-6 max-w-[1100px] mx-auto text-center" aria-label="Kontakt">
      <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Kontakt</p>
      <h2 className="font-display font-extrabold text-3xl md:text-[42px] tracking-wider uppercase text-apex-text-bright mb-4">Kontakt</h2>
      <div className="flex flex-col sm:flex-row gap-6 justify-center">
        <a href="mailto:lpgornicki@gmail.com" className="flex flex-col items-center gap-2 px-8 py-6 bg-apex-surface border border-apex-border min-w-[180px] hover:border-apex-yellow-dim transition-colors">
          <span className="font-mono text-[10px] tracking-widest uppercase text-apex-muted">Email</span>
          <span className="font-display font-bold text-lg text-apex-text-bright tracking-wide">lpgornicki@gmail.com</span>
        </a>
        <a href="tel:+48784640977" className="flex flex-col items-center gap-2 px-8 py-6 bg-apex-surface border border-apex-border min-w-[180px] hover:border-apex-yellow-dim transition-colors">
          <span className="font-mono text-[10px] tracking-widest uppercase text-apex-muted">Telefon</span>
          <span className="font-display font-bold text-lg text-apex-text-bright tracking-wide">+48 784 640 977</span>
        </a>
      </div>
    </section>
  )
}

export default function Landing() {
  return (
    <>
      <Navbar />
      <main id="main-content">
        <HeroSection />
        <div className="w-full h-px bg-apex-border" />
        <OfertaSection />
        <div className="w-full h-px bg-apex-border" />
        <CharitySection />
        <div className="w-full h-px bg-apex-border" />
        <EventsSection />
        <div className="w-full h-px bg-apex-border" />
        <KalendarzTeaser />
        <div className="w-full h-px bg-apex-border" />
        <ContactSection />
      </main>
      <Footer />
    </>
  )
}
