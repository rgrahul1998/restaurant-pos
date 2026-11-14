import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { User } from './types'

interface AuthState {
  access: string | null
  refresh: string | null
  user: User | null
  setTokens: (access: string, refresh?: string) => void
  setUser: (user: User) => void
  logout: () => void
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      access: null,
      refresh: null,
      user: null,
      setTokens: (access, refresh) => set((s) => ({ access, refresh: refresh ?? s.refresh })),
      setUser: (user) => set({ user }),
      logout: () => set({ access: null, refresh: null, user: null }),
    }),
    { name: 'pos-auth' },
  ),
)
