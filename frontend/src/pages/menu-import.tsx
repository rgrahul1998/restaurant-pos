import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { api, download } from '@/lib/api'
import { money } from '@/lib/format'
import { cn } from '@/lib/utils'

interface ImportResult {
  saved: boolean
  created: number
  updated: number
  unchanged: number
  new: { categories: string[]; stations: string[]; courses: string[] }
  notes: string[]
  rows: {
    row: number
    name: string
    category: string
    price: string
    action: 'create' | 'update' | 'unchanged'
    changes: string[]
  }[]
  errors: { row: number; message: string }[]
}

const SHOWN = 60

/** Menu → Import: download the template (or today's menu), upload it, check, then import. */
export function MenuImport({ hasItems, onDone }: { hasItems: boolean; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(chosen: File, save: boolean) {
    setBusy(true)
    setError('')
    const body = new FormData()
    body.append('file', chosen)
    if (save) body.append('save', 'true')
    try {
      const res = await api<ImportResult>('/menu-items/import/', { method: 'POST', body })
      setResult(res)
      if (res.saved) {
        for (const key of [['menu-items'], ['categories'], ['courses'], ['stations']])
          queryClient.invalidateQueries({ queryKey: key })
      }
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : 'Could not read the file.')
    } finally {
      setBusy(false)
    }
  }

  function choose(chosen: File | null) {
    setFile(chosen)
    setResult(null)
    if (chosen) send(chosen, false)
  }

  const template = (query: string) => download(`/menu-items/template/${query}`)

  if (result?.saved)
    return (
      <div className="grid gap-5">
        <h2 className="pr-10 text-lg font-semibold tracking-tight">Menu imported</h2>
        <p className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          {summary(result)}
        </p>
        <Button size="lg" onClick={onDone}>
          Done
        </Button>
      </div>
    )

  const changing = result ? result.created + result.updated : 0
  const listed = result?.rows.filter((r) => r.action !== 'unchanged') ?? []

  return (
    <div className="grid gap-6">
      <div>
        <h2 className="pr-10 text-lg font-semibold tracking-tight">Import menu</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add or update dishes from a spreadsheet. Dishes are matched by name, and nothing is deleted.
        </p>
      </div>

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">1. Get the template</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" size="lg" onClick={() => template('')}>
            <Download /> Blank template
          </Button>
          <Button variant="outline" size="lg" disabled={!hasItems} onClick={() => template('?current=1')}>
            <Download /> Current menu
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Excel files, with a “How to fill” sheet. Use <b>Current menu</b> to change prices in bulk.
          Prefer CSV?{' '}
          <button className="underline" onClick={() => template('?type=csv')}>
            Blank CSV
          </button>
          {hasItems && (
            <>
              {' · '}
              <button className="underline" onClick={() => template('?type=csv&current=1')}>
                Current menu CSV
              </button>
            </>
          )}
        </p>
      </section>

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">2. Upload the filled file</h3>
        <label
          className={cn(
            'grid cursor-pointer place-items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-sm transition-colors hover:bg-muted/50',
            file && 'border-solid',
          )}
        >
          <FileSpreadsheet className="size-5 text-muted-foreground" />
          {file ? (
            <span className="font-medium break-all">{file.name}</span>
          ) : (
            <span className="text-muted-foreground">Choose an .xlsx or .csv file</span>
          )}
          {file && <span className="text-xs text-muted-foreground">Choose another</span>}
          <input
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="sr-only"
            onChange={(e) => {
              choose(e.target.files?.[0] ?? null)
              e.target.value = '' // the same file again, after fixing it, still triggers a check
            }}
          />
        </label>
        {busy && !result && <p className="text-sm text-muted-foreground">Checking…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>

      {result && (
        <section className="grid gap-3">
          <h3 className="text-sm font-medium">3. Check and import</h3>

          {result.errors.length > 0 ? (
            <div className="grid gap-2 rounded-lg bg-destructive/10 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium text-destructive">
                <AlertCircle className="size-4" />
                Fix {result.errors.length === 1 ? 'this' : `these ${result.errors.length}`} in the file
                and upload it again. Nothing has been imported.
              </p>
              <ul className="grid max-h-60 gap-1 overflow-y-auto">
                {result.errors.map((e, i) => (
                  <li key={i}>
                    <span className="text-muted-foreground">Row {e.row}:</span> {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm">{summary(result)}</p>
          )}

          {result.errors.length === 0 && result.notes.length > 0 && (
            <ul className="grid gap-1 rounded-lg bg-warning/10 p-3 text-sm">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          {result.errors.length === 0 && listed.length > 0 && (
            <ul className="divide-y rounded-lg border text-sm">
              {listed.slice(0, SHOWN).map((r) => (
                <li key={r.row} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.action === 'create' ? `${r.category} · ${money(r.price)}` : r.changes.join(' · ')}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-xs',
                      r.action === 'create' ? 'bg-success/10 text-success' : 'bg-muted',
                    )}
                  >
                    {r.action === 'create' ? 'New' : 'Update'}
                  </span>
                </li>
              ))}
              {listed.length > SHOWN && (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  and {listed.length - SHOWN} more
                </li>
              )}
            </ul>
          )}

          <Button
            size="lg"
            disabled={busy || result.errors.length > 0 || changing === 0}
            onClick={() => file && send(file, true)}
          >
            {busy
              ? 'Importing…'
              : result.errors.length > 0
                ? 'Import'
                : changing === 0
                  ? 'Nothing to change'
                  : `Import ${changing} ${changing === 1 ? 'dish' : 'dishes'}`}
          </Button>
        </section>
      )}
    </div>
  )
}

function summary(r: ImportResult) {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const parts = [
    r.created && `${plural(r.created, 'new dish', 'new dishes')}`,
    r.updated && `${plural(r.updated, 'dish', 'dishes')} updated`,
    r.unchanged && `${r.unchanged} unchanged`,
  ].filter(Boolean)
  const made = [
    r.new.categories.length && plural(r.new.categories.length, 'category', 'categories'),
    r.new.stations.length && plural(r.new.stations.length, 'kitchen station'),
    r.new.courses.length && plural(r.new.courses.length, 'course'),
  ].filter(Boolean)
  const also = made.length ? ` ${r.saved ? 'Also added' : 'Also adds'} ${made.join(', ')}.` : ''
  return `${parts.join(', ')}.${also}`
}
