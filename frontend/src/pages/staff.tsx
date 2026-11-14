import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search } from 'lucide-react'
import { useState } from 'react'

import { FormFooter, Switch } from '@/components/fields'
import { PageState } from '@/components/page-state'
import { Chips, Field, Sheet } from '@/components/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiAll, patch, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { Role, User } from '@/lib/types'
import { cn } from '@/lib/utils'

const ROLES: { value: Role; label: string; does: string }[] = [
  { value: 'admin', label: 'Admin', does: 'Everything, including staff accounts and the admin site.' },
  { value: 'manager', label: 'Manager', does: 'Runs the floor and menu; can cancel sent items.' },
  { value: 'cashier', label: 'Cashier', does: 'Takes orders, bills, payments and reservations.' },
  { value: 'waiter', label: 'Waiter', does: 'Takes orders and sends them to the kitchen.' },
  { value: 'kitchen', label: 'Kitchen', does: 'Sees and advances kitchen tickets.' },
]
const roleLabel = (role: Role) => ROLES.find((r) => r.value === role)!.label

const fullName = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username
const initials = (u: User) =>
  (u.first_name || u.last_name
    ? `${u.first_name[0] ?? ''}${u.last_name[0] ?? ''}`
    : u.username.slice(0, 2)
  ).toUpperCase()

type Panel = { user?: User }

