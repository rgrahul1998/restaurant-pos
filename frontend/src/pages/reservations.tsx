import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Phone, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { PageState } from '@/components/page-state'
import { Chips, Field, Sheet } from '@/components/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSocket } from '@/hooks/use-socket'
import { api, apiAll, patch, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { money, time } from '@/lib/format'
import { canManageReservations } from '@/lib/nav'
import { METHODS } from '@/lib/payments'
import type {
  Occasion,
  PaymentMethod,
  Reservation,
  Room,
  Table,
  TableAvailability,
} from '@/lib/types'
import { cn } from '@/lib/utils'

// ---------- dates (all in the browser's local time, which is the restaurant's) ----------

const pad = (n: number) => String(n).padStart(2, '0')
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const fromKey = (key: string) => new Date(`${key}T00:00`)
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7)) // Monday
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)
/** Monday on or before the 1st, through the Sunday on or after the month's last day. */
function monthGrid(d: Date) {
  const first = startOfWeek(startOfMonth(d))
  const last = addDays(addMonths(d, 1), -1)
  const end = addDays(startOfWeek(last), 7)
  return { first, end }
}
const hourLabel = (h: number) => `${h % 12 || 12} ${h % 24 < 12 ? 'am' : 'pm'}`
const at = (key: string, clock: string) => new Date(`${key}T${clock}`)
const dayLabel = (d: Date, opts: Intl.DateTimeFormatOptions = {}) =>
  d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...opts })

/** The window a booking form describes; an end at or before the start means after midnight. */
function windowOf(day: string, start: string, end: string) {
  const from = at(day, start)
  let to = at(day, end)
  if (to <= from) to = new Date(to.getTime() + 86_400_000)
  return { from, to, overnight: dateKey(to) !== day }
}

const OCCASIONS: { value: Occasion; label: string }[] = [
  { value: 'birthday', label: 'Birthday' },
  { value: 'anniversary', label: 'Anniversary' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'other', label: 'Other' },
]

const STATUS: Record<Reservation['status'], { label: string; tone: string }> = {
  confirmed: { label: 'Confirmed', tone: 'bg-foreground text-background border-foreground' },
  seated: { label: 'Seated', tone: 'bg-success/10 text-success border-success/50' },
  cancelled: { label: 'Cancelled', tone: 'bg-muted text-muted-foreground border-border line-through' },
  no_show: { label: 'No-show', tone: 'bg-muted text-muted-foreground border-border line-through' },
}

const sortTables = (a: { name: string }, b: { name: string }) =>
  a.name.length - b.name.length || a.name.localeCompare(b.name)

type Panel =
  | { kind: 'new'; day: string; start: string; table?: number }
  | { kind: 'edit'; reservation: Reservation }
  | { kind: 'view'; id: number }

// ---------- page ----------

