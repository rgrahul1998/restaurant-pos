import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Plus, Search, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { FormFooter, Select, Switch, textareaClass } from '@/components/fields'
import { PageState } from '@/components/page-state'
import { Chips, Field, Sheet } from '@/components/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiAll, patch, post, remove, sendForm } from '@/lib/api'
import { money } from '@/lib/format'
import type { Category, Course, MenuItem, Station } from '@/lib/types'
import { MenuImport } from '@/pages/menu-import'
import { cn } from '@/lib/utils'

type Tab = 'items' | 'categories' | 'courses' | 'stations'

const TABS: { value: Tab; label: string; add: string }[] = [
  { value: 'items', label: 'Items', add: 'New item' },
  { value: 'categories', label: 'Categories', add: 'New category' },
  { value: 'courses', label: 'Courses', add: 'New course' },
  { value: 'stations', label: 'Kitchen stations', add: 'New station' },
]

type Panel =
  | { kind: 'item'; item?: MenuItem; category?: number }
  | { kind: 'category'; category?: Category }
  | { kind: 'course'; course?: Course }
  | { kind: 'station'; station?: Station }
  | { kind: 'import' }

// Keys are shared with the order and kitchen screens, so edits show up there too.
const KEYS = {
  items: ['menu-items'],
  categories: ['categories', 'all'],
  courses: ['courses'],
  stations: ['stations', 'all'],
}

export function MenuPage() {
  const [tab, setTab] = useState<Tab>('items')
  const [panel, setPanel] = useState<Panel | null>(null)

  const items = useQuery({ queryKey: KEYS.items, queryFn: () => apiAll<MenuItem>('/menu-items/') })
  const categories = useQuery({ queryKey: KEYS.categories, queryFn: () => apiAll<Category>('/categories/') })
  const courses = useQuery({ queryKey: KEYS.courses, queryFn: () => apiAll<Course>('/courses/') })
  const stations = useQuery({ queryKey: KEYS.stations, queryFn: () => apiAll<Station>('/stations/') })

  const queries = [items, categories, courses, stations]
  const close = () => setPanel(null)

  const add = () =>
    setPanel(
      tab === 'items'
        ? { kind: 'item' }
        : tab === 'categories'
          ? { kind: 'category' }
          : tab === 'courses'
            ? { kind: 'course' }
            : { kind: 'station' },
    )

  let body: React.ReactNode
  if (queries.some((q) => q.isPending)) body = <PageState>Loading menu…</PageState>
  else if (queries.some((q) => q.isError)) body = <PageState error>Could not load the menu.</PageState>
  else {
    const data = {
      items: items.data!,
      categories: categories.data!,
      courses: courses.data!,
      stations: stations.data!,
    }
    body =
      tab === 'items' ? (
        <ItemsTab {...data} onOpen={(item) => setPanel({ kind: 'item', item })} />
      ) : tab === 'categories' ? (
        <SimpleList
          empty="No categories yet. Items are grouped by category, and each category sends its tickets to one kitchen station."
          rows={data.categories.map((c) => {
            const count = data.items.filter((i) => i.category === c.id).length
            const station = data.stations.find((s) => s.id === c.station)
            return {
              id: c.id,
              title: c.name,
              detail: `${count} ${count === 1 ? 'item' : 'items'} · ${station ? `Tickets to ${station.name}` : 'No kitchen ticket'}`,
              off: c.is_active ? undefined : 'Hidden',
              onOpen: () => setPanel({ kind: 'category', category: c }),
            }
          })}
        />
      ) : tab === 'courses' ? (
        <SimpleList
          empty="No courses yet. Courses (Starters, Mains, Desserts…) set the order dishes are served in."
          rows={data.courses.map((c) => {
            const count = data.items.filter((i) => i.course === c.id).length
            return {
              id: c.id,
              title: c.name,
              detail: `${count} ${count === 1 ? 'item' : 'items'}`,
              onOpen: () => setPanel({ kind: 'course', course: c }),
            }
          })}
        />
      ) : (
        <SimpleList
          empty="No kitchen stations yet. A station is a place in the kitchen that gets its own tickets, like Grill or Bar."
          rows={data.stations.map((s) => {
            const names = data.categories.filter((c) => c.station === s.id).map((c) => c.name)
            return {
              id: s.id,
              title: s.name,
              detail: names.length ? names.join(', ') : 'No categories send tickets here',
              off: s.is_active ? undefined : 'Inactive',
              onOpen: () => setPanel({ kind: 'station', station: s }),
            }
          })}
        />
      )
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Menu</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="lg" onClick={() => setPanel({ kind: 'import' })}>
            <Upload /> Import
          </Button>
          <Button size="lg" onClick={add}>
            <Plus /> {TABS.find((t) => t.value === tab)!.add}
          </Button>
        </div>
      </header>

      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-muted p-1 text-sm sm:w-fit">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              'h-8 shrink-0 rounded-lg px-3 transition-colors',
              tab === t.value
                ? 'bg-background font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {body}

      {panel && (
        <Sheet onClose={close}>
          {panel.kind === 'import' ? (
            <MenuImport hasItems={(items.data?.length ?? 0) > 0} onDone={close} />
          ) : panel.kind === 'item' ? (
            <ItemForm
              item={panel.item}
              categories={categories.data ?? []}
              courses={courses.data ?? []}
              onDone={close}
            />
          ) : panel.kind === 'category' ? (
            <CategoryForm category={panel.category} stations={stations.data ?? []} onDone={close} />
          ) : panel.kind === 'course' ? (
            <CourseForm course={panel.course} onDone={close} />
          ) : (
            <StationForm station={panel.station} onDone={close} />
          )}
        </Sheet>
      )}
    </div>
  )
}

