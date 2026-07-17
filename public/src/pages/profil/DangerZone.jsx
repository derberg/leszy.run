import { useState } from 'react'
import { Link } from 'react-router-dom'
import { FUNCTIONS_BASE } from '../../lib/auth.js'
import { deleteClub } from '../../lib/clubs.js'

// Account data + deletion controls. Lives inside the Ustawienia section under the
// "Twoje dane i konto" subsection. GDPR endpoints: export-my-data (Art. 15/20),
// delete-my-account (Art. 17, two-step OTP soft delete).
//
// delete-my-account guards ownership: a club must have a living owner, so it
// 409s (before either the `request` or `confirm` step runs) with
// { error, clubs:[{id,name}] } while the caller still owns a club. That block
// is surfaced here — transfer ownership (link to /profil/klub) or delete the
// club outright — instead of proceeding with account deletion.
export default function DangerZone() {
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('idle') // 'idle' | 'confirm' | 'otp'
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [ownedClubs, setOwnedClubs] = useState(null) // [{id,name}] while the 409 owner-block is active
  const [clubBusyId, setClubBusyId] = useState(null)
  const [clubError, setClubError] = useState(null)

  async function downloadData() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${FUNCTIONS_BASE}/export-my-data`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Eksport nie powiódł się')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'moje-dane.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function requestOtp() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${FUNCTIONS_BASE}/delete-my-account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request' }),
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}))
        if (body.clubs?.length) {
          setOwnedClubs(body.clubs)
          setStep('idle')
          return
        }
      }
      if (!res.ok) throw new Error('Nie udało się wysłać kodu')
      setStep('otp')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleDeleteClub(club) {
    setClubBusyId(club.id)
    setClubError(null)
    try {
      await deleteClub(club.id)
      setOwnedClubs((prev) => {
        const next = (prev || []).filter((c) => c.id !== club.id)
        return next.length ? next : null
      })
    } catch (err) {
      setClubError(err.message)
    } finally {
      setClubBusyId(null)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${FUNCTIONS_BASE}/delete-my-account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', code }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        if (res.status === 409 && body.clubs?.length) {
          setOwnedClubs(body.clubs)
          setStep('idle')
          return
        }
        throw new Error(body.error || 'Niepoprawny kod')
      }
      window.location.href = '/'
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 space-y-3">
      <button
        onClick={downloadData}
        disabled={busy}
        className="border border-apex-border px-4 py-2 text-sm hover:border-apex-yellow hover:text-apex-yellow disabled:opacity-50"
      >
        Pobierz moje dane (JSON)
      </button>

      {ownedClubs?.length > 0 ? (
        <div data-testid="club-owner-block" className="border border-apex-red p-4 space-y-2">
          <h3 className="font-display uppercase text-apex-red text-sm">Jesteś właścicielem klubu</h3>
          <p className="text-sm">
            Przekaż własność albo usuń klub, zanim usuniesz konto — klub musi mieć właściciela.
          </p>
          <ul className="space-y-2">
            {ownedClubs.map((club) => (
              <li key={club.id} className="flex items-center justify-between gap-2 border border-apex-border px-3 py-2">
                <span className="text-sm">«{club.name}»</span>
                <div className="flex items-center gap-2 shrink-0">
                  <Link
                    to="/profil/klub"
                    data-testid={`transfer-club-${club.id}`}
                    className="border border-apex-yellow px-3 py-1 text-xs text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink"
                  >
                    Przekaż własność
                  </Link>
                  <button
                    data-testid={`delete-club-${club.id}`}
                    onClick={() => handleDeleteClub(club)}
                    disabled={clubBusyId === club.id}
                    className="border border-apex-red px-3 py-1 text-xs text-apex-red hover:bg-apex-red hover:text-apex-ink disabled:opacity-50"
                  >
                    {clubBusyId === club.id ? 'Usuwanie…' : 'Usuń klub'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {clubError && <p className="text-sm text-apex-red">{clubError}</p>}
        </div>
      ) : (
        <>
          {step === 'idle' && (
            <button
              onClick={() => setStep('confirm')}
              className="block border border-apex-red px-4 py-2 text-sm text-apex-red hover:bg-apex-red hover:text-apex-ink"
            >
              Usuń konto
            </button>
          )}

          {step === 'confirm' && (
            <div className="border border-apex-red p-4">
              <h3 className="font-display uppercase text-apex-red">Co się stanie po usunięciu konta?</h3>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                <li>Twój profil zostanie usunięty, a wszystkie dane osobowe (imię, telefon, data urodzenia, lokalizacja) wymazane.</li>
                <li>Twoje wyniki w archiwach biegów pozostaną widoczne, ale podpisane jako <strong>Uczestnik anonimowy</strong>.</li>
                <li><strong>Tego adresu email nie da się już ponownie wykorzystać do rejestracji w Leszy.run</strong> — to celowe, by usunięcie było ostateczne.</li>
                <li>Tej operacji nie da się cofnąć. Aby potwierdzić, wyślemy Ci kod OTP na email.</li>
              </ul>
              <div className="mt-4 flex gap-2">
                <button onClick={() => setStep('idle')} className="border border-apex-border px-4 py-1.5 text-sm">Anuluj</button>
                <button onClick={requestOtp} disabled={busy} className="border border-apex-red bg-apex-red px-4 py-1.5 text-sm text-apex-ink hover:bg-apex-red disabled:opacity-50">Wyślij kod OTP</button>
              </div>
            </div>
          )}

          {step === 'otp' && (
            <div className="border border-apex-red p-4">
              <p className="text-sm">Wysłaliśmy kod OTP na Twój email. Wpisz go poniżej, aby potwierdzić usunięcie konta.</p>
              <input
                type="text"
                value={code}
                onChange={e => setCode(e.target.value)}
                maxLength={6}
                className="mt-3 w-32 border border-apex-border bg-apex-bg px-3 py-1.5 font-mono"
                placeholder="000000"
              />
              <div className="mt-4 flex gap-2">
                <button onClick={() => { setStep('idle'); setCode('') }} className="border border-apex-border px-4 py-1.5 text-sm">Anuluj</button>
                <button onClick={confirmDelete} disabled={busy || code.length !== 6} className="border border-apex-red bg-apex-red px-4 py-1.5 text-sm text-apex-ink disabled:opacity-50">Potwierdź usunięcie</button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <p className="text-sm text-apex-red">{error}</p>}
    </div>
  )
}