export function StaffPage() {
  const me = useAuth((s) => s.user)!
  const [panel, setPanel] = useState<Panel | null>(null)
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<Role | 'all'>('all')
  const [showInactive, setShowInactive] = useState(false)

  const users = useQuery({ queryKey: ['users'], queryFn: () => apiAll<User>('/users/') })

  let body: React.ReactNode
  if (users.isPending) body = <PageState>Loading staff…</PageState>
  else if (users.isError) body = <PageState error>Could not load staff.</PageState>
  else {
    const query = search.trim().toLowerCase()
    const inactive = users.data.filter((u) => !u.is_active).length
    const visible = users.data
      .filter((u) => showInactive || u.is_active)
      .filter((u) => role === 'all' || u.role === role)
      .filter((u) => !query || `${fullName(u)} ${u.username} ${u.phone}`.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          Number(b.is_active) - Number(a.is_active) ||
          ROLES.findIndex((r) => r.value === a.role) - ROLES.findIndex((r) => r.value === b.role) ||
          fullName(a).localeCompare(fullName(b)),
      )

    body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {[{ value: 'all' as const, label: 'Everyone' }, ...ROLES].map((r) => {
            const count =
              r.value === 'all'
                ? users.data.filter((u) => showInactive || u.is_active).length
                : users.data.filter((u) => u.role === r.value && (showInactive || u.is_active)).length
            return (
              <button
                key={r.value}
                onClick={() => setRole(r.value)}
                className={cn(
                  'shrink-0 rounded-full border px-3.5 py-1 text-sm transition-colors',
                  role === r.value
                    ? 'border-foreground bg-foreground text-background'
                    : 'bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                {r.label} <span className="opacity-60">{count}</span>
              </button>
            )
          })}
          {inactive > 0 && (
            <div className="ml-auto text-muted-foreground">
              <Switch
                showLabel
                label={`Show deactivated (${inactive})`}
                checked={showInactive}
                onChange={setShowInactive}
              />
            </div>
          )}
        </div>

        {visible.length === 0 ? (
          <PageState>{query ? 'Nobody matches.' : 'No staff here.'}</PageState>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
            {visible.map((u) => (
              <li key={u.id}>
                <button
                  onClick={() => setPanel({ user: u })}
                  className="flex h-full w-full items-center gap-3 rounded-2xl border bg-background p-4 text-left transition-colors hover:border-foreground/30"
                >
                  <span
                    className={cn(
                      'grid size-10 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium',
                      !u.is_active && 'opacity-50',
                    )}
                  >
                    {initials(u)}
                  </span>
                  <div className={cn('min-w-0 flex-1', !u.is_active && 'opacity-50')}>
                    <p className="truncate font-medium">
                      {fullName(u)}
                      {u.id === me.id && <span className="ml-1.5 font-normal text-muted-foreground">(you)</span>}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {[fullName(u) !== u.username && u.username, u.phone].filter(Boolean).join(' · ') || 'No name or phone yet'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {roleLabel(u.role)}
                      {!u.is_active && ' · Deactivated'}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold tracking-tight">Staff</h1>
        <div className="relative order-last w-full sm:order-none sm:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, username or phone"
            aria-label="Search staff"
            className="h-9 rounded-xl bg-background pl-10"
          />
        </div>
        <Button size="lg" onClick={() => setPanel({})}>
          <Plus /> Add staff
        </Button>
      </header>
      {body}
      {panel && (
        <Sheet onClose={() => setPanel(null)}>
          <StaffForm key={panel.user?.id ?? 'new'} user={panel.user} me={me} onDone={() => setPanel(null)} />
        </Sheet>
      )}
    </div>
  )
}

function StaffForm(props: { user?: User; me: User; onDone: () => void }) {
  const editing = props.user
  const self = editing?.id === props.me.id
  const queryClient = useQueryClient()
  const setMe = useAuth((s) => s.setUser)

  const [form, setForm] = useState({
    first_name: editing?.first_name ?? '',
    last_name: editing?.last_name ?? '',
    username: editing?.username ?? '',
    phone: editing?.phone ?? '',
    role: editing?.role ?? ('waiter' as Role),
    is_active: editing?.is_active ?? true,
  })
  const [password, setPassword] = useState('')
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        username: form.username.trim(),
        phone: form.phone.trim(),
        ...(password ? { password } : {}),
      }
      return editing ? patch<User>(`/users/${editing.id}/`, body) : post<User>('/users/', body)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      if (saved.id === props.me.id) setMe(saved)
      props.onDone()
    },
  })

  const passwordOk = editing ? password === '' || password.length >= 8 : password.length >= 8
  const ready = form.username.trim() && passwordOk

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) save.mutate()
      }}
    >
      <h2 className="pr-10 text-lg font-semibold tracking-tight">
        {editing ? fullName(editing) : 'Add staff'}
      </h2>
      <div className="grid gap-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input autoFocus={!editing} value={form.first_name} onChange={(e) => set('first_name', e.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={form.last_name} onChange={(e) => set('last_name', e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username" hint="Used to log in.">
            <Input
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={form.username}
              onChange={(e) => set('username', e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <Input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
        </div>

        <div className="grid gap-2">
          <span className="text-sm font-medium">Role</span>
          {self ? (
            <p className="text-sm text-muted-foreground">
              {roleLabel(form.role)}. You can't change your own role.
            </p>
          ) : (
            <>
              <Chips options={ROLES} value={form.role} onChange={(v) => set('role', v)} />
              <p className="text-xs text-muted-foreground">{ROLES.find((r) => r.value === form.role)!.does}</p>
            </>
          )}
        </div>

        <Field
          label={editing ? 'New password' : 'Password'}
          hint={editing ? 'Leave blank to keep the current password. At least 8 characters.' : 'At least 8 characters.'}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={password !== '' && password.length < 8}
          />
        </Field>

        {editing && !self && (
          <div className="grid gap-1.5">
            <Switch showLabel label="Can log in" checked={form.is_active} onChange={(v) => set('is_active', v)} />
            <p className="text-xs text-muted-foreground">
              Switch off when someone leaves. Their past orders and payments keep their name.
            </p>
          </div>
        )}
      </div>

      <FormFooter
        error={save.error}
        canSave={Boolean(ready)}
        busy={save.isPending}
        saveLabel={editing ? 'Save changes' : 'Add staff'}
        onCancel={props.onDone}
      />
    </form>
  )
}
