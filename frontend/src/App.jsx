import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout.jsx'
import Events from './pages/Events.jsx'
import EventDetail from './pages/EventDetail.jsx'
import RaceControl from './pages/RaceControl.jsx'
import Results from './pages/Results.jsx'
import PodiumPage from './pages/PodiumPage.jsx'
import ReaderDashboard from './pages/ReaderDashboard.jsx'
import UrlReview from './pages/UrlReview.jsx'
import CalendarEventForm from './pages/CalendarEventForm.jsx'
import CalendarEventsList from './pages/CalendarEventsList.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/events" replace />} />
        <Route element={<Layout />}>
          <Route path="/events" element={<Events />} />
          <Route path="/events/:id" element={<EventDetail />} />
          <Route path="/events/:id/race" element={<RaceControl />} />
          <Route path="/events/:id/results" element={<Results />} />
          <Route path="/reader" element={<ReaderDashboard />} />
          <Route path="/url-review" element={<UrlReview />} />
          <Route path="/calendar-events" element={<CalendarEventsList />} />
          <Route path="/calendar-events/new" element={<CalendarEventForm />} />
        </Route>
        {/* Public views — no nav */}
        <Route path="/events/:id/podium" element={<PodiumPage />} />
        <Route path="/events/:id/results/:categoryId" element={<PodiumPage />} />
      </Routes>
    </BrowserRouter>
  )
}
