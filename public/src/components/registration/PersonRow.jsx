import { editBtn, moveBtn, removeBtn, smallBtn } from './ui.js'

// The list step of the group form (RA3) and of the team form (RB2), and RB4's order step.

/** ↑/↓ beside a person. `moveKey` names them for useMoveFocus; `onMove` gets -1 or 1. */
export function MoveButtons({ moveKey, name, place, count, disabled, onMove }) {
  return (
    <span className="flex flex-col gap-1 shrink-0">
      <button type="button" className={moveBtn} disabled={disabled || place === 1} aria-label={`Wyżej — ${name}`}
        data-move={`${moveKey}:-1`} onClick={() => onMove(-1)}>↑</button>
      <button type="button" className={moveBtn} disabled={disabled || place === count} aria-label={`Niżej — ${name}`}
        data-move={`${moveKey}:1`} onClick={() => onMove(1)}>↓</button>
    </span>
  )
}

/** „Usunąć <imię>?” Tak / Nie, in place of the buttons, for a card that holds anything. */
export function RemoveConfirm({ id, question = 'Usunąć tę osobę?', onYes, onNo }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" role="group" aria-labelledby={id} data-testid="remove-confirm">
      <span id={id} className="font-sans font-semibold text-base text-apex-text-bright">{question}</span>
      <span className="flex gap-2">
        <button type="button" onClick={onYes} className={removeBtn} data-testid="remove-yes">Tak</button>
        <button type="button" onClick={onNo} className={`${smallBtn} border-apex-border-bright text-apex-text-bright hover:bg-apex-surface-2`} autoFocus data-testid="remove-no">Nie</button>
      </span>
    </div>
  )
}

/** One person on the list step: name, competition and group, „Zmień”, and „Usuń” for an added person. `lead` sits before the name. */
export function PersonRow({ cardKey, n, label, person, detail, onEdit, onRemove, confirming, onConfirm, onCancel, disabled, lead }) {
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ') || `osoba ${n}`
  return (
    <li className="border border-apex-border-mid bg-apex-surface px-3.5 py-2.5 flex flex-col gap-2" data-testid="person-row" data-card-key={cardKey}>
      <div className="flex justify-between items-center gap-3">
        {lead}
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-apex-muted uppercase">{label}</span>
          <span className="block text-[17px] text-apex-text-bright [overflow-wrap:anywhere]">{name}</span>
          <span className="block font-mono text-[13px] text-apex-muted uppercase [overflow-wrap:anywhere]">{detail}</span>
        </span>
        {!confirming && (
          <span className="flex gap-2 shrink-0">
            <button type="button" onClick={onEdit} disabled={disabled} className={editBtn} aria-label={`Zmień — ${name}`}>Zmień</button>
            {onRemove && <button type="button" id={`p${n}-remove`} onClick={onRemove} disabled={disabled} className={removeBtn} aria-label={`Usuń — ${name}`}>Usuń</button>}
          </span>
        )}
      </div>
      {confirming && <RemoveConfirm id={`p${n}-remove-q`} onYes={onConfirm} onNo={onCancel} />}
    </li>
  )
}
