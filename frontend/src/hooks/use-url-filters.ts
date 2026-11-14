import { useSearchParams } from 'react-router-dom'

// Dates are in the browser's local time, which is the restaurant's.
const pad = (n: number) => String(n).padStart(2, '0')
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

export type Range = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom'

function datesFor(range: Range, from: string, to: string): { from?: string; to?: string } {
  const today = new Date()
  switch (range) {
    case 'today':
      return { from: dateKey(today), to: dateKey(today) }
    case 'yesterday':
      return { from: dateKey(addDays(today, -1)), to: dateKey(addDays(today, -1)) }
    case 'week':
      return { from: dateKey(addDays(today, -6)), to: dateKey(today) }
    case 'month':
      return { from: dateKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: dateKey(today) }
    case 'all':
      return {}
    case 'custom':
      return { from: from || undefined, to: to || undefined }
  }
}

/**
 * Page filters kept in the URL (so Back returns to the same view), plus the date range they hold:
 * `range` (default today) and, for picked dates, `from` / `to`.
 */
export function useUrlFilters() {
  const [params, setParams] = useSearchParams()
  const range = (params.get('range') as Range) || 'today'
  const { from, to } = datesFor(range, params.get('from') ?? '', params.get('to') ?? '')

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next
      },
      { replace: true },
    )
  const reset = () => setParams(new URLSearchParams(), { replace: true })

  return { params, range, from, to, update, reset }
}
