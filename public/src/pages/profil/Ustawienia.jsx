import useSeo from '../../hooks/useSeo.js'
import { useProfil } from './context.js'
import DangerZone from './DangerZone.jsx'
import {
  sectionTitle,
  EditableField,
  EditablePhoneField,
  EditableClubField,
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

  const { profile, handleSave, handleClubSave } = useProfil()

  return (
    <div className="max-w-md space-y-10">
      {/* Dane osobowe */}
      <section>
        <div className={sectionTitle}>Dane osobowe</div>
        <div className="space-y-3">
          <Row label="Imię i nazwisko">
            <EditableField fieldKey="display_name" value={profile?.display_name} onSave={handleSave} />
          </Row>
          <Row label="Klub">
            <EditableClubField value={profile?.club} onSaveClub={handleClubSave} />
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
      </section>

      {/* Twoje dane i konto */}
      <section>
        <div className={sectionTitle}>Twoje dane i konto</div>
        <DangerZone />
      </section>
    </div>
  )
}
