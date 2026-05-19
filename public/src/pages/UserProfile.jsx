import { useParams } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import useSeo from '../hooks/useSeo.js'

export default function UserProfile() {
  const { username } = useParams()
  useSeo({ title: `${username} — Leszy.run`, path: `/u/${username}` })

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main className="pt-24 px-4">
        <div className="max-w-2xl mx-auto">
          <h1 className="font-display font-extrabold text-3xl text-apex-text-bright uppercase tracking-wider mb-6">
            {username}
          </h1>
        </div>
      </main>
    </div>
  )
}
