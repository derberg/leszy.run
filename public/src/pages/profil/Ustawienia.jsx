import { useState } from 'react'
import { Link } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { useProfil } from './context.js'
import useClub from '../../hooks/useClub.js'
import { manageMember } from '../../lib/clubs.js'
import DangerZone from './DangerZone.jsx'
import {
  sectionTitle,
  EditableField,
  EditablePhoneField,
  VOIVODESHIP_OPTIONS,
  GENDER_LABELS,
} from './fields.jsx'

function Row({ label, children }) {
  return (
    <div>
      <div className="text-[9px] font-mono text-apex-muted mb-0.5">{label}</div>
      {children}
    </div>
  )
}

export default function Ustawienia() {
  useSeo({ title: 'Ustawienia — Leszy.run', path: '/profil/ustawienia', noindex: true })

  const { profile, handleSave } = useProfil()
  const { club, me, reload: reloadClub } = useClub()
  const [visBusy, setVisBusy] = useState(false)
  const [visError, setVisError] = useState(null)

  async function toggleHiddenPublic(checked) {
    if (!club) return
    setVisBusy(true)
    setVisError(null)
    try {
      await manageMember(club.id, 'set-visibility', { hidden_public: checked })
      await reloadClub()
    } catch (err) {
      setVisError(err.message)
    } finally {
      setVisBusy(false)
    }
  }

  return (
    <div className="max-w-md space-y-10">
      {/* Dane osobowe */}
      <section>
        <div className={sectionTitle}>Dane osobowe</div>
        <div className="space-y-3">
          <Row label="Imię i nazwisko">
            <EditableField fieldKey="display_name" value={profile?.display_name} onSave={handleSave} />
          </Row>
          <Row label="Pseudonim (na publicznej stronie klubu)">
            <EditableField fieldKey="nickname" value={profile?.nickname} onSave={handleSave} />
          </Row>
          <Row label="Klub">
            <div className="flex items-center gap-2">
              <span className="font-sans text-sm text-apex-text">
                {profile?.club || <span className="text-apex-muted italic">brak klubu</span>}
              </span>
              <Link
                to="/profil/klub"
                data-testid="link-manage-club"
                className="font-mono text-[10px] text-apex-yellow hover:underline"
              >
                Zarządzaj klubem
              </Link>
            </div>
          </Row>
          <Row label="Płeć">
            <EditableField
              fieldKey="gender"
              value={profile?.gender}
              displayValue={GENDER_LABELS[profile?.gender]}
              onSave={handleSave}
              options={[
                { value: 'M', label: 'Mężczyzna' },
                { value: 'F', label: 'Kobieta' },
                { value: 'X', label: 'Inna' },
              ]}
            />
          </Row>
          <Row label="Data urodzenia">
            <EditableField fieldKey="date_of_birth" value={profile?.date_of_birth} onSave={handleSave} type="date" />
          </Row>
          <Row label="Telefon">
            <EditablePhoneField value={profile?.phone} onSave={handleSave} />
          </Row>
          <Row label="Miejscowość">
            <EditableField fieldKey="city" value={profile?.city} onSave={handleSave} />
          </Row>
          <Row label="Województwo">
            <EditableField
              fieldKey="voivodeship"
              value={profile?.voivodeship}
              onSave={handleSave}
              options={VOIVODESHIP_OPTIONS}
            />
          </Row>
        </div>
      </section>

      {/* Powiadomienia i prywatność */}
      <section>
        <div className={sectionTitle}>Powiadomienia i prywatność</div>
        <label className="flex items-start gap-2 cursor-pointer mb-3">
          <input
            data-testid="toggle-weekly-digest"
            type="checkbox"
            checked={!!profile?.weekly_digest}
            onChange={(e) => handleSave('weekly_digest', e.target.checked)}
            className="mt-0.5 accent-[#BBDD00]"
          />
          <span className="font-sans text-xs text-apex-text">
            Cotygodniowe podsumowanie e-mailem
            <span className="block text-[10px] text-apex-muted">Zmiany w obserwowanych biegach, raz w tygodniu.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            data-testid="toggle-club-visibility"
            type="checkbox"
            checked={(profile?.privacy_settings?.favorites ?? true) !== false}
            onChange={(e) => handleSave('privacy_settings', { ...profile?.privacy_settings, favorites: e.target.checked })}
            className="mt-0.5 accent-[#BBDD00]"
          />
          <span className="font-sans text-xs text-apex-text">
            Pokazuj klubowiczom co obserwuję
            <span className="block text-[10px] text-apex-muted">Członkowie Twojego klubu widzą, które biegi obserwujesz.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer mt-3">
          <input
            data-testid="toggle-club-nickname"
            type="checkbox"
            checked={profile?.privacy_settings?.club_public_name === 'nickname'}
            onChange={(e) => handleSave('privacy_settings', { ...profile?.privacy_settings, club_public_name: e.target.checked ? 'nickname' : 'display' })}
            className="mt-0.5 accent-[#BBDD00]"
          />
          <span className="font-sans text-xs text-apex-text">
            Na publicznej stronie klubu pokazuj tylko pseudonim
            <span className="block text-[10px] text-apex-muted">Zamiast Twojego imienia i nazwiska.</span>
          </span>
        </label>
        {club && (
          <label className="flex items-start gap-2 cursor-pointer mt-3">
            <input
              data-testid="toggle-hidden-public"
              type="checkbox"
              checked={!!me?.hidden_public}
              disabled={visBusy}
              onChange={(e) => toggleHiddenPublic(e.target.checked)}
              className="mt-0.5 accent-[#BBDD00]"
            />
            <span className="font-sans text-xs text-apex-text">
              Nie pokazuj mnie na publicznej stronie klubu
              <span className="block text-[10px] text-apex-muted">Twój wpis zniknie z listy członków na publicznej stronie klubu.</span>
            </span>
          </label>
        )}
        {visError && <p className="text-apex-red font-sans text-xs mt-2">{visError}</p>}
      </section>

      {/* Twoje dane i konto */}
      <section>
        <div className={sectionTitle}>Twoje dane i konto</div>
        <DangerZone />
      </section>
    </div>
  )
}
