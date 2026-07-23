import useSeo from '../../hooks/useSeo.js'
import Roster from './sections/Roster.jsx'
import { useKlub } from './context.js'

export default function Czlonkowie() {
  const { club } = useKlub()
  useSeo({ title: `Członkowie — ${club.name} — Leszy.run`, noindex: true })
  return <Roster />
}
