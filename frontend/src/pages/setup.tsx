import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, FileArchive, Sparkles, Store } from 'lucide-react'
import { useState, type ComponentProps, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { homeFor } from '@/lib/nav'
import { useSetupNeeded } from '@/lib/setup'
import type { User } from '@/lib/types'
import { cn } from '@/lib/utils'

type Mode = 'blank' | 'demo' | 'restore'

const CHOICES: { mode: Mode; title: string; text: string; icon: typeof Store }[] = [
  {
    mode: 'blank',
    title: 'Start blank',
    text: 'Create your Admin account, then add your own menu, rooms, tables and staff.',
    icon: Store,
  },
  {
    mode: 'demo',
    title: 'Load demo data',
    text: 'A sample restaurant with menu, tables, staff, four weeks of sales, live orders and bookings. Good for trying things out.',
    icon: Sparkles,
  },
  {
    mode: 'restore',
    title: 'Restore a backup',
    text: 'Moving from another server? Upload a backup zip from Settings → Backup. Everyone keeps their login.',
    icon: FileArchive,
  },
]

export function SetupPage() {
  const status = useSetupNeeded()
  const [mode, setMode] = useState<Mode | null>(null)

  if (status.data && !status.data.needed) return <Navigate to="/login" replace />

  return (
    <div className="grid min-h-svh place-items-center bg-muted/40 p-4">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Set up your POS</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This server has no data yet. How would you like to start?
          </p>
        </div>

        {mode === null ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {CHOICES.map(({ mode, title, text, icon: Icon }) => (
              <button
                key={mode}
                onClick={() => setMode(mode)}
                className="group flex flex-col gap-3 rounded-xl bg-card p-5 text-left ring-1 ring-foreground/10 transition hover:ring-foreground/30"
              >
                <Icon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
                <span className="font-medium">{title}</span>
                <span className="text-sm text-muted-foreground">{text}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mx-auto max-w-sm rounded-xl bg-card p-6 ring-1 ring-foreground/10">
            <button
              onClick={() => setMode(null)}
              className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
            <h2 className="mb-4 font-medium">{CHOICES.find((c) => c.mode === mode)!.title}</h2>
            {mode === 'restore' ? <RestoreForm /> : <AccountForm demo={mode === 'demo'} />}
          </div>
        )}
      </div>
    </div>
  )
}

function AccountForm({ demo }: { demo: boolean }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    if (form.password !== form.confirm) return setError('The passwords do not match.')
    setBusy(true)
    setError('')
    try {
      const tokens = await post<{ access: string; refresh: string }>('/setup/', {
        mode: demo ? 'demo' : 'blank',
        restaurant_name: form.restaurant_name,
        full_name: form.full_name,
        username: form.username,
        password: form.password,
      })
      const auth = useAuth.getState()
      auth.setTokens(tokens.access, tokens.refresh)
      const me = await api<User>('/auth/me/')
      auth.setUser(me)
      queryClient.setQueryData(['setup'], { needed: false })
      navigate(homeFor(me.role), { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <Field label="Restaurant name" name="restaurant_name" placeholder={demo ? 'Saffron Table' : ''} />
      <Field label="Your name" name="full_name" autoComplete="name" />
      <Field label="Admin username" name="username" defaultValue="admin" required />
      <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} required />
      <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" required />
      {demo && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          Demo staff <b>manager</b>, <b>cashier</b>, <b>waiter</b>, <b>meena</b> and <b>kitchen</b> get
          the same password, so you can try every role.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>
        {busy ? (demo ? 'Loading demo data…' : 'Setting up…') : 'Create and sign in'}
      </Button>
    </form>
  )
}

function RestoreForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ rows: number; media_files: number; warnings: string[] } | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setError('')
    const body = new FormData()
    body.append('file', file)
    try {
      setDone(await api('/setup/restore/', { method: 'POST', body }))
      queryClient.setQueryData(['setup'], { needed: false })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed.')
    } finally {
      setBusy(false)
    }
  }

  if (done)
    return (
      <div className="grid gap-4">
        <p className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          Restored {done.rows.toLocaleString('en-IN')} records and {done.media_files} photos. Sign in
          with your usual username and password.
        </p>
        {done.warnings.map((w) => (
          <p key={w} className="text-xs text-muted-foreground">
            {w}
          </p>
        ))}
        <Button onClick={() => navigate('/login', { replace: true })}>Go to sign in</Button>
      </div>
    )

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <label
        className={cn(
          'grid cursor-pointer place-items-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center text-sm transition-colors hover:bg-muted/50',
          file && 'border-solid',
        )}
      >
        <FileArchive className="size-5 text-muted-foreground" />
        {file ? (
          <span className="font-medium break-all">{file.name}</span>
        ) : (
          <span className="text-muted-foreground">Choose a pos-backup-….zip</span>
        )}
        <input
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={!file || busy}>
        {busy ? 'Restoring…' : 'Restore'}
      </Button>
      {busy && (
        <p className="text-center text-xs text-muted-foreground">
          A few months of orders can take a minute. Keep this page open.
        </p>
      )}
    </form>
  )
}

function Field({ label, name, ...props }: { label: string; name: string } & ComponentProps<'input'>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} {...props} />
    </div>
  )
}
