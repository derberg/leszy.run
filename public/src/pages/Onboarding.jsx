import Navbar from '../components/Navbar.jsx'
import AuthGuard from '../components/AuthGuard.jsx'
import useSeo from '../hooks/useSeo.js'

export default function Onboarding() {
  useSeo({ title: 'Witaj w Leszy.run', path: '/onboarding', noindex: true })

  return (
    <AuthGuard>
      <div className="min-h-screen bg-apex-bg text-apex-text">
        <Navbar />
        <main className="flex items-center justify-center min-h-screen pt-14 px-4">
          <div className="w-full max-w-md">
            <h1 className="font-display font-extrabold text-3xl text-apex-text-bright uppercase tracking-wider mb-2">
              Witaj!
            </h1>
            <p className="font-sans text-apex-muted text-sm">
              Uzupełnij swój profil, aby korzystać z pełnych możliwości Leszy.run.
            </p>
          </div>
        </main>
      </div>
    </AuthGuard>
  )
}
