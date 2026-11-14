import { Input } from '@/components/ui/input'
import { dateKey, type Range, type useUrlFilters } from '@/hooks/use-url-filters'
import { cn } from '@/lib/utils'

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Pick dates' },
]

/** Today / Yesterday / … / Pick dates, with the two date inputs when picking. */
export function DateRangeFilter({ filters }: { filters: ReturnType<typeof useUrlFilters> }) {
  const { params, range, from, to, update } = filters
  return (
    <div className="grid gap-3">
      <Pills
        label="Dates"
        options={RANGES}
        value={range}
        onChange={(value) =>
          update(
            value === 'custom'
              ? { range: value, from: from ?? dateKey(new Date()), to: to ?? dateKey(new Date()) }
              : { range: value === 'today' ? null : value, from: null, to: null },
          )
        }
      />
      {range === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Input
            type="date"
            aria-label="From"
            className="w-auto"
            value={params.get('from') ?? ''}
            max={params.get('to') ?? undefined}
            onChange={(e) => update({ from: e.target.value })}
          />
          <span className="text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="To"
            className="w-auto"
            value={params.get('to') ?? ''}
            min={params.get('from') ?? undefined}
            onChange={(e) => update({ to: e.target.value })}
          />
        </div>
      )}
    </div>
  )
}

/** A row of single-choice pill buttons. */
export function Pills(props: {
  label: string
  options: readonly { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div role="group" aria-label={props.label} className="flex flex-wrap gap-1.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={cn(
            'h-8 rounded-full border px-3 text-sm transition-colors',
            props.value === o.value
              ? 'border-foreground bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
