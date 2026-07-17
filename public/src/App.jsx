import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import useBeta from './hooks/useBeta.js'
import CookieBanner from './components/CookieBanner.jsx'
import Footer from './components/Footer.jsx'
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
const BieguHub = lazy(() => import('./pages/BieguHub.jsx'))
const LandingPage = lazy(() => import('./pages/LandingPage.jsx'))
const Login = lazy(() => import('./pages/Login.jsx'))
const Onboarding = lazy(() => import('./pages/Onboarding.jsx'))
const Profil = lazy(() => import('./pages/Profil.jsx'))
const Obserwowane = lazy(() => import('./pages/profil/Obserwowane.jsx'))
const Zgloszenia = lazy(() => import('./pages/profil/Zgloszenia.jsx'))
const Klub = lazy(() => import('./pages/profil/Klub.jsx'))
const Ustawienia = lazy(() => import('./pages/profil/Ustawienia.jsx'))
const UserProfile = lazy(() => import('./pages/UserProfile.jsx'))
const InviteAccept = lazy(() => import('./pages/InviteAccept.jsx'))
const PolitykaPrywatnosci = lazy(() => import('./pages/PolitykaPrywatnosci.jsx'))
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy.jsx'))
const Regulamin = lazy(() => import('./pages/Regulamin.jsx'))
const PodmiotyPrzetwarzajace = lazy(() => import('./pages/PodmiotyPrzetwarzajace.jsx'))

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
  // Accounts/community product is dark-launched behind ?beta=1 — its routes
  // redirect home until the flag is on. Legal pages stay live (compliance).
  const beta = useBeta()
  return (
    <>
      <ScrollToTop />
      <RouteTracker />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/kalendarz/dodaj" element={beta ? <DodajWydarzenie /> : <Navigate to="/kalendarz" replace />} />
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
          <Route path="/listy" element={<BieguHub />} />
          <Route path="/listy/*" element={<LandingPage />} />
          <Route path="/login" element={beta ? <Login /> : <Navigate to="/" replace />} />
          <Route path="/onboarding" element={beta ? <Onboarding /> : <Navigate to="/" replace />} />
          <Route path="/profil" element={beta ? <Profil /> : <Navigate to="/" replace />}>
            <Route index element={<Navigate to="obserwowane" replace />} />
            <Route path="obserwowane" element={<Obserwowane />} />
            <Route path="zgloszenia" element={<Zgloszenia />} />
            <Route path="klub" element={<Klub />} />
            <Route path="ustawienia" element={<Ustawienia />} />
          </Route>
          <Route path="/u/:username" element={beta ? <UserProfile /> : <Navigate to="/" replace />} />
          {/* The bare /klub/:slug is an SSR rewrite (render-club) — the SPA does not own it.
              /klub/:slug/dolacz is more specific and IS an SPA route (invite-accept). */}
          <Route path="/klub/:slug/dolacz" element={beta ? <InviteAccept /> : <Navigate to="/" replace />} />
          <Route path="/polityka-prywatnosci" element={<PolitykaPrywatnosci />} />
          <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/regulamin" element={<Regulamin />} />
          <Route path="/podmioty-przetwarzajace" element={<PodmiotyPrzetwarzajace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <Footer />
      <CookieBanner />
    </>
  )
}
