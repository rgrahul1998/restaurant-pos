import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, DatabaseBackup, Download, Printer, Store, XCircle } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Navigate, useParams } from 'react-router-dom'

import { Pills } from '@/components/date-range'
import { Switch } from '@/components/fields'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError, api, download, patch, post } from '@/lib/api'
import { canPrintHere, printRaw } from '@/lib/device-printer'
import { time } from '@/lib/format'
import { cn } from '@/lib/utils'

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

// Each entry is one tab on the left; add a section here and it gets a tab and a URL.
const SECTIONS = [
  { path: 'restaurant', label: 'Restaurant details', icon: Store, page: RestaurantSettings },
  { path: 'printing', label: 'Printing', icon: Printer, page: PrintingSettings },
  { path: 'backup', label: 'Backup', icon: DatabaseBackup, page: BackupSettings },
] as const

export function SettingsPage() {
  const { section } = useParams()
  const current = SECTIONS.find((s) => s.path === section)
  if (!current) return <Navigate to={`/settings/${SECTIONS[0].path}`} replace />
  const Page = current.page

  return (
    <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)] md:items-start lg:gap-10">
      <aside className="grid gap-3 md:sticky md:top-20">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={`/settings/${path}`}
              className={({ isActive }) =>
                cn(
                  'flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors',
                  isActive
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="grid min-w-0 gap-6">
        <Page />
      </div>
    </div>
  )
}

// ---------- restaurant details ----------

interface Restaurant {
  name: string
  legal_name: string
  address_line1: string
  address_line2: string
  city: string
  state: string
  pincode: string
  phone: string
  email: string
  gstin: string
  fssai: string
  bill_footer: string
}

const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
]

function RestaurantSettings() {
  const queryClient = useQueryClient()
  const saved = useQuery({
    queryKey: ['settings', 'restaurant'],
    queryFn: () => api<Restaurant>('/settings/restaurant/'),
  })
  const [draft, setDraft] = useState<Restaurant | null>(null)
  const [done, setDone] = useState(false)
  const save = useMutation({
    mutationFn: (body: Restaurant) => patch<Restaurant>('/settings/restaurant/', body),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['settings', 'restaurant'], fresh)
      setDraft(null)
      setDone(true)
    },
  })

  if (saved.isPending) return <Section title="Restaurant details"><p className="text-sm text-muted-foreground">Loading…</p></Section>
  if (saved.isError) return <Section title="Restaurant details"><p className="text-sm text-destructive">{saved.error.message}</p></Section>

  const value = draft ?? saved.data
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved.data)
  const errors = (save.error instanceof ApiError && typeof save.error.data === 'object' ? save.error.data : {}) as Record<string, string[]>
  const set = (field: keyof Restaurant) => (e: { target: { value: string } }) => {
    setDraft({ ...value, [field]: e.target.value })
    setDone(false)
  }
  const field = (name: keyof Restaurant, label: string, props: React.ComponentProps<'input'> & { hint?: string } = {}) => {
    const { hint, ...rest } = props
    return (
      <label className={cn('grid content-start gap-1.5', rest.className)}>
        <span className="text-sm font-medium">{label}</span>
        <Input value={value[name]} onChange={set(name)} aria-invalid={!!errors[name]} {...rest} className={undefined} />
        {errors[name] ? (
          <span className="text-xs text-destructive">{errors[name][0]}</span>
        ) : (
          hint && <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </label>
    )
  }

  return (
    <form
      className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(value)
      }}
    >
      <div className="grid gap-6">
      <Section title="Restaurant" description="Printed at the top of every bill.">
        <div className="grid gap-4 sm:grid-cols-2">
          {field('name', 'Restaurant name', { required: true, maxLength: 120 })}
          {field('legal_name', 'Legal / registered name', { maxLength: 120, hint: 'If different, e.g. “A unit of … Pvt Ltd”.' })}
        </div>
      </Section>

      <Section title="Address and contact">
        <div className="grid gap-4 sm:grid-cols-2">
          {field('address_line1', 'Address line 1', { maxLength: 120, className: 'sm:col-span-2' })}
          {field('address_line2', 'Address line 2', { maxLength: 120, className: 'sm:col-span-2' })}
          {field('city', 'City', { maxLength: 80 })}
          {field('state', 'State', { maxLength: 60, list: 'indian-states' })}
          {field('pincode', 'PIN code', { inputMode: 'numeric', maxLength: 6 })}
          {field('phone', 'Phone', { type: 'tel', maxLength: 40 })}
          {field('email', 'Email', { type: 'email', className: 'sm:col-span-2' })}
        </div>
        <datalist id="indian-states">
          {STATES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Section>

      <Section title="Registration" description="Shown on the bill when filled in.">
        <div className="grid gap-4 sm:grid-cols-2">
          {field('gstin', 'GSTIN', { maxLength: 20, placeholder: '27ABCDE1234F1Z5', hint: '15 characters.' })}
          {field('fssai', 'FSSAI licence number', { inputMode: 'numeric', maxLength: 20, hint: '14 digits.' })}
        </div>
        <p className="text-xs text-muted-foreground">
          The POS doesn’t calculate GST: bills show the GSTIN but no tax lines.
        </p>
      </Section>

      <Section title="Bill footer">
        {field('bill_footer', 'Message at the bottom of the bill', { maxLength: 120, placeholder: 'Thank You. Visit Again.', hint: 'Leave empty for none.' })}
      </Section>


        <div className="sticky bottom-0 flex items-center justify-end gap-3 rounded-2xl border bg-background/95 px-4 py-3 shadow-sm">
          {done && !dirty && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-emerald-600" /> Saved
            </span>
          )}
          {save.error && !(save.error instanceof ApiError && save.error.status === 400) && (
            <span className="text-sm text-destructive">{save.error.message}</span>
          )}
          {dirty && (
            <Button type="button" variant="ghost" size="lg" onClick={() => { setDraft(null); save.reset() }}>
              Discard
            </Button>
          )}
          <Button type="submit" size="lg" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      <aside className="grid gap-3 xl:sticky xl:top-20">
        <h2 className="text-sm font-medium">Bill preview</h2>
        <BillPreview r={value} />
        <p className="text-center text-xs text-muted-foreground">How the top and bottom of a printed bill will read.</p>
      </aside>
    </form>
  )
}

