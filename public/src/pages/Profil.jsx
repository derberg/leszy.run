import Navbar from '../components/Navbar.jsx'
import AuthGuard from '../components/AuthGuard.jsx'
import useSeo from '../hooks/useSeo.js'

export default function Profil() {
  useSeo({ title: 'Mój profil — Leszy.run', path: '/profil', noindex: true })

  return (
    <AuthGuard>
      <div className="min-h-screen bg-apex-bg text-apex-text">
        <Navbar />
        <main className="pt-24 px-4">
          <div className="max-w-2xl mx-auto">
            <h1 className="font-display font-extrabold text-3xl text-apex-text-bright uppercase tracking-wider mb-6">
              Mój profil
            </h1>
          </div>
        </main>
      </div>
    </AuthGuard>
  )
}
