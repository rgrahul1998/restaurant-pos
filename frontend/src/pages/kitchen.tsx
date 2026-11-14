import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { JainTag } from '@/components/jain-tag'
import { PageState } from '@/components/page-state'
import { Button } from '@/components/ui/button'
import { useSocket } from '@/hooks/use-socket'
import { apiAll, patch, post } from '@/lib/api'
import { time } from '@/lib/format'
import type { KOT, Station } from '@/lib/types'
import { cn } from '@/lib/utils'

const NEXT: Partial<Record<KOT['status'], { status: KOT['status']; label: string }>> = {
  pending: { status: 'preparing', label: 'Start' },
  preparing: { status: 'ready', label: 'Ready' },
  ready: { status: 'served', label: 'Served' },
}

const LABEL: Partial<Record<KOT['type'], string>> = {
  modified: 'Add-on',
  cancelled: 'Cancelled',
  partially_cancelled: 'Cancel items',
  duplicate: 'Duplicate',
}

export function KitchenPage() {
  const queryClient = useQueryClient()
  // Each station's screen stays on its own tickets; managers can watch them all.
  const [station, setStation] = useState<number | null>(null)
  const stations = useQuery({
    queryKey: ['stations'],
    queryFn: () => apiAll<Station>('/stations/?is_active=true'),
    staleTime: 60_000,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['kots'] })

  const kots = useQuery({
    queryKey: ['kots'],
    queryFn: async () => {
      const lists = await Promise.all(
        ['pending', 'preparing', 'ready'].map((s) => apiAll<KOT>(`/kots/?status=${s}`)),
      )
      return lists.flat().sort((a, b) => a.created_at.localeCompare(b.created_at))
    },
  })
  const advance = useMutation({
    mutationFn: ({ id, status }: { id: number; status: KOT['status'] }) =>
      patch<KOT>(`/kots/${id}/`, { status }),
    onSuccess: refresh,
  })
  const reprint = useMutation({ mutationFn: (id: number) => post(`/kots/${id}/reprint/`) })
  useSocket('/ws/kitchen/', refresh)

  if (kots.isPending) return <PageState>Loading…</PageState>
  if (kots.isError) return <PageState error>Could not load tickets.</PageState>

  const shown = kots.data.filter((k) => station === null || k.station === station)

  return (
    <div className="grid gap-5">
      <div className="flex gap-2 overflow-x-auto">
        {[{ id: null, name: 'All stations' }, ...(stations.data ?? [])].map((s) => (
          <button
            key={s.id ?? 'all'}
            onClick={() => setStation(s.id)}
            className={cn(
              'shrink-0 rounded-full border px-4 py-1.5 text-sm transition-colors',
              station === s.id
                ? 'border-foreground bg-foreground text-background'
                : 'bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {s.name}
          </button>
        ))}
      </div>
      {shown.length === 0 && <PageState>No open tickets.</PageState>}
    <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] items-start gap-4">
      {shown.map((kot) => {
        const cancelling = kot.type === 'cancelled' || kot.type === 'partially_cancelled'
        // A cancellation has nothing to cook: one tap to acknowledge and clear it.
        const next = cancelling ? { status: 'served' as const, label: 'Got it' } : NEXT[kot.status]
        return (
          <article
            key={kot.id}
            className={cn(
              'grid gap-4 rounded-2xl border bg-background p-5',
              cancelling && 'border-destructive/50',
            )}
          >
            <header className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{kot.table ?? 'Takeaway'}</h2>
                <p className="text-xs text-muted-foreground">
                  {kot.station_name} · #{kot.order} · {time(kot.created_at)}
                </p>
              </div>
              <span
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs font-medium first-letter:uppercase',
                  cancelling ? 'bg-destructive/10 text-destructive' : 'bg-muted',
                )}
              >
                {LABEL[kot.type] ?? kot.status}
              </span>
            </header>
            <ul className="grid gap-2">
              {kot.items.map((item) => (
                <li key={item.id} className={cn('text-sm', cancelling && 'line-through')}>
                  <span className="mr-2 font-semibold tabular-nums">{item.quantity}</span>
                  {item.name}
                  {item.is_jain && <JainTag />}
                  {item.note && <p className="text-xs text-amber-700 no-underline">{item.note}</p>}
                </li>
              ))}
            </ul>
            {next && (
              <Button
                size="lg"
                variant={cancelling ? 'outline' : 'default'}
                className="h-10"
                disabled={advance.isPending}
                onClick={() => advance.mutate({ id: kot.id, status: next.status })}
              >
                {next.label}
              </Button>
            )}
            <button
              disabled={reprint.isPending}
              onClick={() => reprint.mutate(kot.id)}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {reprint.isSuccess && reprint.variables === kot.id ? 'Sent to printer' : 'Reprint'}
            </button>
          </article>
        )
      })}
    </div>
    </div>
  )
}
