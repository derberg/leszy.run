import useTheme from '../hooks/useTheme.js'

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

export default function ThemeToggle() {
  const { isDark, setTheme } = useTheme()

  const toggle = () => setTheme(isDark ? 'light' : 'dark')

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1.5 text-apex-muted hover:text-apex-text-bright transition-colors p-1.5"
      aria-label={isDark ? 'Przełącz na jasny motyw' : 'Przełącz na ciemny motyw'}
      title={isDark ? 'Jasny motyw' : 'Ciemny motyw'}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

export { useTheme }
