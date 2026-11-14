import { useState } from 'react'

import { cn } from '@/lib/utils'

/** Round up to 1, 2 or 5 × a power of ten, so the axis lands on friendly numbers. */
function niceMax(value: number) {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= value)!
  return step * power
}

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 })

export interface Column {
  key: string
  /** Under the axis; empty to leave a gap when labels would crowd. */
  axis: string
  /** First line of the tooltip. */
  title: string
  value: number
  /** Extra tooltip line, e.g. "4 orders". */
  detail?: string
}

/**
 * One series as columns from a zero baseline, with a hover tooltip and a screen-reader table.
 * `format` writes values in the tooltip and table; the axis uses short numbers.
 */
export function ColumnChart(props: {
  label: string
  columns: Column[]
  format: (value: number) => string
  height?: number
}) {
  const [active, setActive] = useState<number | null>(null)
  const height = props.height ?? 176
  const max = niceMax(Math.max(...props.columns.map((c) => c.value)))
  const ticks = [max, max / 2, 0]
  const shown = active === null ? null : props.columns[active]

  return (
    <figure className="grid gap-2" aria-label={props.label}>
      <div className="grid grid-cols-[auto_1fr] gap-x-2">
        {/* y axis */}
        <div className="relative w-9 text-right text-[0.7rem] text-muted-foreground tabular-nums" style={{ height }}>
          {ticks.map((t, i) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${(i / 2) * 100}%` }}>
              {compact.format(t)}
            </span>
          ))}
        </div>

        {/* plot */}
        <div className="relative" style={{ height }} onMouseLeave={() => setActive(null)}>
          {ticks.map((t, i) => (
            <div
              key={t}
              aria-hidden
              className={cn('absolute inset-x-0 border-t', i === 2 ? 'border-border' : 'border-dashed border-border/70')}
              style={{ top: `${(i / 2) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-0.5">
            {props.columns.map((c, i) => (
              <div
                key={c.key}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                tabIndex={0}
                aria-label={`${c.title}: ${props.format(c.value)}`}
                className={cn(
                  'flex h-full min-w-0 flex-1 items-end justify-center rounded-sm outline-none',
                  active === i && 'bg-muted/70',
                )}
              >
                {c.value > 0 && (
                  <div
                    className="w-full max-w-6 rounded-t-[4px] bg-viz-1"
                    style={{ height: `${(c.value / max) * 100}%`, minHeight: 2 }}
                  />
                )}
              </div>
            ))}
          </div>

          {shown && (
            <div
              role="status"
              className="pointer-events-none absolute -top-2 z-10 w-max -translate-x-1/2 -translate-y-full rounded-lg border bg-background px-3 py-2 text-xs shadow-md"
              style={{
                left: `clamp(4rem, ${((active! + 0.5) / props.columns.length) * 100}%, calc(100% - 4rem))`,
              }}
            >
              <p className="text-muted-foreground">{shown.title}</p>
              <p className="font-medium tabular-nums">{props.format(shown.value)}</p>
              {shown.detail && <p className="text-muted-foreground">{shown.detail}</p>}
            </div>
          )}
        </div>

        {/* x axis */}
        <div />
        <div className="flex gap-0.5 pt-1.5 text-[0.7rem] text-muted-foreground">
          {props.columns.map((c) => (
            <span key={c.key} className="min-w-0 flex-1 truncate text-center">
              {c.axis}
            </span>
          ))}
        </div>
      </div>

      <table className="sr-only">
        <caption>{props.label}</caption>
        <tbody>
          {props.columns.map((c) => (
            <tr key={c.key}>
              <th scope="row">{c.title}</th>
              <td>{props.format(c.value)}</td>
              {c.detail && <td>{c.detail}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

/** Labelled rows, each with a thin bar sized against the largest value. */
export function BarList(props: {
  rows: { key: string; label: React.ReactNode; value: number; display: string; detail?: string }[]
}) {
  const max = Math.max(...props.rows.map((r) => r.value), 0) || 1
  return (
    <ul className="grid gap-3">
      {props.rows.map((r) => (
        <li key={r.key} className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 font-medium tabular-nums">
              {r.display}
              {r.detail && <span className="ml-2 font-normal text-muted-foreground">{r.detail}</span>}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-viz-1"
              style={{ width: `${Math.max((r.value / max) * 100, r.value > 0 ? 1 : 0)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
