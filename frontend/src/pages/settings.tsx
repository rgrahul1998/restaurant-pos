import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Download, XCircle } from 'lucide-react'
import { useState } from 'react'

import { Pills } from '@/components/date-range'
import { Switch } from '@/components/fields'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, download, patch, post } from '@/lib/api'
import { time } from '@/lib/format'

interface BackupState {
  enabled: boolean
  interval_hours: number
  keep_days: number
  interval_choices: number[]
  last_run_at: string | null
  last_ok: boolean
  last_error: string
  next_run_at: string | null
  /** A backup is due now; the worker picks it up within a minute. */
  due: boolean
  /** When the backup worker last checked in; null if it isn't running. */
  worker_seen_at: string | null
  folder: string
  files: { name: string; size: number; created_at: string }[]
  total_bytes: number
}

const size = (bytes: number) =>
  bytes === 0 ? "0 KB" :
  bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`

/** "today 2:05 pm", "yesterday 11:40 pm", "12 Nov 9:00 am". */
function when(iso: string) {
  const d = new Date(iso)
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000,
  )
  const day =
    days === 0 ? 'today' : days === 1 ? 'yesterday' : days === -1 ? 'tomorrow' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  return `${day} ${time(iso)}`
}

const hours = (h: number) => (h === 1 ? 'hour' : `${h} hours`)

export function SettingsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      <BackupSettings />
    </div>
  )
}

// ---------- backup ----------

function BackupSettings() {
  const queryClient = useQueryClient()
  const state = useQuery({
    queryKey: ['settings', 'backup'],
    queryFn: () => api<BackupState>('/settings/backup/'),
    refetchInterval: 30_000, // the worker may finish a backup while the page is open
  })
  const set = (fresh: BackupState) => queryClient.setQueryData(['settings', 'backup'], fresh)

  const save = useMutation({
    mutationFn: (body: Partial<Pick<BackupState, 'enabled' | 'interval_hours' | 'keep_days'>>) =>
      patch<BackupState>('/settings/backup/', body),
    onSuccess: set,
  })
  const runNow = useMutation({
    mutationFn: () => post('/settings/backup/run/'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'backup'] }),
  })
  const downloadFresh = useMutation({ mutationFn: () => download('/backup/') })
  const downloadStored = useMutation({
    mutationFn: (name: string) => download(`/settings/backup/files/${encodeURIComponent(name)}/`),
  })

  if (state.isPending) return <Section title="Backup"><p className="text-sm text-muted-foreground">Loading…</p></Section>
  if (state.isError) return <Section title="Backup"><p className="text-sm text-destructive">{state.error.message}</p></Section>
  const s = state.data

  return (
    <>
      <Section
        title="Automatic backups"
        description="The server saves a full backup on a schedule and deletes old ones."
      >
        <Status state={s} />

        <div className="grid gap-5 border-t pt-5">
          <Switch
            showLabel
            label="Back up automatically"
            checked={s.enabled}
            disabled={save.isPending}
            onChange={(enabled) => save.mutate({ enabled })}
          />
          <fieldset disabled={!s.enabled || save.isPending} className="grid gap-5 disabled:opacity-50">
            <div className="grid gap-2">
              <span className="text-sm font-medium">How often</span>
              <Pills
                label="How often"
                value={String(s.interval_hours)}
                onChange={(v) => save.mutate({ interval_hours: Number(v) })}
                options={s.interval_choices.map((h) => ({ value: String(h), label: h === 24 ? 'Daily' : `${h} h` }))}
              />
            </div>
            <KeepDays
              key={s.keep_days}
              value={s.keep_days}
              onSave={(keep_days) => save.mutate({ keep_days })}
            />
          </fieldset>
          {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
        </div>
      </Section>

      <Section
        title="Backups on the server"
        description={`${s.files.length} ${s.files.length === 1 ? 'file' : 'files'}, ${size(s.total_bytes)} in ${s.folder}`}
        action={
          <Button variant="outline" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
            {runNow.isPending ? 'Backing up…' : 'Back up now'}
          </Button>
        }
      >
        {runNow.error && <p className="text-sm text-destructive">{runNow.error.message}</p>}
        {s.files.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No backups on the server yet.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {s.files.map((f) => (
              <li key={f.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium first-letter:uppercase">{when(f.created_at)}</span>
                  <span className="ml-2 truncate text-muted-foreground">{f.name}</span>
                </span>
                <span className="text-muted-foreground tabular-nums">{size(f.size)}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Download ${f.name}`}
                  disabled={downloadStored.isPending}
                  onClick={() => downloadStored.mutate(f.name)}
                >
                  <Download />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {downloadStored.error && <p className="text-sm text-destructive">{downloadStored.error.message}</p>}
        <p className="text-xs text-muted-foreground">
          These sit on the same machine as the database. For real safety, have that folder copied
          somewhere else too (another disk, a NAS or cloud storage), or download one now and then.
        </p>
      </Section>

      <Section
        title="Download a backup"
        description="A fresh backup of everything, saved to this computer: data, menu photos, staff accounts and change history."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={downloadFresh.isPending} onClick={() => downloadFresh.mutate()}>
            <Download /> {downloadFresh.isPending ? 'Preparing…' : 'Download backup'}
          </Button>
          <p className="text-sm text-muted-foreground" role="status">
            {downloadFresh.isSuccess
              ? `Saved ${downloadFresh.data}. It holds staff passwords and customer phone numbers; keep it safe.`
              : downloadFresh.isError
                ? <span className="text-destructive">{downloadFresh.error.message}</span>
                : 'Safe to run during service.'}
          </p>
        </div>
        <details className="group text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Moving to a new server
          </summary>
          <ol className="mt-3 grid list-decimal gap-3 pl-5 marker:text-muted-foreground">
            <li>
              Set the POS up on the new server as in the README, up to and including <Mono>migrate</Mono>.
              Don't run <Mono>seed_demo</Mono>. Use the same version of the POS, or newer.
            </li>
            <li className="space-y-2">
              <p>Copy the backup file there and, in the backend folder, run:</p>
              <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
                uv run python manage.py restore_backup pos-backup-….zip
              </pre>
            </li>
            <li>Everyone logs in with the same username and password. Order numbers carry on.</li>
          </ol>
          <p className="mt-3 text-muted-foreground">
            Not in the backup: the server's <Mono>.env</Mono> and the QZ Tray certificate files. Copy
            those yourself.
          </p>
        </details>
      </Section>
    </>
  )
}

