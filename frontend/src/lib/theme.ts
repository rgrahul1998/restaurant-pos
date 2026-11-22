import { useSyncExternalStore } from 'react'

/**
 * Light / dark mode, chosen per device (a kitchen screen can stay dark while the till stays light).
 * index.html applies the saved choice before the first paint; keep its KEY and logic in step with this.
 */
export type Theme = 'light' | 'dark' | 'system'

const KEY = 'pos-theme'
const DEFAULT: Theme = 'light'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function read(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : DEFAULT
  } catch {
    return DEFAULT
  }
}

let current = read()

function apply() {
  const dark = current === 'dark' || (current === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

// "System" follows the device live, e.g. when it switches to dark at sunset.
media.addEventListener('change', () => current === 'system' && apply())

export function setTheme(theme: Theme) {
  current = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Private mode or blocked storage: the choice still applies until the page reloads.
  }
  apply()
  listeners.forEach((l) => l())
}

export function useTheme() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

apply()