// ---------- items ----------

function ItemsTab(props: {
  items: MenuItem[]
  categories: Category[]
  courses: Course[]
  onOpen: (item: MenuItem) => void
}) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<number | 'all' | 'off'>('all')

  const toggle = useMutation({
    mutationFn: (item: MenuItem) =>
      patch<MenuItem>(`/menu-items/${item.id}/`, { is_available: !item.is_available }),
    onSuccess: (saved) =>
      queryClient.setQueryData<MenuItem[]>(KEYS.items, (old) =>
        old?.map((i) => (i.id === saved.id ? saved : i)),
      ),
  })

  if (props.categories.length === 0) {
    return <PageState>Add a category first (Categories tab), then add items to it.</PageState>
  }

  const query = search.trim().toLowerCase()
  const visible = props.items.filter((i) =>
    query
      ? i.name.toLowerCase().includes(query)
      : category === 'all' || (category === 'off' ? !i.is_available : i.category === category),
  )
  const groups = props.categories
    .map((c) => ({ category: c, items: visible.filter((i) => i.category === c.id) }))
    .filter((g) => g.items.length > 0)
  const unavailable = props.items.filter((i) => !i.is_available).length
  const courseName = (id: number | null) => props.courses.find((c) => c.id === id)?.name

  return (
    <div className="grid gap-4">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search items"
          aria-label="Search items"
          className="h-10 rounded-xl bg-background pl-10"
        />
      </div>
      <div className="flex gap-2 overflow-x-auto">
        {[
          { id: 'all' as const, name: 'All' },
          ...props.categories,
          ...(unavailable ? [{ id: 'off' as const, name: `Unavailable · ${unavailable}` }] : []),
        ].map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setCategory(c.id)
              setSearch('')
            }}
            className={cn(
              'shrink-0 rounded-full border px-3.5 py-1 text-sm transition-colors',
              category === c.id && !query
                ? 'border-foreground bg-foreground text-background'
                : 'bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {c.name}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <PageState>{query ? 'Nothing matches.' : 'No items here yet.'}</PageState>
      ) : (
        groups.map(({ category: c, items }) => (
          <section key={c.id} className="grid gap-2">
            <h2 className="flex items-baseline gap-2 px-1 text-sm font-medium">
              {c.name}
              <span className="text-xs font-normal text-muted-foreground">
                {items.length}
                {!c.is_active && ' · category hidden from the order screen'}
              </span>
            </h2>
            <ul className="divide-y overflow-hidden rounded-2xl border bg-background">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex cursor-pointer items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
                  onClick={() => props.onOpen(item)}
                >
                  {item.image ? (
                    <img src={item.image} alt="" className="size-11 shrink-0 rounded-lg object-cover" />
                  ) : null}
                  <div className={cn('min-w-0 flex-1', !item.is_available && 'opacity-50')}>
                    <p className="flex items-center gap-2 font-medium">
                      <VegMark veg={item.is_vegetarian} />
                      <span className="truncate">{item.name}</span>
                      {item.has_jain && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
                          Jain option
                        </span>
                      )}
                      {item.is_special && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                          Special
                        </span>
                      )}
                    </p>
                    {(item.course || item.description) && (
                      <p className="truncate text-sm text-muted-foreground">
                        {[courseName(item.course), item.description].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                  <span className="w-20 text-right font-medium tabular-nums">{money(item.price)}</span>
                  <Switch
                    label={`${item.name} available`}
                    checked={item.is_available}
                    disabled={toggle.isPending && toggle.variables?.id === item.id}
                    onChange={() => toggle.mutate(item)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {toggle.error && <p className="text-sm text-destructive">{toggle.error.message}</p>}
    </div>
  )
}

function VegMark({ veg }: { veg: boolean }) {
  return (
    <span
      title={veg ? 'Vegetarian' : 'Non-vegetarian'}
      className={cn(
        'grid size-3.5 shrink-0 place-items-center rounded-[3px] border',
        veg ? 'border-emerald-600' : 'border-red-700',
      )}
    >
      <span className={cn('size-1.5 rounded-full', veg ? 'bg-emerald-600' : 'bg-red-700')} />
    </span>
  )
}

function ItemForm(props: {
  item?: MenuItem
  categories: Category[]
  courses: Course[]
  onDone: () => void
}) {
  const editing = props.item
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    name: editing?.name ?? '',
    price: editing ? String(Number(editing.price)) : '',
    category: (editing?.category ?? props.categories[0]?.id ?? null) as number | null,
    course: (editing?.course ?? null) as number | null,
    description: editing?.description ?? '',
    is_vegetarian: editing?.is_vegetarian ?? true,
    has_jain: editing?.has_jain ?? false,
    is_special: editing?.is_special ?? false,
    is_available: editing?.is_available ?? true,
  })
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  // undefined: keep the current photo; null: remove it; a File: replace it.
  const [photo, setPhoto] = useState<File | null | undefined>(undefined)
  const preview = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo])
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  const shown = photo === undefined ? editing?.image : preview

  const refresh = () => queryClient.invalidateQueries({ queryKey: KEYS.items })
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, name: form.name.trim(), description: form.description.trim() }
      const path = editing ? `/menu-items/${editing.id}/` : '/menu-items/'
      const method = editing ? 'PATCH' : 'POST'
      if (photo) return sendForm<MenuItem>(method, path, { ...body, image: photo })
      const json = photo === null ? { ...body, image: null } : body
      return editing ? patch<MenuItem>(path, json) : post<MenuItem>(path, json)
    },
    onSuccess: () => {
      refresh()
      props.onDone()
    },
  })
  const destroy = useMutation({
    mutationFn: () => remove(`/menu-items/${editing!.id}/`),
    onSuccess: () => {
      refresh()
      props.onDone()
    },
  })

  const ready = form.name.trim() && form.price !== '' && Number(form.price) >= 0 && form.category

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) save.mutate()
      }}
    >
      <h2 className="pr-10 text-lg font-semibold tracking-tight">{editing ? editing.name : 'New item'}</h2>

      <div className="flex items-center gap-4">
        <label className="grid size-20 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed bg-muted/40 text-muted-foreground transition-colors hover:bg-muted">
          {shown ? (
            <img src={shown} alt="" className="size-full object-cover" />
          ) : (
            <ImagePlus className="size-5" />
          )}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && setPhoto(e.target.files[0])}
          />
        </label>
        <div className="grid gap-1 text-sm">
          <span className="font-medium">Photo</span>
          <span className="text-muted-foreground">Optional. Click the box to choose one.</span>
          {shown && (
            <button
              type="button"
              onClick={() => setPhoto(null)}
              className="w-fit text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Remove photo
            </button>
          )}
        </div>
      </div>

      <Field label="Name">
        <Input autoFocus={!editing} value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price (₹)">
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={form.price}
            onChange={(e) => set('price', e.target.value)}
          />
        </Field>
        <Field label="Category">
          <Select
            label="Category"
            value={form.category}
            onChange={(v) => set('category', v)}
            options={props.categories.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
      </div>
      <Field label="Course" hint="Sets the order dishes are served in. Optional.">
        <Select
          label="Course"
          value={form.course}
          onChange={(v) => set('course', v)}
          empty="None"
          options={props.courses.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Field>
      <Field label="Description">
        <textarea
          rows={2}
          className={textareaClass}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>

      <div className="grid gap-3">
        <Chips
          options={[
            { value: 'veg', label: 'Vegetarian' },
            { value: 'nonveg', label: 'Non-vegetarian' },
          ]}
          value={form.is_vegetarian ? 'veg' : 'nonveg'}
          onChange={(v) => set('is_vegetarian', v === 'veg')}
        />
        <div className="grid gap-1">
          <Switch showLabel label="Jain option" checked={form.has_jain} onChange={(v) => set('has_jain', v)} />
          <p className="text-xs text-muted-foreground">
            Waiters choose Regular or Jain when ordering; Jain prints as “(J)” on the KOT.
          </p>
        </div>
        <Switch showLabel label="Today's special" checked={form.is_special} onChange={(v) => set('is_special', v)} />
        <Switch
          showLabel
          label="Available to order"
          checked={form.is_available}
          onChange={(v) => set('is_available', v)}
        />
      </div>

      <FormFooter
        error={save.error ?? destroy.error}
        canSave={Boolean(ready)}
        busy={save.isPending || destroy.isPending}
        saveLabel={editing ? 'Save changes' : 'Add item'}
        onDelete={editing ? () => destroy.mutate() : undefined}
        deleteHint="Items that were ever ordered can't be deleted. Switch off “Available to order” instead."
        onCancel={props.onDone}
      />
    </form>
  )
}

