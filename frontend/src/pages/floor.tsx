import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreVertical } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { PageState } from '@/components/page-state'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSocket } from '@/hooks/use-socket'
import { apiAll, post } from '@/lib/api'
import type { Room, Table } from '@/lib/types'
import { cn } from '@/lib/utils'

const TONE: Record<Table['status'], string> = {
  free: 'bg-background hover:border-foreground/40',
  occupied: 'border-foreground bg-foreground text-background',
  billed: 'border-warning bg-warning/10 text-foreground',
}

/** A table action that needs other tables picked on the floor before it can run. */
type Picking =
  | { kind: 'join'; anchor: Table; picked: number[] }
  | { kind: 'move'; anchor: Table; order: number }

export function FloorPage() {
  const queryClient = useQueryClient()
  const rooms = useQuery({
    queryKey: ['rooms'],
    queryFn: () => apiAll<Room>('/rooms/?is_active=true'),
  })
  const tables = useQuery({
    queryKey: ['tables'],
    queryFn: () => apiAll<Table>('/tables/?is_active=true'),
  })
  useSocket('/ws/floor/', () => queryClient.invalidateQueries({ queryKey: ['tables'] }))

  const [picking, setPicking] = useState<Picking | null>(null)
  const [error, setError] = useState('')
  const run = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body),
    onMutate: () => setError(''),
    onError: (err) => setError(err.message),
    onSuccess: () => setPicking(null),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tables'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })

  if (rooms.isPending || tables.isPending) return <PageState>Loading…</PageState>
  if (rooms.isError || tables.isError) return <PageState error>Could not load the floor.</PageState>
  if (rooms.data.length === 0) {
    return <PageState>No rooms yet. Add rooms and tables in the admin.</PageState>
  }

  const byId = new Map(tables.data.map((t) => [t.id, t]))
  const primaryOf = (t: Table) => (t.merged_into ? byId.get(t.merged_into)! : t)
  const grouped = (t: Table) => t.merged_into !== null || t.merged_tables.length > 0
  const start = (next: Picking) => {
    setError('')
    setPicking(next)
  }

  // While picking, only tables the action can use stay tappable.
  const canPick = (t: Table) => {
    if (!picking || t.status !== 'free') return false
    if (picking.kind === 'move') return true // a joined table resolves to its group
    return t.room === picking.anchor.room && !grouped(t)
  }
  const pick = (t: Table) => {
    if (!picking) return
    if (picking.kind === 'move') {
      run.mutate({ path: `/orders/${picking.order}/transfer/`, body: { table: t.id } })
    } else {
      const picked = picking.picked.includes(t.id)
        ? picking.picked.filter((id) => id !== t.id)
        : [...picking.picked, t.id]
      setPicking({ ...picking, picked })
    }
  }

  return (
    <div className="grid gap-8">
      {(picking || error) && (
        <div className="sticky top-16 z-10 flex min-h-14 flex-wrap items-center gap-3 rounded-2xl border bg-background px-5 py-3 shadow-sm">
          <p className={cn('mr-auto text-sm', error && 'text-destructive')}>
            {error ||
              (picking?.kind === 'move'
                ? `Pick a free table to move ${picking.anchor.label} to.`
                : `Pick free tables in the same room to join with ${picking?.anchor.label}.`)}
          </p>
          {picking?.kind === 'join' && picking.picked.length > 0 && (
            <Button
              size="lg"
              disabled={run.isPending}
              onClick={() =>
                run.mutate({
                  path: `/tables/${picking.anchor.id}/merge/`,
                  body: { tables: picking.picked },
                })
              }
            >
              Join {[picking.anchor.label, ...picking.picked.map((id) => byId.get(id)!.name)].join(' + ')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="lg"
            onClick={() => {
              setPicking(null)
              setError('')
            }}
          >
            {picking ? 'Cancel' : 'Dismiss'}
          </Button>
        </div>
      )}

      {rooms.data.map((room) => {
        const inRoom = tables.data.filter((t) => t.room === room.id)
        const busy = inRoom.filter((t) => t.status !== 'free').length
        return (
          <section key={room.id} className="grid gap-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold tracking-tight">{room.name}</h2>
              <span className="text-sm text-muted-foreground">
                {busy} of {inRoom.length} occupied
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
              {inRoom.map((t) => {
                const primary = primaryOf(t)
                const isAnchor = picking?.anchor.id === primary.id
                const isPicked = picking?.kind === 'join' && picking.picked.includes(t.id)
                const tile = cn(
                  'flex aspect-[4/3] w-full flex-col justify-between rounded-2xl border p-4 text-left transition-all',
                  TONE[t.status],
                  (isAnchor || isPicked) && 'ring-2 ring-foreground ring-offset-2',
                  picking && !isAnchor && !canPick(t) && 'opacity-30',
                )
                const body = (
                  <>
                    <span className="text-xl font-semibold tracking-tight">{t.name}</span>
                    <span className="flex flex-wrap items-center justify-between gap-x-2 text-xs opacity-70">
                      <span>{grouped(t) ? primary.label : `${t.seats} seats`}</span>
                      <span className="capitalize">{t.status === 'free' ? '' : t.status}</span>
                    </span>
                  </>
                )

                if (picking) {
                  return (
                    <button
                      key={t.id}
                      className={tile}
                      disabled={!canPick(t) || run.isPending}
                      onClick={() => pick(t)}
                    >
                      {body}
                    </button>
                  )
                }
                return (
                  <div key={t.id} className="relative">
                    <Link
                      className={tile}
                      to={
                        t.active_order
                          ? `/orders/${t.active_order}`
                          : `/orders/new?table=${primary.id}`
                      }
                    >
                      {body}
                    </Link>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Actions for ${t.name}`}
                        className={cn(
                          'absolute top-2 right-2 grid size-9 place-items-center rounded-full transition-colors',
                          t.status === 'occupied'
                            ? 'text-background/70 hover:bg-background/15 hover:text-background'
                            : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                        )}
                      >
                        <MoreVertical className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          onClick={() => start({ kind: 'join', anchor: primary, picked: [] })}
                        >
                          Join with…
                        </DropdownMenuItem>
                        {t.active_order && (
                          <DropdownMenuItem
                            onClick={() =>
                              start({ kind: 'move', anchor: primary, order: t.active_order! })
                            }
                          >
                            Move to…
                          </DropdownMenuItem>
                        )}
                        {grouped(t) && (
                          <DropdownMenuItem
                            onClick={() => run.mutate({ path: `/tables/${primary.id}/unmerge/` })}
                          >
                            Split {primary.label}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
