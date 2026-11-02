import { useState, useRef } from 'react'
import { uploadClubLogo } from '../lib/clubs.js'
import { logoResize, LOGO_TYPES, LOGO_TYPE_ERROR } from '../lib/logoResize.js'

// File → logoResize (redrawn in the browser as PNG, or JPEG past 2 MB) →
// upload-club-logo, plus a preview box. The server decodes PNG and JPEG only:
// its image library has no WebP decoder, so a WebP is converted here, the same
// way partner logos are.
// <ClubLogoUpload clubId currentUrl onUploaded={(logo_url) => {}} />
export default function ClubLogoUpload({ clubId, currentUrl, onUploaded }) {
  const [preview, setPreview] = useState(currentUrl || null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  async function handleChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)

    if (!LOGO_TYPES.includes(file.type)) {
      setError(LOGO_TYPE_ERROR)
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    setBusy(true)
    try {
      const dataUrl = await logoResize(file)
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
