import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home.jsx'
import EventHub from './pages/EventHub.jsx'
import Results from './pages/Results.jsx'
import Volunteer from './pages/Volunteer.jsx'
import Checkin from './pages/Checkin.jsx'
import AdminCheckin from './pages/AdminCheckin.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/:slug" element={<EventHub />} />
      <Route path="/:slug/results" element={<Results />} />
      <Route path="/:slug/results/live" element={<Results />} />
      <Route path="/:slug/results/:categoryId" element={<Results />} />
      <Route path="/:slug/volunteer" element={<Volunteer />} />
      <Route path="/:slug/checkin" element={<Checkin />} />
      <Route path="/:slug/admin/checkin" element={<AdminCheckin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