/** Roughly what the thermal printer prints (services.company_data + ticket.build_bill). */
function BillPreview({ r }: { r: Restaurant }) {
  const cityLine = [[r.city, r.pincode].filter(Boolean).join(' '), r.state].filter(Boolean).join(', ')
  const lines = [
    r.legal_name,
    r.address_line1,
    r.address_line2,
    cityLine,
    r.phone && `Phone: ${r.phone}`,
    r.email,
    r.gstin && `GSTIN: ${r.gstin.replace(/\s/g, '').toUpperCase()}`,
    r.fssai && `FSSAI Lic. No: ${r.fssai.replace(/\s/g, '')}`,
  ].filter(Boolean)
  return (
    <div className="mx-auto w-full max-w-xs rounded-lg border bg-white p-4 text-center font-mono text-xs leading-relaxed text-neutral-900 shadow-sm">
      <div className="text-sm font-bold">{r.name || 'Restaurant'}</div>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      <div className="my-2 border-t border-dashed border-neutral-400" />
      <div className="text-neutral-400">… items and totals …</div>
      <div className="my-2 border-t border-dashed border-neutral-400" />
      {r.bill_footer && <div>{r.bill_footer}</div>}
    </div>
  )
}

// ---------- printing ----------

interface PrintSettings {
  kot_printer_host: string
  bill_printer_host: string
  port: number
  width: 48 | 32
}

const WIDTHS = [
  { value: '48', label: '80 mm' },
  { value: '32', label: '58 mm' },
] as const

