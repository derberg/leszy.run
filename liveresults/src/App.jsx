import { Routes, Route, Navigate } from 'react-router-dom'
import EventsPage from './pages/Events.jsx'
import EventPage from './pages/Event.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<EventsPage />} />
      <Route path="/events/:eventId" element={<EventPage />} />
      <Route path="/events/:eventId/:categoryId" element={<EventPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
