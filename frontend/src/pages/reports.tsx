import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { BarList, ColumnChart, type Column } from '@/components/charts'
import { DateRangeFilter, Pills } from '@/components/date-range'
import { PageState } from '@/components/page-state'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { api } from '@/lib/api'
import { money } from '@/lib/format'
import { cn } from '@/lib/utils'

// Amounts arrive as JSON numbers.
interface Report {
  date_from: string | null
  date_to: string | null
  summary: {
    orders: number
    gross: number
    discounts: number
    discounted_orders: number
    net: number
    average_bill: number
    guests: number
    per_guest: number
    cancelled_orders: number
    open_orders: number
  }
  by_day: { date: string; orders: number; net: number }[]
  by_hour: { hour: number; orders: number; net: number }[]
  by_type: { type: 'dine_in' | 'takeaway'; orders: number; net: number }[]
  items: { menu_item: number; name: string; category: string; quantity: number; jain_quantity: number; revenue: number }[]
  categories: { name: string; quantity: number; revenue: number }[]
  staff: { user: number; name: string; orders: number; net: number; guests: number }[]
  collections: { method: string; label: string; bills: number; advances: number; refunds: number; net: number }[]
  cancellations: {
    orders: number
    kitchen_items: number
    kitchen_value: number
    items: { name: string; quantity: number; value: number }[]
  }
  reservations: {
    bookings: number
    guests: number
    seated: number
    upcoming: number
    cancelled: number
    no_show: number
    forfeited: number
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T00:00`).toLocaleDateString('en-IN', opts)

export function ReportsPage() {
  const filters = useUrlFilters()
  const query = new URLSearchParams()
  if (filters.from) query.set('date_from', filters.from)
  if (filters.to) query.set('date_to', filters.to)

  const report = useQuery({
    queryKey: ['reports', 'sales', query.toString()],
    queryFn: () => api<Report>(`/reports/sales/?${query}`),
  })

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">Sales count paid orders, on the day they were opened.</p>
        </div>
        <DateRangeFilter filters={filters} />
      </header>

      {report.isPending ? (
        <PageState>Loading…</PageState>
      ) : report.isError ? (
        <PageState error>{report.error.message || 'Could not load the report.'}</PageState>
      ) : (
        <ReportBody report={report.data} />
      )}
    </div>
  )
}

function ReportBody({ report }: { report: Report }) {
  const s = report.summary
  const collected = report.collections.reduce((sum, c) => sum + c.net, 0)

  return (
    <div className="grid gap-5">
      {/* ---------- headline numbers ---------- */}
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Sales"
          value={money(s.net)}
          hint={s.discounts ? `${money(s.gross)} before ${money(s.discounts)} discounts` : 'No discounts'}
        />
        <Stat
          label="Paid orders"
          value={String(s.orders)}
          hint={s.orders ? `Average bill ${money(Math.round(s.average_bill))}` : undefined}
        />
        <Stat
          label="Guests (dine-in)"
          value={String(s.guests)}
          hint={s.guests ? `${money(Math.round(s.per_guest))} per guest` : undefined}
        />
        <Stat
          label="Money received"
          value={money(collected)}
          hint="Bills and advances, less refunds"
        />
      </dl>
      {s.open_orders > 0 && (
        <p className="-mt-2 text-sm text-muted-foreground">
          {plural(s.open_orders, 'order')} from these dates {s.open_orders === 1 ? "isn't" : "aren't"} paid yet
          and {s.open_orders === 1 ? 'is' : 'are'} left out of sales.
        </p>
      )}

      {/* ---------- over time ---------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SalesOverTime report={report} />
        <Card title="Busy hours" subtitle="Paid orders by the hour they were opened">
          <BusyHours hours={report.by_hour} />
        </Card>
      </div>

      {/* ---------- what sold ---------- */}
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <TopItems items={report.items} />
        <div className="grid content-start gap-5">
          <Card title="Categories" subtitle="Item sales before bill discounts">
            {report.categories.length ? (
              <BarList
                rows={report.categories.map((c) => ({
                  key: c.name,
                  label: c.name,
                  value: c.revenue,
                  display: money(c.revenue),
                  detail: `${c.quantity} sold`,
                }))}
              />
            ) : (
              <Empty />
            )}
          </Card>
          <Card title="Dine-in and takeaway">
            {report.by_type.length ? (
              <BarList
                rows={report.by_type.map((t) => ({
                  key: t.type,
                  label: t.type === 'dine_in' ? 'Dine-in' : 'Takeaway',
                  value: t.net,
                  display: money(t.net),
                  detail: plural(t.orders, 'order'),
                }))}
              />
            ) : (
              <Empty />
            )}
          </Card>
        </div>
      </div>

      {/* ---------- money and people ---------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Collections rows={report.collections} total={collected} />
        <Card title="Staff" subtitle="Paid orders by the waiter who took them">
          {report.staff.length ? (
            <Table
              head={['', 'Orders', 'Guests', 'Sales']}
              rows={report.staff.map((p) => [p.name, p.orders, p.guests, money(p.net)])}
            />
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      {/* ---------- losses and bookings ---------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Cancellations and discounts">
          <dl className="grid grid-cols-3 gap-3">
            <Mini label="Orders cancelled" value={String(report.cancellations.orders)} />
            <Mini
              label="Cancelled after the kitchen had them"
              value={money(report.cancellations.kitchen_value)}
              hint={plural(report.cancellations.kitchen_items, 'item')}
            />
            <Mini
              label="Discounts given"
              value={money(s.discounts)}
              hint={`on ${plural(s.discounted_orders, 'bill')}`}
            />
          </dl>
          {report.cancellations.items.length > 0 && (
            <div className="mt-4 grid gap-2">
              <p className="text-xs font-medium text-muted-foreground">Most cancelled after cooking started</p>
              <Table
                head={['', 'Qty', 'Value']}
                rows={report.cancellations.items
                  .slice(0, 5)
                  .map((i) => [i.name, i.quantity, money(i.value)])}
              />
            </div>
          )}
        </Card>
        <Card title="Reservations" subtitle="Bookings for these dates">
          <dl className="grid grid-cols-3 gap-3">
            <Mini label="Bookings" value={String(report.reservations.bookings)} hint={`${report.reservations.guests} guests expected`} />
            <Mini label="Seated" value={String(report.reservations.seated)} hint={`${report.reservations.upcoming} still to come`} />
            <Mini
              label="Cancelled or no-show"
              value={String(report.reservations.cancelled + report.reservations.no_show)}
              hint={report.reservations.no_show ? `${report.reservations.no_show} no-show` : undefined}
            />
            <Mini label="Advances kept" value={money(report.reservations.forfeited)} hint="Forfeited on cancel" />
          </dl>
        </Card>
      </div>
    </div>
  )
}

// ---------- sections ----------

function SalesOverTime({ report }: { report: Report }) {
  const days = report.by_day
  if (days.length <= 1) {
    // One day: show the evening hour by hour instead of a single column.
    const columns = trimHours(report.by_hour).map(
      (h): Column => ({
        key: String(h.hour),
        axis: hourLabel(h.hour),
        title: `${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)}`,
        value: h.net,
        detail: plural(h.orders, 'order'),
      }),
    )
    return (
      <Card title="Sales by hour" subtitle={days[0] ? dayLabel(days[0].date, { weekday: 'long', day: 'numeric', month: 'long' }) : undefined}>
        {columns.some((c) => c.value) ? <ColumnChart label="Sales by hour" columns={columns} format={money} /> : <Empty />}
      </Card>
    )
  }
  const every = Math.ceil(days.length / 10)
  const columns = days.map(
    (d, i): Column => ({
      key: d.date,
      axis: i % every === 0 ? dayLabel(d.date, { day: 'numeric', month: 'short' }) : '',
      title: dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' }),
      value: d.net,
      detail: plural(d.orders, 'order'),
    }),
  )
  const best = days.reduce((a, b) => (b.net > a.net ? b : a))
  return (
    <Card
      title="Sales by day"
      subtitle={best.net ? `Best day ${dayLabel(best.date, { weekday: 'short', day: 'numeric', month: 'short' })}, ${money(best.net)}` : undefined}
    >
      {columns.some((c) => c.value) ? <ColumnChart label="Sales by day" columns={columns} format={money} /> : <Empty />}
    </Card>
  )
}

/** Hours from the first to the last with orders, padded a little; 11am–11pm when empty. */
function trimHours(hours: Report['by_hour']) {
  const busy = hours.filter((h) => h.orders > 0).map((h) => h.hour)
  const first = busy.length ? Math.max(Math.min(...busy) - 1, 0) : 11
  const last = busy.length ? Math.min(Math.max(...busy) + 1, 23) : 23
  return hours.filter((h) => h.hour >= first && h.hour <= last)
}

function BusyHours({ hours }: { hours: Report['by_hour'] }) {
  const columns = trimHours(hours).map(
    (h): Column => ({
      key: String(h.hour),
      axis: h.hour % 2 === 0 ? hourLabel(h.hour) : '',
      title: `${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)}`,
      value: h.orders,
      detail: money(h.net),
    }),
  )
  if (!columns.some((c) => c.value)) return <Empty />
  return <ColumnChart label="Orders by hour" columns={columns} format={(v) => plural(v, 'order')} />
}

function TopItems({ items }: { items: Report['items'] }) {
  const [sort, setSort] = useState<'revenue' | 'quantity'>('revenue')
  const [all, setAll] = useState(false)
  const sorted = [...items].sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name))
  const shown = all ? sorted : sorted.slice(0, 10)
  const max = Math.max(...items.map((i) => i[sort]), 0) || 1

  return (
    <Card
      title="Items sold"
      subtitle="Before bill discounts"
      action={
        <Pills
          label="Sort items by"
          value={sort}
          onChange={(v) => setSort(v as typeof sort)}
          options={[
            { value: 'revenue', label: 'Sales' },
            { value: 'quantity', label: 'Quantity' },
          ]}
        />
      }
    >
      {items.length === 0 ? (
        <Empty />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="w-8 pb-2 font-normal">#</th>
                <th className="pb-2 font-normal">Item</th>
                <th className="pb-2 text-right font-normal">Qty</th>
                <th className="pb-2 text-right font-normal">Sales</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((item, i) => (
                <tr key={item.menu_item}>
                  <td className="py-2 text-muted-foreground tabular-nums">{i + 1}</td>
                  <td className="py-2 pr-3">
                    <p className="font-medium">{item.name}</p>
                    <div className="mt-1 h-1.5 max-w-48 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-viz-1" style={{ width: `${(item[sort] / max) * 100}%` }} />
                    </div>
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {item.quantity}
                    {item.jain_quantity > 0 && (
                      <span className="block text-xs text-muted-foreground">{item.jain_quantity} Jain</span>
                    )}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">{money(item.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length > 10 && (
            <button
              onClick={() => setAll(!all)}
              className="mt-3 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {all ? 'Show top 10' : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  )
}

function Collections({ rows, total }: { rows: Report['collections']; total: number }) {
  const hasAdvances = rows.some((r) => r.advances || r.refunds)
  return (
    <Card title="Money received" subtitle="By payment method, on the day it was received">
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <>
          <BarList
            rows={rows.map((r) => ({
              key: r.method,
              label: r.label,
              value: Math.max(r.net, 0),
              display: money(r.net),
              detail: total > 0 ? `${Math.round((r.net / total) * 100)}%` : undefined,
            }))}
          />
          {hasAdvances && (
            <div className="mt-4">
              <Table
                head={['', 'Bills', 'Advances', 'Refunds', 'Total']}
                rows={rows.map((r) => [
                  r.label,
                  money(r.bills),
                  money(r.advances),
                  r.refunds ? `−${money(r.refunds)}` : money(0),
                  money(r.net),
                ])}
              />
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ---------- building blocks ----------

function Card(props: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-background p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{props.title}</h2>
          {props.subtitle && <p className="text-xs text-muted-foreground">{props.subtitle}</p>}
        </div>
        {props.action}
      </header>
      {props.children}
    </section>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border bg-background px-4 py-3.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
      {hint && <dd className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tracking-tight tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted-foreground">
          {head.map((h, i) => (
            <th key={i} className={cn('pb-2 font-normal', i === 0 ? 'text-left' : 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, i) => (
              <td
                key={i}
                className={cn('py-2', i === 0 ? 'pr-3 font-medium' : 'text-right tabular-nums', i === row.length - 1 && i > 0 && 'font-medium')}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Empty() {
  return <p className="py-6 text-center text-sm text-muted-foreground">Nothing for these dates.</p>
}