export function ReservationsPage() {
  const queryClient = useQueryClient()
  const role = useAuth((s) => s.user!.role)
  const canManage = canManageReservations(role)
  const [day, setDay] = useState(() => dateKey(new Date()))
  const [view, setView] = useState<'day' | 'month'>('day')
  const [panel, setPanel] = useState<Panel | null>(null)

  const grid = monthGrid(fromKey(day))
  const from = view === 'day' ? fromKey(day) : grid.first
  const to = view === 'day' ? addDays(from, 1) : grid.end

  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => apiAll<Room>('/rooms/?is_active=true') })
  const tables = useQuery({
    queryKey: ['tables'],
    queryFn: () => apiAll<Table>('/tables/?is_active=true'),
  })
  const bookings = useQuery({
    queryKey: ['reservations', from.toISOString(), to.toISOString()],
    queryFn: () =>
      api<Reservation[]>(
        `/reservations/?start=${encodeURIComponent(from.toISOString())}&end=${encodeURIComponent(to.toISOString())}`,
      ),
  })
  useSocket<{ id?: number }>('/ws/floor/', (msg) => {
    if (msg.event === 'reservation.updated') {
      queryClient.invalidateQueries({ queryKey: ['reservations'] })
      queryClient.invalidateQueries({ queryKey: ['reservation'] })
      queryClient.invalidateQueries({ queryKey: ['availability'] })
    }
  })

  const step = (n: number) =>
    setDay(dateKey(view === 'day' ? addDays(fromKey(day), n) : addMonths(fromKey(day), n)))
  const title =
    view === 'day'
      ? dayLabel(fromKey(day), { weekday: 'long', year: 'numeric' })
      : fromKey(day).toLocaleDateString([], { month: 'long', year: 'numeric' })

  let body
  if (rooms.isPending || tables.isPending || bookings.isPending) {
    body = <PageState>Loading…</PageState>
  } else if (rooms.isError || tables.isError || bookings.isError) {
    body = <PageState error>Could not load reservations.</PageState>
  } else if (view === 'day') {
    body = (
      <DayView
        day={day}
        rooms={rooms.data}
        tables={tables.data}
        bookings={bookings.data}
        onOpen={(id) => setPanel({ kind: 'view', id })}
        onSlot={
          canManage ? (table, start) => setPanel({ kind: 'new', day, start, table }) : undefined
        }
      />
    )
  } else {
    body = (
      <MonthView
        month={fromKey(day)}
        from={from}
        to={to}
        bookings={bookings.data}
        onOpen={(id) => setPanel({ kind: 'view', id })}
        onDay={(key) => {
          setDay(key)
          setView('day')
        }}
      />
    )
  }

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold tracking-tight">Reservations</h1>
          <p className="text-sm text-muted-foreground">{title}</p>
        </div>
        <div className="flex rounded-lg border p-0.5">
          {(['day', 'month'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'h-8 rounded-md px-3 text-sm capitalize transition-colors',
                view === v ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-lg" aria-label="Previous" onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="lg" onClick={() => setDay(dateKey(new Date()))}>
            Today
          </Button>
          <Button variant="outline" size="icon-lg" aria-label="Next" onClick={() => step(1)}>
            <ChevronRight />
          </Button>
          <Input
            type="date"
            aria-label="Go to date"
            className="h-9 w-40"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
        </div>
        {canManage && (
          <Button size="lg" onClick={() => setPanel({ kind: 'new', day, start: '19:00' })}>
            <Plus /> New booking
          </Button>
        )}
      </header>

      {body}

      {panel && (
        <Sheet onClose={() => setPanel(null)}>
          {panel.kind === 'view' ? (
            <Details
              id={panel.id}
              canManage={canManage}
              onEdit={(reservation) => setPanel({ kind: 'edit', reservation })}
              onClose={() => setPanel(null)}
            />
          ) : (
            <BookingForm
              key={panel.kind === 'edit' ? `e${panel.reservation.id}` : `n${panel.day}${panel.start}${panel.table}`}
              rooms={rooms.data ?? []}
              initial={panel}
              onDone={(saved) => {
                setDay(dateKey(new Date(saved.start_at)))
                setPanel({ kind: 'view', id: saved.id })
              }}
              onCancel={() =>
                setPanel(panel.kind === 'edit' ? { kind: 'view', id: panel.reservation.id } : null)
              }
            />
          )}
        </Sheet>
      )}
    </div>
  )
}

// ---------- day view: tables down the side, time across ----------

const SLOT_MINUTES = 30

function DayView(props: {
  day: string
  rooms: Room[]
  tables: Table[]
  bookings: Reservation[]
  onOpen: (id: number) => void
  onSlot?: (table: number, start: string) => void
}) {
  const dayStart = fromKey(props.day)
  const live = props.bookings.filter((b) => b.status !== 'cancelled' && b.status !== 'no_show')
  const hourOf = (iso: string) => (new Date(iso).getTime() - dayStart.getTime()) / 3_600_000
  // 10:00 to midnight, stretched to fit any booking outside it.
  const first = Math.max(0, Math.floor(Math.min(10, ...live.map((b) => hourOf(b.start_at)))))
  const last = Math.min(30, Math.ceil(Math.max(24, ...live.map((b) => hourOf(b.end_at)))))
  const span = last - first
  const hours = Array.from({ length: span }, (_, i) => first + i)
  const pct = (h: number) => `${((Math.min(Math.max(h, first), last) - first) / span) * 100}%`

  const [loadedAt] = useState(Date.now)
  const now = (loadedAt - dayStart.getTime()) / 3_600_000
  const showNow = now > first && now < last

  // On a narrow screen only a few hours show: open at the current time on today, else at
  // the first booking, instead of at 10 am.
  const scroller = useRef<HTMLDivElement>(null)
  const firstBooking = live.length ? Math.min(...live.map((b) => hourOf(b.start_at))) : first
  const focus = Math.max(first, (showNow ? now : firstBooking) - 1)
  useEffect(() => {
    const el = scroller.current
    const track = el?.querySelector<HTMLElement>('[data-track]')
    if (!el || !track) return
    // The table names stay pinned on the left, so this puts `focus` just right of them.
    el.scrollLeft = ((focus - first) / span) * track.offsetWidth
  }, [props.day, focus, first, span])

  const slotAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const hour = first + ((e.clientX - box.left) / box.width) * span
    const minutes = Math.floor((hour * 60) / SLOT_MINUTES) * SLOT_MINUTES
    const d = new Date(dayStart.getTime() + minutes * 60_000)
    return hhmm(d)
  }

  return (
    <div ref={scroller} className="overflow-x-auto rounded-2xl border">
      <div className="min-w-[48rem] sm:min-w-[56rem]">
        <div className="grid grid-cols-[4.5rem_1fr] border-b bg-background sm:grid-cols-[8rem_1fr]">
          <div className="sticky left-0 z-[3] border-r bg-background" />
          <div data-track className="relative h-9">
            {hours.map((h) => (
              <span
                key={h}
                className="absolute top-2.5 pl-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums sm:text-xs"
                style={{ left: pct(h) }}
              >
                {hourLabel(h)}
              </span>
            ))}
          </div>
        </div>

        {props.rooms.map((room) => {
          const inRoom = props.tables.filter((t) => t.room === room.id).sort(sortTables)
          if (!inRoom.length) return null
          return (
            <section key={room.id}>
              <h2 className="border-b bg-muted/40 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <span className="sticky left-0 inline-block px-3 sm:px-4">{room.name}</span>
              </h2>
              {inRoom.map((table) => (
                <div
                  key={table.id}
                  className="grid grid-cols-[4.5rem_1fr] border-b last:border-b-0 sm:grid-cols-[8rem_1fr]"
                >
                  {/* Stays put while the timeline scrolls sideways on a phone. */}
                  <div className="sticky left-0 z-[3] flex flex-col justify-center border-r bg-background px-3 py-2 sm:px-4">
                    <span className="text-sm font-medium">{table.name}</span>
                    <span className="text-xs text-muted-foreground">{table.seats} seats</span>
                  </div>
                  <div
                    className={cn('relative h-14', props.onSlot && 'cursor-cell hover:bg-muted/30')}
                    onClick={props.onSlot ? (e) => props.onSlot!(table.id, slotAt(e)) : undefined}
                  >
                    {hours.map((h) => (
                      <span
                        key={h}
                        className="absolute inset-y-0 border-l border-dashed border-border/70"
                        style={{ left: pct(h) }}
                      />
                    ))}
                    {showNow && (
                      <span className="absolute inset-y-0 z-[1] w-px bg-destructive" style={{ left: pct(now) }} />
                    )}
                    {live
                      .filter((b) => b.tables.includes(table.id))
                      .map((b) => {
                        const start = hourOf(b.start_at)
                        const end = hourOf(b.end_at)
                        return (
                          <button
                            key={b.id}
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onOpen(b.id)
                            }}
                            className={cn(
                              'absolute inset-y-1.5 z-[2] flex min-w-0 flex-col justify-center overflow-hidden rounded-lg border px-2 text-left text-xs transition-shadow hover:shadow-md',
                              STATUS[b.status].tone,
                            )}
                            style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }}
                            title={`${b.customer_name} · ${time(b.start_at)}–${time(b.end_at)}`}
                          >
                            <span className="truncate font-medium">{b.customer_name}</span>
                            <span className="truncate opacity-70">
                              {time(b.start_at)}–{time(b.end_at)} · {b.guests} guests
                            </span>
                          </button>
                        )
                      })}
                  </div>
                </div>
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ---------- month view ----------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_CHIPS = 3

function MonthView(props: {
  month: Date
  from: Date
  to: Date
  bookings: Reservation[]
  onOpen: (id: number) => void
  onDay: (key: string) => void
}) {
  const [today] = useState(() => dateKey(new Date()))
  const days: Date[] = []
  for (let d = props.from; d < props.to; d = addDays(d, 1)) days.push(d)
  const byDay = new Map<string, Reservation[]>()
  for (const b of props.bookings) {
    const key = dateKey(new Date(b.start_at))
    byDay.set(key, [...(byDay.get(key) ?? []), b])
  }

  return (
    <div className="overflow-hidden rounded-2xl border">
      <div className="grid grid-cols-7 border-b bg-muted/40">
        {WEEKDAYS.map((w) => (
          <span key={w} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {w}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const key = dateKey(d)
          const all = byDay.get(key) ?? []
          const live = all.filter((b) => b.status === 'confirmed' || b.status === 'seated')
          const shown = all.slice(0, MAX_CHIPS)
          const outside = d.getMonth() !== props.month.getMonth()
          return (
            <div
              key={key}
              className={cn(
                'flex min-h-16 min-w-0 flex-col gap-1 border-b p-1 sm:min-h-28 sm:p-1.5',
                i % 7 !== 6 && 'border-r',
                i >= days.length - 7 && 'border-b-0',
                outside && 'bg-muted/30',
              )}
            >
              <button
                onClick={() => props.onDay(key)}
                className="flex flex-col items-center gap-1 rounded-md px-1 hover:bg-muted sm:flex-row sm:justify-between"
                aria-label={`Open ${dayLabel(d)}`}
              >
                <span
                  className={cn(
                    'grid size-6 place-items-center rounded-full text-xs tabular-nums',
                    outside && 'text-muted-foreground',
                    key === today && 'bg-primary font-semibold text-primary-foreground',
                  )}
                >
                  {d.getDate()}
                </span>
                {live.length > 0 && (
                  <span className="rounded-full bg-foreground px-1.5 text-[10px] leading-4 font-medium text-background tabular-nums sm:hidden">
                    {live.length}
                  </span>
                )}
              </button>
              <div className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                {shown.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => props.onOpen(b.id)}
                    title={`${b.customer_name} · ${time(b.start_at)}–${time(b.end_at)} · ${b.table_names} · ${b.guests} guests`}
                    className={cn(
                      'truncate rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-4',
                      STATUS[b.status].tone,
                    )}
                  >
                    <span className="tabular-nums opacity-70">{time(b.start_at)}</span>{' '}
                    <span className="font-medium">{b.customer_name}</span>
                  </button>
                ))}
                {all.length > MAX_CHIPS && (
                  <button
                    onClick={() => props.onDay(key)}
                    className="px-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    +{all.length - MAX_CHIPS} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** "19:30" → "7:30 pm" */
const clockLabel = (value: string) => {
  const [h, m] = value.split(':').map(Number)
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`
}
// Every 15 minutes; the browser's own time input would follow the OS 24-hour setting.
const CLOCK = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`)

function TimeSelect(props: { label: string; value: string; onChange: (v: string) => void }) {
  const options = CLOCK.includes(props.value) ? CLOCK : [props.value, ...CLOCK].sort()
  return (
    <select
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {options.map((v) => (
        <option key={v} value={v}>
          {clockLabel(v)}
        </option>
      ))}
    </select>
  )
}

// ---------- create / edit ----------

function BookingForm(props: {
  rooms: Room[]
  initial: Extract<Panel, { kind: 'new' | 'edit' }>
  onDone: (saved: Reservation) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const editing = props.initial.kind === 'edit' ? props.initial.reservation : null
  const [form, setForm] = useState(() => {
    if (editing) {
      const start = new Date(editing.start_at)
      return {
        customer_name: editing.customer_name,
        customer_phone: editing.customer_phone,
        guests: String(editing.guests),
        occasion: editing.occasion,
        note: editing.note,
        day: dateKey(start),
        start: hhmm(start),
        end: hhmm(new Date(editing.end_at)),
        tables: editing.tables,
      }
    }
    const { day, start, table } = props.initial as Extract<Panel, { kind: 'new' }>
    const end = hhmm(new Date(at(day, start).getTime() + 2 * 3_600_000))
    return {
      customer_name: '',
      customer_phone: '',
      guests: '',
      occasion: 'birthday' as Occasion,
      note: '',
      day,
      start,
      end,
      tables: table ? [table] : [],
    }
  })
  const [advance, setAdvance] = useState({ amount: '', method: 'upi' as PaymentMethod, reference: '' })
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const span = windowOf(form.day, form.start, form.end)
  const validTimes = Boolean(form.start && form.end)
  const availability = useQuery({
    queryKey: ['availability', span.from.toISOString(), span.to.toISOString(), editing?.id],
    enabled: validTimes,
    queryFn: () =>
      api<TableAvailability[]>(
        `/reservations/availability/?start=${encodeURIComponent(span.from.toISOString())}&end=${encodeURIComponent(span.to.toISOString())}${editing ? `&exclude=${editing.id}` : ''}`,
      ),
  })

  const rows = availability.data ?? []
  const byId = new Map(rows.map((r) => [r.table, r]))
  const picked = form.tables.filter((id) => !byId.get(id)?.booked_by)
  const clashing = form.tables.filter((id) => byId.get(id)?.booked_by)
  const seats = picked.reduce((sum, id) => sum + (byId.get(id)?.seats ?? 0), 0)

  const toggle = (row: TableAvailability) => {
    const roomOfPicked = byId.get(form.tables[0])?.room
    if (form.tables.includes(row.table)) set('tables', form.tables.filter((id) => id !== row.table))
    // One room per booking: picking in another room starts over there.
    else if (roomOfPicked !== undefined && roomOfPicked !== row.room) set('tables', [row.table])
    else set('tables', [...form.tables, row.table])
  }
  const wholeRoom = (room: number) =>
    set(
      'tables',
      rows.filter((r) => r.room === room && !r.booked_by).map((r) => r.table),
    )

  const save = useMutation({
    mutationFn: () => {
      const body = {
        customer_name: form.customer_name.trim(),
        customer_phone: form.customer_phone.trim(),
        guests: Number(form.guests) || 1,
        occasion: form.occasion,
        note: form.note.trim(),
        start_at: span.from.toISOString(),
        end_at: span.to.toISOString(),
        tables: form.tables,
        ...(!editing && Number(advance.amount) > 0 ? { advance } : {}),
      }
      return editing
        ? patch<Reservation>(`/reservations/${editing.id}/`, body)
        : post<Reservation>('/reservations/', body)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['reservations'] })
      queryClient.setQueryData(['reservation', saved.id], saved)
      props.onDone(saved)
    },
  })

  const ready =
    form.customer_name.trim() && form.customer_phone.trim() && validTimes && picked.length > 0 && !clashing.length

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) save.mutate()
      }}
    >
      <h2 className="text-xl font-semibold tracking-tight">{editing ? 'Edit booking' : 'New booking'}</h2>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Customer name">
          <Input
            autoFocus
            value={form.customer_name}
            onChange={(e) => set('customer_name', e.target.value)}
          />
        </Field>
        <Field label="Phone">
          <Input
            type="tel"
            value={form.customer_phone}
            onChange={(e) => set('customer_phone', e.target.value)}
          />
        </Field>
      </div>

      <Field label="Occasion">
        <Chips options={OCCASIONS} value={form.occasion} onChange={(v) => set('occasion', v)} />
      </Field>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
        <div className="col-span-2 sm:col-span-1">
          <Field label="Date">
            <Input type="date" value={form.day} onChange={(e) => set('day', e.target.value)} />
          </Field>
        </div>
        <Field label="From">
          <TimeSelect label="From" value={form.start} onChange={(v) => set('start', v)} />
        </Field>
        <Field label="To" hint={span.overnight ? 'Ends next day' : undefined}>
          <TimeSelect label="To" value={form.end} onChange={(v) => set('end', v)} />
        </Field>
      </div>

      <Field label="Guests">
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          className="w-28"
          value={form.guests}
          onChange={(e) => set('guests', e.target.value)}
        />
      </Field>

      <div className="grid gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Tables</span>
          {picked.length > 0 && (
            <span
              className={cn(
                'text-xs',
                Number(form.guests) > seats ? 'text-warning' : 'text-muted-foreground',
              )}
            >
              {seats} seats{Number(form.guests) > seats && ` for ${form.guests} guests`}
            </span>
          )}
        </div>
        {availability.isPending && validTimes ? (
          <p className="text-sm text-muted-foreground">Checking which tables are free…</p>
        ) : (
          props.rooms.map((room) => {
            const inRoom = rows.filter((r) => r.room === room.id).sort(sortTables)
            if (!inRoom.length) return null
            return (
              <div key={room.id} className="grid gap-1.5 rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {room.name}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    onClick={() => wholeRoom(room.id)}
                  >
                    Whole room
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {inRoom.map((r) => {
                    const on = form.tables.includes(r.table)
                    return (
                      <button
                        key={r.table}
                        type="button"
                        disabled={Boolean(r.booked_by) && !on}
                        onClick={() => toggle(r)}
                        title={
                          r.booked_by
                            ? `Booked ${time(r.booked_by.start_at)}–${time(r.booked_by.end_at)} by ${r.booked_by.customer_name}`
                            : `${r.seats} seats`
                        }
                        className={cn(
                          'h-9 rounded-lg border px-3 text-sm transition-colors disabled:cursor-not-allowed',
                          on && !r.booked_by && 'border-foreground bg-foreground text-background',
                          on && r.booked_by && 'border-destructive bg-destructive/10 text-destructive',
                          !on && r.booked_by && 'border-dashed text-muted-foreground/60 line-through',
                          !on && !r.booked_by && 'hover:bg-muted',
                        )}
                      >
                        {r.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
        {clashing.map((id) => {
          const r = byId.get(id)!
          return (
            <p key={id} className="text-xs text-destructive">
              {r.name} is booked {time(r.booked_by!.start_at)}–{time(r.booked_by!.end_at)} by{' '}
              {r.booked_by!.customer_name}. Pick another table or time.
            </p>
          )
        })}
      </div>

      {!editing && (
        <div className="grid gap-3 rounded-xl border p-3">
          <span className="text-sm font-medium">Advance (optional)</span>
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="Amount"
              aria-label="Advance amount"
              value={advance.amount}
              onChange={(e) => setAdvance({ ...advance, amount: e.target.value })}
            />
            <Input
              placeholder="Reference"
              aria-label="Advance reference"
              value={advance.reference}
              onChange={(e) => setAdvance({ ...advance, reference: e.target.value })}
            />
          </div>
          <Chips
            options={METHODS}
            value={advance.method}
            onChange={(method) => setAdvance({ ...advance, method })}
          />
        </div>
      )}

      <Field label="Notes">
        <textarea
          rows={3}
          className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder="Cake at 9, decorations, veg only…"
          value={form.note}
          onChange={(e) => set('note', e.target.value)}
        />
      </Field>

      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="flex-1" disabled={!ready || save.isPending}>
          {editing ? 'Save changes' : 'Book'}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ---------- details and actions ----------

function Details(props: {
  id: number
  canManage: boolean
  onEdit: (r: Reservation) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'idle' | 'advance' | 'cancel' | 'no-show'>('idle')
  const query = useQuery({
    queryKey: ['reservation', props.id],
    queryFn: () => api<Reservation>(`/reservations/${props.id}/`),
  })
  const run = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      post<Reservation>(`/reservations/${props.id}/${path}`, body),
    onSuccess: (data, { path }) => {
      setMode('idle')
      queryClient.invalidateQueries({ queryKey: ['reservations'] })
      queryClient.invalidateQueries({ queryKey: ['reservation', props.id] })
      queryClient.invalidateQueries({ queryKey: ['tables'] })
      if (path === 'seat/' && data.order) navigate(`/orders/${data.order}`)
    },
  })

  if (query.isPending) return <PageState>Loading…</PageState>
  if (query.isError) return <PageState error>Could not load this booking.</PageState>
  const r = query.data
  const confirmed = r.status === 'confirmed'
  const held = Number(r.advance_paid)

  return (
    <div className="grid gap-6">
      <div className="grid gap-2 pr-8">
        <span
          className={cn(
            'w-fit rounded-full border px-2.5 py-0.5 text-xs font-medium',
            STATUS[r.status].tone,
          )}
        >
          {STATUS[r.status].label}
        </span>
        <h2 className="text-2xl font-semibold tracking-tight">{r.customer_name}</h2>
        <a href={`tel:${r.customer_phone}`} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <Phone className="size-3.5" /> {r.customer_phone}
        </a>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Info label="When">
          {dayLabel(new Date(r.start_at))}
          <br />
          {time(r.start_at)} – {time(r.end_at)}
        </Info>
        <Info label="Tables">{r.table_names}</Info>
        <Info label="Guests">{r.guests}</Info>
        <Info label="Occasion">{OCCASIONS.find((o) => o.value === r.occasion)?.label}</Info>
        {r.note && (
          <div className="col-span-2">
            <Info label="Notes">{r.note}</Info>
          </div>
        )}
        {r.cancel_reason && (
          <div className="col-span-2">
            <Info label="Reason">{r.cancel_reason}</Info>
          </div>
        )}
      </dl>

      <section className="grid gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Advance</h3>
          <span className="text-sm font-semibold tabular-nums">
            {money(held)}
            {r.advance_outcome === 'forfeited' && ' kept'}
          </span>
        </div>
        {r.payments.length === 0 && <p className="text-sm text-muted-foreground">No advance taken.</p>}
        {r.payments.map((p) => (
          <div key={p.id} className="flex justify-between text-sm text-muted-foreground tabular-nums">
            <span>
              {p.kind === 'refund' ? 'Refund' : 'Advance'} · {METHODS.find((m) => m.value === p.method)?.label ?? p.method}
              {p.reference && ` · ${p.reference}`}
              <span className="block text-xs">
                {dayLabel(new Date(p.created_at))} · {p.received_by_name}
              </span>
            </span>
            <span>
              {p.kind === 'refund' ? '−' : '+'} {money(p.amount)}
            </span>
          </div>
        ))}
      </section>

      {r.order && (
        <Button variant="outline" size="lg" onClick={() => navigate(`/orders/${r.order}`)}>
          Open order #{r.order}
        </Button>
      )}

      {props.canManage && confirmed && mode === 'idle' && (
        <div className="grid gap-2">
          <Button size="lg" disabled={run.isPending} onClick={() => run.mutate({ path: 'seat/' })}>
            Seat party
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="lg" onClick={() => props.onEdit(r)}>
              Edit
            </Button>
            <Button variant="outline" size="lg" onClick={() => setMode('advance')}>
              Add advance
            </Button>
            <Button variant="destructive" size="lg" onClick={() => setMode('cancel')}>
              Cancel booking
            </Button>
            <Button variant="destructive" size="lg" onClick={() => setMode('no-show')}>
              No-show
            </Button>
          </div>
        </div>
      )}

      {mode === 'advance' && (
        <AdvanceForm
          busy={run.isPending}
          onSubmit={(body) => run.mutate({ path: 'payments/', body })}
          onBack={() => setMode('idle')}
        />
      )}
      {(mode === 'cancel' || mode === 'no-show') && (
        <CancelForm
          noShow={mode === 'no-show'}
          held={held}
          busy={run.isPending}
          onSubmit={(body) => run.mutate({ path: mode === 'cancel' ? 'cancel/' : 'no-show/', body })}
          onBack={() => setMode('idle')}
        />
      )}
      {run.error && <p className="text-sm text-destructive">{run.error.message}</p>}
      <p className="text-xs text-muted-foreground">Booked by {r.created_by_name}</p>
    </div>
  )
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

function AdvanceForm(props: {
  busy: boolean
  onSubmit: (body: { amount: string; method: PaymentMethod; reference: string }) => void
  onBack: () => void
}) {
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('upi')
  const [reference, setReference] = useState('')
  return (
    <form
      className="grid gap-3 rounded-xl border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSubmit({ amount, method, reference })
      }}
    >
      <h3 className="text-sm font-medium">Add advance</h3>
      <div className="grid grid-cols-2 gap-3">
        <Input
          autoFocus
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          placeholder="Amount"
          aria-label="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          placeholder="Reference"
          aria-label="Reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
      <Chips options={METHODS} value={method} onChange={setMethod} />
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="flex-1" disabled={!(Number(amount) > 0) || props.busy}>
          Take {Number(amount) > 0 ? money(amount) : 'advance'}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={props.onBack}>
          Back
        </Button>
      </div>
    </form>
  )
}

function CancelForm(props: {
  noShow: boolean
  held: number
  busy: boolean
  onSubmit: (body: Record<string, string>) => void
  onBack: () => void
}) {
  const [outcome, setOutcome] = useState<'refund' | 'forfeit'>(props.noShow ? 'forfeit' : 'refund')
  const [refund, setRefund] = useState(String(props.held))
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [reason, setReason] = useState('')
  const refundOk = Number(refund) > 0 && Number(refund) <= props.held
  const valid = props.held === 0 || outcome === 'forfeit' || refundOk

  return (
    <form
      className="grid gap-3 rounded-xl border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        const body: Record<string, string> = { reason }
        if (props.held > 0) {
          body.outcome = outcome
          if (outcome === 'refund') Object.assign(body, { refund_amount: refund, method })
        }
        props.onSubmit(body)
      }}
    >
      <h3 className="text-sm font-medium">{props.noShow ? 'Mark as no-show' : 'Cancel booking'}</h3>
      {props.held > 0 && (
        <>
          <p className="text-sm text-muted-foreground">{money(props.held)} was paid in advance.</p>
          <Chips
            options={[
              { value: 'refund', label: 'Refund' },
              { value: 'forfeit', label: 'Keep (forfeit)' },
            ]}
            value={outcome}
            onChange={setOutcome}
          />
          {outcome === 'refund' && (
            <>
              <Field label="Refund amount" hint="Whatever isn't refunded is kept.">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={refund}
                  onChange={(e) => setRefund(e.target.value)}
                />
              </Field>
              <Chips options={METHODS} value={method} onChange={setMethod} />
            </>
          )}
        </>
      )}
      <Input placeholder="Reason (optional)" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" size="lg" className="flex-1" disabled={!valid || props.busy}>
          {props.noShow ? 'Mark no-show' : 'Cancel booking'}
          {props.held > 0 && outcome === 'refund' && refundOk && ` · refund ${money(refund)}`}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={props.onBack}>
          Back
        </Button>
      </div>
    </form>
  )
}
