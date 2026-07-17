import { useState, useRef } from 'react'
import { uploadClubLogo } from '../lib/clubs.js'

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 5 * 1024 * 1024 // 5MB — mirrors the server-side upload-club-logo limit

// File → dataURL → upload-club-logo, with a client-side type/size guard that
// fails fast (mirrors the server's own rule) plus a preview box.
// <ClubLogoUpload clubId currentUrl onUploaded={(logo_url) => {}} />
export default function ClubLogoUpload({ clubId, currentUrl, onUploaded }) {
  const [preview, setPreview] = useState(currentUrl || null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error || new Error('Nie udało się odczytać pliku.'))
      reader.readAsDataURL(file)
    })
  }

  async function handleChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Dozwolone formaty: PNG, JPG, WebP.')
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    if (file.size > MAX_BYTES) {
      setError('Plik jest za duży — maksymalnie 5MB.')
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    setBusy(true)
    try {
      const dataUrl = await readAsDataUrl(file)
      const { logo_url } = await uploadClubLogo(clubId, dataUrl)
      setPreview(logo_url)
      onUploaded?.(logo_url)
    } catch (err) {
      setError(err.message || 'Nie udało się przesłać logo.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div
        data-testid="logo-preview"
        className="w-16 h-16 border border-apex-border bg-apex-surface shrink-0 flex items-center justify-center overflow-hidden"
      >
        {preview ? (
          <img src={preview} alt="Logo klubu" className="w-full h-full object-cover" />
        ) : (
          <span className="font-mono text-[9px] text-apex-muted">brak logo</span>
        )}
      </div>
      <div>
        <label
          className={`inline-block font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border transition-all cursor-pointer ${
            busy
              ? 'border-apex-border text-apex-muted opacity-40 cursor-not-allowed'
              : 'border-apex-border text-apex-muted hover:text-apex-yellow hover:border-apex-yellow/40'
          }`}
        >
          {busy ? 'Przesyłanie…' : preview ? 'Zmień logo' : 'Dodaj logo'}
          <input
            data-testid="logo-input"
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleChange}
            disabled={busy}
            className="hidden"
          />
        </label>
        {error && <p data-testid="logo-error" className="text-apex-red font-sans text-xs mt-1">{error}</p>}
      </div>
    </div>
  )
}