// ---------- categories, courses, stations ----------

function SimpleList(props: {
  empty: string
  rows: { id: number; title: string; detail: string; off?: string; onOpen: () => void }[]
}) {
  if (props.rows.length === 0) return <PageState>{props.empty}</PageState>
  return (
    <ul className="divide-y overflow-hidden rounded-2xl border bg-background">
      {props.rows.map((row) => (
        <li key={row.id}>
          <button
            onClick={row.onOpen}
            className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-muted/50"
          >
            <div className={cn('min-w-0 flex-1', row.off && 'opacity-50')}>
              <p className="font-medium">{row.title}</p>
              <p className="truncate text-sm text-muted-foreground">{row.detail}</p>
            </div>
            {row.off && (
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {row.off}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Save and delete for a plain resource, refreshing the lists that show it. */
function useResource<T extends { id: number }>(path: string, keys: string[][], onDone: () => void) {
  const queryClient = useQueryClient()
  const done = () => {
    for (const queryKey of keys) queryClient.invalidateQueries({ queryKey })
    onDone()
  }
  const save = useMutation({
    mutationFn: ({ id, body }: { id?: number; body: object }) =>
      id ? patch<T>(`${path}${id}/`, body) : post<T>(path, body),
    onSuccess: done,
  })
  const destroy = useMutation({ mutationFn: (id: number) => remove(`${path}${id}/`), onSuccess: done })
  return { save, destroy }
}

function CategoryForm(props: { category?: Category; stations: Station[]; onDone: () => void }) {
  const editing = props.category
  const [name, setName] = useState(editing?.name ?? '')
  const [station, setStation] = useState<number | null>(editing?.station ?? null)
  const [sortOrder, setSortOrder] = useState(String(editing?.sort_order ?? 0))
  const [active, setActive] = useState(editing?.is_active ?? true)
  // Categories show on the order screen, items group under them.
  const { save, destroy } = useResource<Category>('/categories/', [['categories'], KEYS.items], props.onDone)

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          id: editing?.id,
          body: { name: name.trim(), station, sort_order: Number(sortOrder) || 0, is_active: active },
        })
      }}
    >
      <h2 className="pr-10 text-lg font-semibold tracking-tight">{editing ? editing.name : 'New category'}</h2>
      <Field label="Name">
        <Input autoFocus={!editing} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Kitchen station" hint="Where its items' tickets go. None means no ticket, e.g. bottled drinks.">
        <Select
          label="Kitchen station"
          value={station}
          onChange={setStation}
          empty="None — no kitchen ticket"
          options={props.stations.map((s) => ({ value: s.id, label: s.is_active ? s.name : `${s.name} (inactive)` }))}
        />
      </Field>
      <Field label="Position" hint="Lower numbers come first on the order screen.">
        <Input type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
      </Field>
      <Switch showLabel label="Show on the order screen" checked={active} onChange={setActive} />
      <FormFooter
        error={save.error ?? destroy.error}
        canSave={Boolean(name.trim())}
        busy={save.isPending || destroy.isPending}
        saveLabel={editing ? 'Save changes' : 'Add category'}
        onDelete={editing ? () => destroy.mutate(editing.id) : undefined}
        deleteHint="A category that still has items can't be deleted. Move or delete its items first, or hide it."
        onCancel={props.onDone}
      />
    </form>
  )
}

function CourseForm(props: { course?: Course; onDone: () => void }) {
  const editing = props.course
  const [name, setName] = useState(editing?.name ?? '')
  const [sortOrder, setSortOrder] = useState(String(editing?.sort_order ?? 0))
  const { save, destroy } = useResource<Course>('/courses/', [KEYS.courses, KEYS.items], props.onDone)

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ id: editing?.id, body: { name: name.trim(), sort_order: Number(sortOrder) || 0 } })
      }}
    >
      <h2 className="pr-10 text-lg font-semibold tracking-tight">{editing ? editing.name : 'New course'}</h2>
      <Field label="Name">
        <Input autoFocus={!editing} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Position" hint="Serving order: Starters 1, Mains 2, Desserts 3.">
        <Input type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
      </Field>
      <FormFooter
        error={save.error ?? destroy.error}
        canSave={Boolean(name.trim())}
        busy={save.isPending || destroy.isPending}
        saveLabel={editing ? 'Save changes' : 'Add course'}
        onDelete={editing ? () => destroy.mutate(editing.id) : undefined}
        deleteHint="Items in this course are kept; they just lose their course."
        onCancel={props.onDone}
      />
    </form>
  )
}

function StationForm(props: { station?: Station; onDone: () => void }) {
  const editing = props.station
  const [name, setName] = useState(editing?.name ?? '')
  const [active, setActive] = useState(editing?.is_active ?? true)
  const { save, destroy } = useResource<Station>('/stations/', [['stations'], ['categories']], props.onDone)

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ id: editing?.id, body: { name: name.trim(), is_active: active } })
      }}
    >
      <h2 className="pr-10 text-lg font-semibold tracking-tight">{editing ? editing.name : 'New kitchen station'}</h2>
      <Field label="Name">
        <Input autoFocus={!editing} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Switch showLabel label="Show on the kitchen screen" checked={active} onChange={setActive} />
      <FormFooter
        error={save.error ?? destroy.error}
        canSave={Boolean(name.trim())}
        busy={save.isPending || destroy.isPending}
        saveLabel={editing ? 'Save changes' : 'Add station'}
        onDelete={editing ? () => destroy.mutate(editing.id) : undefined}
        deleteHint="A station that ever got a ticket can't be deleted; switch it off instead."
        onCancel={props.onDone}
      />
    </form>
  )
}
