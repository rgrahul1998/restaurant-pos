import { X } from 'lucide-react'
import { useEffect } from 'react'

import { cn } from '@/lib/utils'

/** A panel that slides in from the right, over the page. Escape or a click outside closes it. */
export function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  // The calendar behind must not scroll while the panel is open (a swipe on a phone would).
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button aria-label="Close" className="absolute inset-0 bg-foreground/20" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto overscroll-contain bg-background p-6 shadow-xl">
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute top-4 right-4 grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>
        {children}
      </aside>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function Chips<T extends string>(props: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => props.onChange(o.value)}
          className={cn(
            'h-8 rounded-full border px-3 text-sm transition-colors',
            props.value === o.value ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
