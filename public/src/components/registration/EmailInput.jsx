import { useState } from 'react'
import { emailProblem, suggestEmail } from '@registration/emailAddress.js'
import { inputCls } from './ui.js'

// The e-mail input of every registration form. After the first blur it says what is wrong with
// the address (emailProblem, the server's own rule) and, for a provider typo (gmial.com,
// gmail..com, wp.p), offers the corrected address: one click puts it in the field. The offer
// never blocks submitting, because a domain one letter from gmail.com can be a real one.
// `error` (the server's, or the form's submit check) wins over the blur check while it is set.
export default function EmailInput({
  id, value, onChange, error, note, className = inputCls, errorClassName = 'text-apex-red font-sans text-sm', errorRole, onBlur, readOnly, ...rest
}) {
  const [touched, setTouched] = useState(false)
  const text = value ?? ''
  const checking = touched && !readOnly && text.trim() !== ''
  const shown = error || (checking ? emailProblem(text) : null)
  const suggestion = checking ? suggestEmail(text) : null
  const describedBy = [shown && `${id}-error`, suggestion && `${id}-suggestion`, note].filter(Boolean).join(' ') || undefined
  return (
    <>
      <input id={id} type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={254}
        className={`${className} ${shown ? 'border-apex-red' : ''}`} value={text} readOnly={readOnly}
        aria-invalid={shown ? 'true' : undefined} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => { setTouched(true); onBlur?.(e) }} {...rest} />
      {shown && <p id={`${id}-error`} className={errorClassName} role={error ? errorRole : undefined} data-testid={`${id}-error`}>{shown}</p>}
      <div aria-live="polite">
        {suggestion && (
          <p id={`${id}-suggestion`} className="font-sans text-sm text-apex-text" data-testid={`${id}-suggestion`}>
            Czy chodziło o{' '}
            <button type="button" onClick={() => onChange(suggestion)}
              className="font-bold text-apex-yellow underline underline-offset-2 hover:text-apex-yellow-bright break-all text-left min-h-6">
              {suggestion}
            </button>
            ?
          </p>
        )}
      </div>
    </>
  )
}
