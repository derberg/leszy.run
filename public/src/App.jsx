import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import CookieBanner from './components/CookieBanner.jsx'
import RouteTracker from './components/RouteTracker.jsx'
import Landing from './pages/Landing.jsx'
import NotFound from './pages/NotFound.jsx'

// Lazy-loaded routes — heavy dependencies (Leaflet, QR libs) only load when needed
const Kalendarz = lazy(() => import('./pages/Kalendarz.jsx'))
const EventPage = lazy(() => import('./pages/EventPage.jsx'))
const DodajWydarzenie = lazy(() => import('./pages/DodajWydarzenie.jsx'))
const Home = lazy(() => import('./pages/Home.jsx'))
const EventHub = lazy(() => import('./pages/EventHub.jsx'))
const Results = lazy(() => import('./pages/Results.jsx'))
const Volunteer = lazy(() => import('./pages/Volunteer.jsx'))
const Checkin = lazy(() => import('./pages/Checkin.jsx'))
const AdminCheckin = lazy(() => import('./pages/AdminCheckin.jsx'))

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie...</div>
    </div>
  )
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <RouteTracker />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/kalendarz/dodaj" element={<DodajWydarzenie />} />
          <Route path="/kalendarz/:slug" element={<EventPage />} />
          <Route path="/kalendarz" element={<Kalendarz />} />
          <Route path="/events" element={<Home />} />
          <Route path="/events/:slug" element={<EventHub />} />
          <Route path="/events/:slug/results" element={<Results />} />
          <Route path="/events/:slug/results/live" element={<Results />} />
          <Route path="/events/:slug/results/:categoryId" element={<Results />} />
          <Route path="/events/:slug/volunteer" element={<Volunteer />} />
          <Route path="/events/:slug/checkin" element={<Checkin />} />
          <Route path="/events/:slug/admin/checkin" element={<AdminCheckin />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <CookieBanner />
    </>
  )
}
