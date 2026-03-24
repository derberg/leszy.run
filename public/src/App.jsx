import { Routes, Route, Navigate } from 'react-router-dom'
import Landing from './pages/Landing.jsx'
import Kalendarz from './pages/Kalendarz.jsx'
import DodajWydarzenie from './pages/DodajWydarzenie.jsx'
import Home from './pages/Home.jsx'
import EventHub from './pages/EventHub.jsx'
import Results from './pages/Results.jsx'
import Volunteer from './pages/Volunteer.jsx'
import Checkin from './pages/Checkin.jsx'
import AdminCheckin from './pages/AdminCheckin.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/kalendarz/dodaj" element={<DodajWydarzenie />} />
      <Route path="/kalendarz" element={<Kalendarz />} />
      <Route path="/events" element={<Home />} />
      <Route path="/events/:slug" element={<EventHub />} />
      <Route path="/events/:slug/results" element={<Results />} />
      <Route path="/events/:slug/results/live" element={<Results />} />
      <Route path="/events/:slug/results/:categoryId" element={<Results />} />
      <Route path="/events/:slug/volunteer" element={<Volunteer />} />
      <Route path="/events/:slug/checkin" element={<Checkin />} />
      <Route path="/events/:slug/admin/checkin" element={<AdminCheckin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