function Status({ state: s }: { state: BackupState }) {
  const workerDown = s.enabled && !s.worker_seen_at
  return (
    <div className="grid gap-3">
      {workerDown && (
        <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="grid gap-1.5">
            <p className="font-medium">The backup worker isn't running, so nothing is being backed up.</p>
            <p>
              Start it on the server, next to the web server, and keep it running:{' '}
              <Mono>uv run python manage.py backup_worker</Mono>
            </p>
          </div>
        </div>
      )}
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Schedule</dt>
          <dd className="text-sm font-medium">
            {s.enabled ? `Every ${hours(s.interval_hours)}, kept ${s.keep_days} days` : 'Off'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last backup</dt>
          <dd className="flex items-center gap-1.5 text-sm font-medium">
            {s.last_run_at ? (
              <>
                {s.last_ok ? (
                  <CheckCircle2 className="size-4 text-emerald-600" aria-label="Succeeded" />
                ) : (
                  <XCircle className="size-4 text-destructive" aria-label="Failed" />
                )}
                <span className="first-letter:uppercase">{when(s.last_run_at)}</span>
                {!s.last_ok && <span className="font-normal text-destructive">failed</span>}
              </>
            ) : (
              'None yet'
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Next backup</dt>
          <dd className="text-sm font-medium first-letter:uppercase">
            {!s.next_run_at
              ? '—'
              : workerDown
                ? 'When the worker starts'
                : s.due
                  ? 'Within a minute'
                  : when(s.next_run_at)}
          </dd>
        </div>
      </dl>
      {s.last_run_at && !s.last_ok && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{s.last_error}</p>
      )}
    </div>
  )
}

function KeepDays(props: { value: number; onSave: (days: number) => void }) {
  const [days, setDays] = useState(String(props.value))
  const n = Number(days)
  const valid = Number.isInteger(n) && n >= 1 && n <= 90
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && n !== props.value) props.onSave(n)
      }}
    >
      <label htmlFor="keep-days" className="text-sm font-medium">
        Keep backups for
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="keep-days"
          type="number"
          min={1}
          max={90}
          className="w-20"
          value={days}
          aria-invalid={!valid}
          onChange={(e) => setDays(e.target.value)}
        />
        <span className="text-sm text-muted-foreground">days</span>
        {valid && n !== props.value && (
          <Button type="submit" size="sm">
            Save
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        1 to 90. Older backups are deleted, but the newest one is always kept.
      </p>
    </form>
  )
}

function Section(props: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-5 rounded-2xl border bg-background p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="font-medium">{props.title}</h2>
          {props.description && <p className="text-sm break-all text-muted-foreground">{props.description}</p>}
        </div>
        {props.action}
      </header>
      {props.children}
    </section>
  )
}

function Mono({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
}
