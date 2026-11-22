import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { DateRangeFilter, Pills } from '@/components/date-range'
import { Select } from '@/components/fields'
import { PageState } from '@/components/page-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { dateKey, useUrlFilters } from '@/hooks/use-url-filters'
import { api, apiAll } from '@/lib/api'
import { money, time } from '@/lib/format'
import type { Order, Paginated, Room, Table } from '@/lib/types'
import { cn } from '@/lib/utils'

const STATUSES = [
  { value: '', label: 'All' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'active', label: 'Still open' },
] as const

const TYPES = [
  { value: '', label: 'All' },
  { value: 'dine_in', label: 'Dine-in' },
  { value: 'takeaway', label: 'Takeaway' },
] as const

const STATUS_TONE: Record<Order['status'], string> = {
  open: 'bg-info/10 text-info',
  billed: 'bg-warning/10 text-warning',
  paid: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
}
const STATUS_LABEL: Record<Order['status'], string> = {
  open: 'Open',
  billed: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

interface Summary {
  orders: number
  paid: number
  cancelled: number
  active: number
  sales: string
  discounts: string
}

const dayHeading = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

// ---------- page ----------

export function HistoryPage() {
  // Filters live in the URL, so opening an order and coming back keeps them.
  const filters = useUrlFilters()
  const { params, range, from, to, update } = filters
  const status = params.get('status') ?? ''
  const type = params.get('type') ?? ''
  const table = params.get('table') ? Number(params.get('table')) : null
  const q = params.get('q') ?? ''

  // Typing searches after a short pause instead of on every key.
  const [search, setSearch] = useState(q)
  const typing = useRef<number | undefined>(undefined)
  const onSearch = (value: string) => {
    setSearch(value)
    window.clearTimeout(typing.current)
    typing.current = window.setTimeout(() => update({ q: value.trim() || null }), 300)
  }

  const apiParams = new URLSearchParams()
  if (from) apiParams.set('date_from', from)
  if (to) apiParams.set('date_to', to)
  if (status === 'active') apiParams.set('status__in', 'open,billed')
  else if (status) apiParams.set('status', status)
  if (type) apiParams.set('order_type', type)
  if (table) apiParams.set('table', String(table))
  if (q) apiParams.set('q', q)
  const query = apiParams.toString()

  const orders = useInfiniteQuery({
    queryKey: ['orders', 'history', query],
    queryFn: ({ pageParam }) => api<Paginated<Order>>(`/orders/?${query}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.next ? pages.length + 1 : undefined),
  })
  const summary = useQuery({
    queryKey: ['orders', 'summary', query],
    queryFn: () => api<Summary>(`/orders/summary/?${query}`),
  })
  const tables = useQuery({ queryKey: ['tables', 'all'], queryFn: () => apiAll<Table>('/tables/') })
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => apiAll<Room>('/rooms/') })

  const tableOptions = (tables.data ?? [])
    .map((t) => ({ t, room: rooms.data?.find((r) => r.id === t.room) }))
    .sort(
      (a, b) =>
        (a.room?.sort_order ?? 0) - (b.room?.sort_order ?? 0) ||
        a.t.name.length - b.t.name.length ||
        a.t.name.localeCompare(b.t.name),
    )
    .map(({ t, room }) => ({ value: t.id, label: room ? `${t.name} · ${room.name}` : t.name }))

  const list = orders.data?.pages.flatMap((p) => p.results) ?? []
  const multiDay = !from || from !== to

  const filtered = Boolean(status || type || table || q || range !== 'today')

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
      {/* ---------- filters: a column on the left on wide screens ---------- */}
      <section className="grid gap-4 rounded-2xl border bg-background p-4 xl:sticky xl:top-20">
        <h1 className="text-lg font-semibold tracking-tight">Order history</h1>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Order #, customer name or phone"
            aria-label="Search orders"
            className="h-10 rounded-xl pl-10"
          />
        </div>

        <DateRangeFilter filters={filters} />

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 xl:grid">
          <Pills label="Status" options={STATUSES} value={status} onChange={(v) => update({ status: v })} />
          <Pills label="Type" options={TYPES} value={type} onChange={(v) => update({ type: v })} />
          <Select
            label="Table"
            value={table}
            onChange={(v) => update({ table: v ? String(v) : null })}
            empty="All tables"
            options={tableOptions}
          />
        </div>

        {filtered && (
          <button
            onClick={() => {
              window.clearTimeout(typing.current)
              setSearch('')
              filters.reset()
            }}
            className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Clear filters
          </button>
        )}
      </section>

      <div className="grid min-w-0 gap-5">
      {/* ---------- summary ---------- */}
      {summary.data && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Orders" value={String(summary.data.orders)} />
          <Stat label="Sales (paid)" value={money(summary.data.sales)} hint={`${summary.data.paid} paid`} />
          <Stat label="Discounts given" value={money(summary.data.discounts)} />
          <Stat
            label="Cancelled"
            value={String(summary.data.cancelled)}
            hint={summary.data.active ? `${summary.data.active} still open` : undefined}
          />
        </dl>
      )}

      {/* ---------- list ---------- */}
      {orders.isPending ? (
        <PageState>Loading…</PageState>
      ) : orders.isError ? (
        <PageState error>Could not load orders.</PageState>
      ) : list.length === 0 ? (
        <PageState>No orders match these filters.</PageState>
      ) : (
        <div className="grid gap-4">
          {groupByDay(list, multiDay).map((group) => (
            <section key={group.key} className="grid gap-2">
              {group.heading && <h2 className="px-1 text-sm font-medium">{group.heading}</h2>}
              <ul className="divide-y overflow-hidden rounded-2xl border bg-background">
                {group.orders.map((order) => (
                  <OrderRow key={order.id} order={order} />
                ))}
              </ul>
            </section>
          ))}
          {orders.hasNextPage && (
            <Button
              variant="outline"
              size="lg"
              className="mx-auto"
              disabled={orders.isFetchingNextPage}
              onClick={() => orders.fetchNextPage()}
            >
              {orders.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </Button>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

function groupByDay(orders: Order[], multiDay: boolean) {
  if (!multiDay) return [{ key: 'all', heading: null as string | null, orders }]
  const groups: { key: string; heading: string | null; orders: Order[] }[] = []
  for (const order of orders) {
    const key = dateKey(new Date(order.created_at))
    if (groups.at(-1)?.key !== key) groups.push({ key, heading: dayHeading(order.created_at), orders: [] })
    groups.at(-1)!.orders.push(order)
  }
  return groups
}

function OrderRow({ order }: { order: Order }) {
  const count = order.items.reduce((n, i) => n + i.quantity, 0)
  return (
    <li>
      <Link
        to={`/orders/${order.id}`}
        className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/50"
      >
        <span className="w-16 shrink-0 text-sm text-muted-foreground tabular-nums">{time(order.created_at)}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {order.table_name ?? 'Takeaway'}
            <span className="ml-2 font-normal text-muted-foreground">#{order.id}</span>
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {order.customer_name && <span className="font-medium text-foreground">{order.customer_name} · </span>}
            {order.customer_phone && `${order.customer_phone} · `}
            {order.waiter_name} · {count} {count === 1 ? 'item' : 'items'}
          </p>
        </div>
        <span className={cn('hidden rounded-full px-2.5 py-0.5 text-xs font-medium sm:inline', STATUS_TONE[order.status])}>
          {STATUS_LABEL[order.status]}
        </span>
        <span
          className={cn(
            'w-24 text-right font-medium tabular-nums',
            order.status === 'cancelled' && 'text-muted-foreground line-through',
          )}
        >
          {money(order.total)}
        </span>
      </Link>
    </li>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border bg-background px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}
