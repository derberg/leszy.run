export default function Footer() {
  return (
    <footer className="border-t border-apex-border py-8 px-6 text-center text-xs text-apex-dim max-w-[1100px] mx-auto">
      <p>
        &copy; {new Date().getFullYear()} Leszy.run &middot; Pomiar czasu i obsluga wydarzen sportowych &middot;{' '}
        <a href="/polityka-prywatnosci" className="text-apex-muted no-underline hover:text-apex-yellow">
          Polityka prywatnosci
        </a>
      </p>
    </footer>
  )
}
