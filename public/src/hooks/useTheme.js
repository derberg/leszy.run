import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'leszy-theme'

/**
 * Theme hook. Returns { theme, setTheme, isDark }.
 * - theme: 'system' | 'dark' | 'light'
 * - isDark: resolved boolean (accounts for system preference when theme === 'system')
 * - setTheme: updates preference and applies class to <html>
 */
export default function useTheme() {
  const [theme, setThemeState] = useState(() => {
    if (typeof window === 'undefined') return 'system'
    return localStorage.getItem(STORAGE_KEY) || 'system'
  })

  const applyTheme = useCallback((value) => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    if (value === 'light') root.classList.add('light')
    else if (value === 'dark') root.classList.add('dark')
    // 'system' — no class, CSS media queries handle it
  }, [])

  const setTheme = useCallback((value) => {
    setThemeState(value)
    if (value === 'system') {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, value)
    }
    applyTheme(value)
  }, [applyTheme])

  // Resolve whether the current effective theme is dark
  const getIsDark = useCallback(() => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }, [theme])

  const [isDark, setIsDark] = useState(getIsDark)

  // Apply on mount
  useEffect(() => {
    applyTheme(theme)
  }, [theme, applyTheme])

  // Listen for system preference changes (matters when theme === 'system')
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setIsDark(getIsDark())
    mq.addEventListener('change', handler)
    setIsDark(getIsDark())
    return () => mq.removeEventListener('change', handler)
  }, [getIsDark])

  return { theme, setTheme, isDark }
}