function PrintingSettings() {
  const queryClient = useQueryClient()
  const saved = useQuery({
    queryKey: ['settings', 'printing'],
    queryFn: () => api<PrintSettings>('/settings/printing/'),
  })
  const [draft, setDraft] = useState<PrintSettings | null>(null)
  const [done, setDone] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const save = useMutation({
    mutationFn: (body: PrintSettings) => patch<PrintSettings>('/settings/printing/', body),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['settings', 'printing'], fresh)
      setDraft(null)
      setDone(true)
    },
  })
  const test = useMutation({
    mutationFn: async (host: string) => {
      const query = new URLSearchParams({ printer: host, width: String(value.width) })
      const { ticket } = await api<{ ticket: string }>(`/printing/test-ticket/?${query}`)
      await printRaw(host, value.port, ticket)
    },
    onSuccess: (_, host) => setTestResult({ ok: true, text: `Test page sent to ${host}.` }),
    onError: (error, host) => setTestResult({ ok: false, text: `${host}: ${error.message}` }),
  })

  if (saved.isPending) return <Section title="Printing"><p className="text-sm text-muted-foreground">Loading…</p></Section>
  if (saved.isError) return <Section title="Printing"><p className="text-sm text-destructive">{saved.error.message}</p></Section>

  const value = draft ?? saved.data
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved.data)
  const errors = (save.error instanceof ApiError && typeof save.error.data === 'object' ? save.error.data : {}) as Record<string, string[]>
  const update = (changes: Partial<PrintSettings>) => {
    setDraft({ ...value, ...changes })
    setDone(false)
  }
  const hostField = (name: 'kot_printer_host' | 'bill_printer_host', label: string, hint: string) => (
    <label className="grid content-start gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <Input
        value={value[name]}
        onChange={(e) => update({ [name]: e.target.value })}
        inputMode="decimal"
        placeholder="192.168.1.50"
        maxLength={100}
        aria-invalid={!!errors[name]}
        className="h-10 tabular-nums"
      />
      {errors[name] ? (
        <span className="text-xs text-destructive">{errors[name][0]}</span>
      ) : (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  )
  const testHosts = [...new Set([value.kot_printer_host, value.bill_printer_host].map((h) => h.trim()).filter(Boolean))]

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(value)
      }}
    >
      <Section
        title="Network printer"
        description="Tablets running the POS app print KOTs and bills straight to this printer over WiFi, without the laptop. Leave it empty to print only from the laptop's Printer page."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {hostField('kot_printer_host', 'KOT printer IP', 'From the printer\'s self-test slip.')}
          {hostField('bill_printer_host', 'Bill printer IP', 'Leave empty to print bills on the KOT printer.')}
          <label className="grid content-start gap-1.5">
            <span className="text-sm font-medium">Port</span>
            <Input
              value={value.port}
              onChange={(e) => update({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
              inputMode="numeric"
              maxLength={5}
              aria-invalid={!!errors.port}
              className="h-10 tabular-nums"
            />
            <span className={cn('text-xs', errors.port ? 'text-destructive' : 'text-muted-foreground')}>
              {errors.port?.[0] ?? 'Almost always 9100.'}
            </span>
          </label>
          <div className="grid content-start gap-1.5">
            <span className="text-sm font-medium">Paper width</span>
            <Pills
              label="Paper width"
              options={WIDTHS}
              value={String(value.width)}
              onChange={(w) => update({ width: Number(w) as 48 | 32 })}
            />
          </div>
        </div>
      </Section>

      {testHosts.length > 0 && (
        <Section
          title="Test print"
          description={
            canPrintHere
              ? 'Prints a test page from this tablet, using the settings above.'
              : 'Open Settings in the POS app on a tablet to print a test page. A browser can\'t reach the printer.'
          }
        >
          {canPrintHere && (
            <div className="flex flex-wrap items-center gap-2">
              {testHosts.map((host) => (
                <Button key={host} type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate(host)}>
                  Test {host}
                </Button>
              ))}
              {testResult && (
                <span className={cn('text-sm', testResult.ok ? 'text-muted-foreground' : 'text-destructive')}>{testResult.text}</span>
              )}
            </div>
          )}
        </Section>
      )}

      <div className="sticky bottom-0 flex items-center justify-end gap-3 rounded-2xl border bg-background/95 px-4 py-3 shadow-sm">
        {done && !dirty && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" /> Saved
          </span>
        )}
        {save.error && !(save.error instanceof ApiError && save.error.status === 400) && (
          <span className="text-sm text-destructive">{save.error.message}</span>
        )}
        {dirty && (
          <Button type="button" variant="ghost" size="lg" onClick={() => { setDraft(null); save.reset() }}>
            Discard
          </Button>
        )}
        <Button type="submit" size="lg" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
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
    <div className="grid items-start gap-6 2xl:grid-cols-2">
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
    </div>
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
          {props.description && <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">{props.description}</p>}
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
