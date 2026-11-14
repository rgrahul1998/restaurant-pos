import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** An on/off switch with its label, for yes/no settings in forms and lists. */
export function Switch(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  /** Show the label next to the switch; otherwise it is only read out by screen readers. */
  showLabel?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.showLabel ? undefined : props.label}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation()
        props.onChange(!props.checked)
      }}
      className="inline-flex shrink-0 items-center gap-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors',
          props.checked ? 'bg-foreground' : 'bg-input',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow-sm transition-transform',
            props.checked && 'translate-x-4',
          )}
        />
      </span>
      {props.showLabel && props.label}
    </button>
  )
}

/** A native select styled like the text inputs. */
export function Select<T extends string | number>(props: {
  label: string
  value: T | null
  onChange: (value: T | null) => void
  options: { value: T; label: string }[]
  /** Label for the empty choice; omit to require a value. */
  empty?: string
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value ?? ''}
      onChange={(e) => {
        const raw = e.target.value
        const match = props.options.find((o) => String(o.value) === raw)
        props.onChange(match ? match.value : null)
      }}
      className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {(props.empty !== undefined || props.value === null) && (
        <option value="">{props.empty ?? 'Choose…'}</option>
      )}
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export const textareaClass =
  'rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

/** Save, cancel and an optional two-step delete for side-sheet forms. */
export function FormFooter(props: {
  error: Error | null
  canSave: boolean
  busy: boolean
  saveLabel: string
  onCancel: () => void
  onDelete?: () => void
  deleteHint?: string
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="grid gap-3 border-t pt-5">
      {props.error && <p className="text-sm text-destructive">{props.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="flex-1" disabled={!props.canSave || props.busy}>
          {props.saveLabel}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {props.onDelete &&
        (confirming ? (
          <div className="grid gap-2 rounded-xl border border-destructive/30 p-3">
            <p className="text-sm">Delete for good?</p>
            {props.deleteHint && <p className="text-xs text-muted-foreground">{props.deleteHint}</p>}
            <div className="flex gap-2">
              <Button type="button" variant="destructive" disabled={props.busy} onClick={props.onDelete}>
                Yes, delete
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="w-fit text-sm text-muted-foreground hover:text-destructive"
          >
            Delete
          </button>
        ))}
    </div>
  )
}
