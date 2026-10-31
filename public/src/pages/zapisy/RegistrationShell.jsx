import Navbar from '../../components/Navbar.jsx'
import NotFound from '../NotFound.jsx'
import usePublicRegistrationEvent from '../../hooks/usePublicRegistrationEvent.js'

// RA1b, RA2 and RA5 read the same /api/event snapshot as RA1. An unknown or
// unpublished slug is the 404 page; nothing about a draft ever renders.
// `wide`: RA8d's desktop table needs more than the form pages' column.
export default function RegistrationShell({ slug, wide = false, children }) {
  const { status, raw } = usePublicRegistrationEvent(slug)
  if (status === 'missing') return <NotFound />
  return (
    <>
      <Navbar />
      <main id="main-content" className="bg-apex-bg text-apex-text font-sans min-h-[70vh]">
        <div className={`${wide ? 'max-w-[1100px]' : 'max-w-2xl'} mx-auto px-4 sm:px-5 pt-[70px] pb-12 flex flex-col gap-4`}>
          {status === 'loading'
            ? <div className="flex flex-col gap-4" aria-busy="true">
                <div className="h-11 bg-apex-surface" />
                <div className="h-10 w-2/3 bg-apex-surface" />
                <div className="h-64 bg-apex-surface" />
              </div>
            : children(raw)}
        </div>
      </main>
    </>
  )
}
