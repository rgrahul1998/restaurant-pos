import { useQuery } from '@tanstack/react-query'

import { api } from './api'

/** A brand-new server (no users yet) shows the setup screen instead of sign-in. */
export function useSetupNeeded() {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ needed: boolean }>('/setup/'),
    staleTime: Infinity,
  })
}
