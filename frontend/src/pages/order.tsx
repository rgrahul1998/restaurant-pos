import { Dialog } from '@base-ui/react/dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, MessageSquareText, Minus, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { JainTag } from '@/components/jain-tag'
import { Field } from '@/components/sheet'
import { PageState } from '@/components/page-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, apiAll, patch, post } from '@/lib/api'
import { canPrintHere, printHere, type DeviceTicket } from '@/lib/device-printer'
import { useAuth } from '@/lib/auth'
import { money } from '@/lib/format'
import { searchMenu } from '@/lib/menu-search'
import { canBill, canCancelSent } from '@/lib/nav'
import { METHODS } from '@/lib/payments'
import type {
  Category,
  MenuItem,
  Order,
  OrderItem,
  OrderLine,
  PaymentMethod,
  Table,
} from '@/lib/types'
import { cn } from '@/lib/utils'

export function OrderPage() {
  const { id } = useParams()
  const orderId = id ? Number(id) : null
  const [params] = useSearchParams()
  const tableId = params.get('table') ? Number(params.get('table')) : null

  const role = useAuth((s) => s.user!.role)
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  // Phones and portrait tablets show the menu or the cart, not both.
  const [pane, setPane] = useState<'menu' | 'cart'>('menu')
  // Back is wherever the waiter came from (usually the floor), like Android's back button.
  // Opened from a link with no history: a table's order goes to the floor, takeaway to orders.
  const goBack = (o?: Order) => {
    if (location.key !== 'default') navigate(-1)
    else navigate((o?.table ?? tableId) ? '/floor' : '/orders', { replace: true })
  }

  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api<Order>(`/orders/${orderId}/`),
    enabled: orderId !== null,
  })
  const table = useQuery({
    queryKey: ['table', tableId],
    queryFn: () => api<Table>(`/tables/${tableId}/`),
    enabled: orderId === null && tableId !== null,
  })

  // Every action returns the fresh order, which replaces the cached one.
  const run = useMutation({
    mutationFn: (action: () => Promise<Order>) => action(),
    onMutate: () => setError(''),
    onError: (err) => setError(err.message),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['order', fresh.id], fresh)
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['tables'] })
      if (orderId === null) navigate(`/orders/${fresh.id}`, { replace: true })
    },
  })

  const change = (lines: OrderLine[]) =>
    run.mutate(() =>
      orderId === null
        ? post<Order>('/orders/', {
            order_type: tableId ? 'dine_in' : 'takeaway',
            table: tableId,
            lines,
          })
        : patch<Order>(`/orders/${orderId}/`, { lines }),
    )
  const act = (name: 'fire' | 'bill' | 'reopen' | 'cancel', body?: unknown) =>
    run.mutate(async () => {
      // In the Android app, the KOT comes back to be printed from this tablet.
      const fresh = await post<Order & { print?: DeviceTicket[] }>(
        `/orders/${orderId}/${name}/`,
        name === 'fire' && canPrintHere ? { print_here: true } : body,
      )
      const failed = fresh.print?.length ? await printHere(fresh.print) : null
      setNotice(failed ?? '')
      // Billing prints the bill. A printing problem is reported but doesn't undo the bill.
      if (name === 'bill') await printBill()
      // A waiter is done once the kitchen has it: back to the tables. Not if the KOT
      // didn't print, so they see why.
      if (name === 'fire' && !failed && !canBill(role)) goBack(fresh)
      return fresh
    })
  const [notice, setNotice] = useState('')
  const printBill = async () => {
    setNotice('')
    try {
      const sent = await post<{ print: DeviceTicket[] } | null>(
        `/orders/${orderId}/print-bill/`,
        canPrintHere ? { print_here: true } : undefined,
      )
      setNotice((sent?.print && (await printHere(sent.print))) || 'Bill sent to the printer.')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'The bill was not printed.')
    }
  }
  const pay = (body: { method: PaymentMethod; amount: string; reference: string }) =>
    run.mutate(async () => {
      await post('/payments/', { order: orderId, ...body })
      return api<Order>(`/orders/${orderId}/`)
    })

  if (orderId !== null && order.isPending) return <PageState>Loading…</PageState>
  if (order.isError) return <PageState error>Could not load this order.</PageState>

  const current = order.data
  const status = current?.status ?? 'open'
  const items = current?.items ?? []
  const title = current ? (current.table_name ?? 'Takeaway') : (table.data?.label ?? 'Takeaway')

  // Anything added after a KOT gets a row of its own, so it can carry its own cooking
  // instruction; the bill merges these rows back into one line.
  const add = (menuItemId: number, jain = false) => {
    const line = items.find(
      (i) => i.menu_item === menuItemId && i.is_jain === jain && !i.note && i.kot_quantity === 0,
    )
    change([
      line
        ? { id: line.id, quantity: line.quantity + 1 }
        : { menu_item: menuItemId, ...(jain ? { is_jain: true } : {}) },
    ])
  }

  const summary = (
    <>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {current?.customer_name && (
            // A reservation's party (or any named customer), so staff know whose table it is.
            <p className="mt-0.5 truncate text-sm font-medium">
              {current.customer_name}
              <span className="font-normal text-muted-foreground">
                {' · '}
                {current.guests} {current.guests === 1 ? 'guest' : 'guests'}
              </span>
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {current ? `Order #${current.id} · ${current.waiter_name}` : 'New order'}
          </p>
        </div>
        {status !== 'open' && (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium capitalize">
            {status}
          </span>
        )}
      </header>

      <Lines
        items={items}
        editable={status === 'open'}
        busy={run.isPending}
        mayCancelSent={canCancelSent(role)}
        onChange={change}
        onAddMore={add}
      />

      {current && <Totals order={current} />}
    </>
  )

  const actions = (
    <>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && status === 'open' && <p className="text-sm text-destructive">{notice}</p>}

      {status === 'open' && current && (
        <OpenActions
          order={current}
          busy={run.isPending}
          mayBill={canBill(role)}
          onFire={() => act('fire')}
          onBill={(body) => act('bill', body)}
          onCancel={() => window.confirm('Cancel this whole order?') && act('cancel')}
        />
      )}
      {status === 'billed' && current && canBill(role) && (
        <PaymentForm
          key={current.balance}
          balance={current.balance}
          busy={run.isPending}
          onPay={pay}
          onReopen={current.payments.length === 0 ? () => act('reopen') : undefined}
        />
      )}
      {(status === 'billed' || status === 'paid') && (
        <div className="grid gap-2 text-center">
          <Button variant="outline" size="lg" className="h-11" onClick={printBill}>
            Print bill
          </Button>
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        </div>
      )}
    </>
  )

  const panel = 'grid gap-5 rounded-2xl border bg-background p-5'
  const count = items.reduce((n, i) => n + i.quantity, 0)

  // Back, the table, and on narrow screens the Menu / Cart switch. Sticks under the header.
  const topBar = (
    <div className="sticky top-14 z-10 -mx-4 -mt-6 flex items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur sm:-mx-8 sm:px-8 lg:static lg:mx-0 lg:mt-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
      <button
        onClick={() => goBack(current)}
        className="-ml-2 inline-flex h-11 items-center gap-0.5 rounded-lg pr-3 pl-1 text-sm font-medium hover:bg-muted"
      >
        <ChevronLeft className="size-5" />
        Back
      </button>
      <span className="min-w-0 truncate text-sm text-muted-foreground lg:hidden">{title}</span>
      {status === 'open' && (
        <div className="ml-auto grid grid-cols-2 gap-1 rounded-xl bg-muted p-1 lg:hidden">
          {(['menu', 'cart'] as const).map((p) => (
            <button
              key={p}
              aria-pressed={pane === p}
              onClick={() => setPane(p)}
              className={cn(
                'h-9 rounded-lg px-4 text-sm font-medium transition-colors',
                pane === p ? 'bg-background shadow-sm' : 'text-muted-foreground',
              )}
            >
              {p === 'menu' ? 'Menu' : `Cart${count ? ` · ${count}` : ''}`}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  // Taking an order: the menu fills the screen and the cart sits on the right. Narrower,
  // one of them at a time.
  if (status === 'open')
    return (
      <div className="grid gap-4 lg:gap-6">
        {topBar}
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 pb-20 lg:grid-cols-[minmax(0,1fr)_26rem] lg:pb-0">
          <div className={cn(pane === 'cart' && 'max-lg:hidden')}>
            <MenuPicker items={items} onAdd={(m, jain) => add(m.id, jain)} busy={run.isPending} />
          </div>
          <aside id="cart" className={cn(panel, 'lg:sticky lg:top-20', pane === 'menu' && 'max-lg:hidden')}>
            {summary}
            {actions}
          </aside>
          {pane === 'menu' && (
            <CartBar items={items} total={current?.total} onView={() => setPane('cart')} />
          )}
        </div>
      </div>
    )

  // Billed, paid or cancelled: the bill (receipt width) beside payment and printing.
  return (
    <div className="mx-auto grid w-full max-w-[68rem] gap-4 lg:gap-6">
      {topBar}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <section className={panel}>{summary}</section>
        <aside className={cn(panel, 'lg:sticky lg:top-20')}>{actions}</aside>
      </div>
    </div>
  )
}

/** Phones and portrait tablets: while the menu shows, this keeps the cart one tap away. */
function CartBar({ items, total, onView }: { items: OrderItem[]; total?: string; onView: () => void }) {
  const count = items.reduce((n, i) => n + i.quantity, 0)
  const unsent = items.reduce((n, i) => n + Math.max(i.quantity - i.kot_quantity, 0), 0)
  if (count === 0) return null
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-8 lg:hidden">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">
            {count} {count === 1 ? 'item' : 'items'}
            {total !== undefined && <span className="tabular-nums"> · {money(total)}</span>}
          </p>
          {unsent > 0 && <p className="text-xs text-warning">{unsent} not sent to the kitchen</p>}
        </div>
        <Button size="lg" className="h-11" onClick={onView}>
          View cart
        </Button>
      </div>
    </div>
  )
}

function MenuPicker(props: {
  items: OrderItem[]
  onAdd: (item: MenuItem, jain?: boolean) => void
  busy: boolean
}) {
  const [category, setCategory] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiAll<Category>('/categories/?is_active=true'),
    staleTime: 60_000,
  })
  const menu = useQuery({
    queryKey: ['menu-items'],
    queryFn: () => apiAll<MenuItem>('/menu-items/'),
    staleTime: 60_000,
  })

  const inCart = useMemo(() => {
    const counts = new Map<number, number>()
    for (const i of props.items) counts.set(i.menu_item, (counts.get(i.menu_item) ?? 0) + i.quantity)
    return counts
  }, [props.items])

  if (menu.isPending || categories.isPending) return <PageState>Loading menu…</PageState>
  if (menu.isError || categories.isError) return <PageState error>Could not load the menu.</PageState>

  const query = search.trim()
  const visible = query
    ? searchMenu(menu.data, query)
    : menu.data.filter((m) => category === null || m.category === category)
  // Enter adds the best match, so "12 ⏎" orders dish 12. A Jain-option dish still needs a tap.
  const top = query ? visible[0] : undefined
  const quickAdd = top && top.is_available && !top.has_jain ? top : undefined

  return (
    <section className="grid gap-4">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !quickAdd || props.busy) return
          e.preventDefault()
          props.onAdd(quickAdd)
          setSearch('')
        }}
        placeholder="Search by name or number"
        enterKeyHint="done"
        className="h-11 rounded-xl bg-background px-4"
      />
      <div className="flex gap-2 overflow-x-auto">
        {[{ id: null, name: 'All' }, ...categories.data].map((c) => (
          <button
            key={c.id ?? 'all'}
            onClick={() => {
              setCategory(c.id)
              setSearch('')
            }}
            className={cn(
              'shrink-0 rounded-full border px-4 py-1.5 text-sm transition-colors',
              category === c.id && !query
                ? 'border-foreground bg-foreground text-background'
                : 'bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {c.name}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <PageState>Nothing matches.</PageState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
          {visible.map((m) => {
            const count = inCart.get(m.id)
            const tile = cn(
              'relative flex min-h-24 flex-col justify-between rounded-2xl border bg-background p-4 text-left transition-colors',
              !m.is_available && 'opacity-40',
              count && 'border-foreground',
            )
            const badge = count ? (
              <span className="absolute top-3 right-3 grid size-6 place-items-center rounded-full bg-foreground text-xs font-medium text-background">
                {count}
              </span>
            ) : null
            // A dish with a Jain option asks which one; the rest add with a single tap.
            if (m.has_jain && m.is_available) {
              return (
                <div key={m.id} className={cn(tile, 'gap-3')}>
                  <span className="pr-6 text-sm leading-snug font-medium">
                    <span className="mr-1.5 text-xs font-normal text-muted-foreground tabular-nums">{m.code}</span>
                    {m.name}
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">{money(m.price)}</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button variant="outline" disabled={props.busy} onClick={() => props.onAdd(m)}>
                      Regular
                    </Button>
                    <Button
                      variant="outline"
                      disabled={props.busy}
                      onClick={() => props.onAdd(m, true)}
                      className="border-veg/50 text-veg hover:bg-veg/10 hover:text-veg"
                    >
                      Jain
                    </Button>
                  </div>
                  {badge}
                </div>
              )
            }
            return (
              <button
                key={m.id}
                disabled={!m.is_available || props.busy}
                onClick={() => props.onAdd(m)}
                className={cn(
                  tile,
                  'hover:border-foreground/40 active:bg-muted disabled:pointer-events-none',
                  m === quickAdd && 'ring-2 ring-foreground/15',
                )}
              >
                <span className="pr-6 text-sm leading-snug font-medium">
                  <span className="mr-1.5 text-xs font-normal text-muted-foreground tabular-nums">{m.code}</span>
                  {m.name}
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {m.is_available ? money(m.price) : 'Unavailable'}
                </span>
                {badge}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Lines(props: {
  items: OrderItem[]
  editable: boolean
  busy: boolean
  mayCancelSent: boolean
  onChange: (lines: OrderLine[]) => void
  onAddMore: (menuItemId: number, jain: boolean) => void
}) {
  // Fully cancelled lines stay on the order for the kitchen's records; hide them here.
  const shown = props.items.filter((i) => i.quantity > 0 || i.quantity !== i.kot_quantity)
  if (shown.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {props.editable ? 'Tap an item to add it.' : 'No items.'}
      </p>
    )
  }

  return (
    <ul className="grid gap-4">
      {shown.map((item) => {
        const unsent = item.quantity - item.kot_quantity
        const locked = item.quantity <= item.kot_quantity && !props.mayCancelSent
        return (
          <li key={item.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
            <div className="min-w-0">
              <p className={cn('truncate text-sm font-medium', item.quantity === 0 && 'line-through')}>
                {item.name}
                {item.is_jain && <JainTag />}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {props.editable && item.quantity > 0 ? (
                  <ItemRate
                    item={item}
                    busy={props.busy}
                    onSave={(unit_price) => props.onChange([{ id: item.id, unit_price }])}
                  />
                ) : (
                  money(item.line_total)
                )}
                {unsent !== 0 && (
                  <span className={unsent > 0 ? 'text-warning' : 'text-destructive'}>
                    {' · '}
                    {unsent > 0 ? `${unsent} not sent` : `cancel ${-unsent}, not sent`}
                  </span>
                )}
              </p>
            </div>
            {props.editable ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Remove one ${item.name}`}
                  title={locked ? 'Only a manager can cancel items already sent' : undefined}
                  disabled={props.busy || locked || item.quantity === 0}
                  onClick={() => props.onChange([{ id: item.id, quantity: item.quantity - 1 }])}
                >
                  <Minus />
                </Button>
                <span className="w-7 text-center text-sm font-medium tabular-nums">{item.quantity}</span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Add one ${item.name}`}
                  disabled={props.busy}
                  onClick={() =>
                    // Once sent, more of it goes on a fresh row with its own instructions.
                    item.kot_quantity > 0
                      ? props.onAddMore(item.menu_item, item.is_jain)
                      : props.onChange([{ id: item.id, quantity: item.quantity + 1 }])
                  }
                >
                  <Plus />
                </Button>
              </div>
            ) : (
              <span className="text-sm tabular-nums">× {item.quantity}</span>
            )}
            {props.editable && item.kot_quantity === 0 ? (
              <ItemNote
                note={item.note}
                busy={props.busy}
                onSave={(note) => props.onChange([{ id: item.id, note }])}
              />
            ) : (
              item.note && (
                <p className="col-span-2 mt-1 flex items-start gap-1.5 text-xs text-warning">
                  <MessageSquareText className="mt-px size-3.5 shrink-0" />
                  {item.note}
                </p>
              )
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Settings → Cooking instructions: one tap each; anything else can be typed. Printed on the KOT only. */
function useQuickNotes() {
  return (
    useQuery({
      queryKey: ['settings', 'cooking-instructions'],
      queryFn: () => api<{ instructions: string[] }>('/settings/cooking-instructions/'),
      staleTime: 5 * 60_000,
    }).data?.instructions ?? []
  )
}

const joinNotes = (parts: string[]) => parts.join(', ').slice(0, 255)
const splitNote = (note: string) =>
  note
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

/** The line's amount; double-click (double-tap) to charge a different rate, e.g. a half portion. */
function ItemRate(props: { item: OrderItem; busy: boolean; onSave: (unitPrice: string) => void }) {
  const { item } = props
  const [draft, setDraft] = useState<string | null>(null)

  const save = () => {
    const value = Number(draft)
    setDraft(null)
    if (draft?.trim() && Number.isFinite(value) && value >= 0 && value !== Number(item.unit_price))
      props.onSave(value.toFixed(2))
  }

  if (draft === null)
    return (
      <span
        onDoubleClick={() => !props.busy && setDraft(String(Number(item.unit_price)))}
        title="Double-click to change the rate"
        className="cursor-text select-none"
      >
        {money(item.line_total)}
        {item.quantity > 1 && ` (${money(item.unit_price)} each)`}
      </span>
    )

  return (
    <span className="inline-flex items-center gap-1">
      ₹
      <input
        autoFocus
        inputMode="decimal"
        aria-label={`Rate for ${item.name}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
        onFocus={(e) => e.target.select()}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(null)
        }}
        className="h-7 w-20 rounded-md border bg-background px-2 text-sm text-foreground"
      />
      {item.quantity > 1 && 'each'}
    </span>
  )
}

/** Special instructions for one line, editable until the kitchen has it. */
function ItemNote(props: { note: string; busy: boolean; onSave: (note: string) => void }) {
  const quickNotes = useQuickNotes()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(props.note)

  const start = () => {
    setDraft(props.note)
    setOpen(true)
  }
  const save = (note: string) => {
    setOpen(false)
    if (note.trim() !== props.note) props.onSave(note.trim())
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={start}
        disabled={props.busy}
        className={cn(
          'col-span-2 mt-1 flex items-start gap-1.5 text-left text-xs',
          props.note
            ? 'text-warning'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <MessageSquareText className="mt-px size-3.5 shrink-0" />
        {props.note || 'Cooking instructions'}
      </button>
    )
  }

  const picked = splitNote(draft)
  const toggle = (quick: string) =>
    setDraft(
      joinNotes(
        picked.some((p) => p.toLowerCase() === quick.toLowerCase())
          ? picked.filter((p) => p.toLowerCase() !== quick.toLowerCase())
          : [...picked, quick],
      ),
    )

  return (
    <div className="col-span-2 mt-2 grid gap-2 rounded-lg border bg-muted/30 p-2.5">
      {quickNotes.length > 0 && (
      <div className="flex flex-wrap gap-1.5">
        {quickNotes.map((quick) => {
          const on = picked.some((p) => p.toLowerCase() === quick.toLowerCase())
          return (
            <button
              key={quick}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(quick)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                on
                  ? 'border-foreground bg-foreground text-background'
                  : 'bg-background hover:bg-muted',
              )}
            >
              {quick}
            </button>
          )
        })}
      </div>
      )}
      <Input
        autoFocus
        value={draft}
        maxLength={255}
        placeholder="Or type a cooking instruction"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save(draft)
          if (e.key === 'Escape') setOpen(false)
        }}
        className="h-8 text-xs"
      />
      <div className="flex justify-end gap-2">
        {props.note && (
          <Button variant="ghost" size="sm" className="mr-auto text-destructive" onClick={() => save('')}>
            Clear
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => save(draft)}>
          Save
        </Button>
      </div>
    </div>
  )
}

function Totals({ order }: { order: Order }) {
  const row = 'flex justify-between text-sm text-muted-foreground tabular-nums'
  const hasDiscount = Number(order.discount) > 0
  const hasAdvance = Number(order.advance) > 0
  const hasPayments = order.payments.length > 0 || hasAdvance
  return (
    <dl className="grid gap-1.5 border-t pt-4">
      {hasDiscount && (
        <>
          <div className={row}>
            <dt>Subtotal</dt>
            <dd>{money(order.subtotal)}</dd>
          </div>
          <div className={row}>
            <dt>Discount{order.discount_percent && ` (${Number(order.discount_percent)}%)`}</dt>
            <dd>− {money(order.discount)}</dd>
          </div>
        </>
      )}
      <div className="flex justify-between text-base font-semibold tabular-nums">
        <dt>Total</dt>
        <dd>{money(order.total)}</dd>
      </div>
      {hasAdvance && (
        <div className={row}>
          <dt>Advance{order.reservation && ` · reservation #${order.reservation}`}</dt>
          <dd>− {money(order.advance)}</dd>
        </div>
      )}
      {order.payments.map((p) => (
        <div key={p.id} className={row}>
          <dt className="capitalize">
            {p.method === 'upi' ? 'UPI' : p.method}
            {p.reference && ` · ${p.reference}`}
          </dt>
          <dd>− {money(p.amount)}</dd>
        </div>
      ))}
      {hasPayments && order.status === 'billed' && (
        <div className="flex justify-between text-sm font-medium tabular-nums">
          <dt>Balance due</dt>
          <dd>{money(order.balance)}</dd>
        </div>
      )}
    </dl>
  )
}

function OpenActions(props: {
  order: Order
  busy: boolean
  mayBill: boolean
  onFire: () => void
  onBill: (body: BillBody) => void
  onCancel: () => void
}) {
  const [discount, setDiscount] = useState('')
  const [type, setType] = useState<'amount' | 'percent'>('percent')
  const [confirming, setConfirming] = useState(false)
  const { order } = props
  const hasItems = order.items.some((i) => i.quantity > 0)

  const subtotal = Number(order.subtotal)
  const value = Number(discount) || 0
  const off = type === 'percent' ? (subtotal * value) / 100 : value
  const valid = value >= 0 && off <= subtotal

  return (
    <div className="grid gap-3">
      {order.has_unsent ? (
        <Button size="lg" className="h-11" disabled={props.busy} onClick={props.onFire}>
          Send to kitchen
        </Button>
      ) : (
        props.mayBill &&
        hasItems && (
          <div className="flex gap-2">
            <div className="flex h-11 w-40 items-center rounded-lg border border-input bg-background pr-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <input
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                inputMode="decimal"
                placeholder="Discount"
                aria-label={type === 'percent' ? 'Discount percent' : 'Discount amount'}
                className="w-full min-w-0 bg-transparent px-2.5 text-sm outline-none tabular-nums"
              />
              {(['percent', 'amount'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={type === t}
                  aria-label={t === 'percent' ? 'Discount as percent' : 'Discount as amount'}
                  onClick={() => setType(t)}
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-md text-sm transition-colors',
                    type === t ? 'bg-foreground text-background' : 'text-muted-foreground',
                  )}
                >
                  {t === 'percent' ? '%' : '₹'}
                </button>
              ))}
            </div>
            <Button
              size="lg"
              className="h-11 flex-1"
              disabled={props.busy || !valid}
              onClick={() => setConfirming(true)}
            >
              {valid ? `Bill ${money(subtotal - off)}` : 'Discount too high'}
            </Button>
          </div>
        )
      )}
      {confirming && (
        <BillConfirm
          order={order}
          total={subtotal - off}
          discount={off}
          onClose={() => setConfirming(false)}
          onConfirm={(customer) => {
            setConfirming(false)
            props.onBill({ discount: discount || '0', discount_type: type, ...customer })
          }}
        />
      )}
      {!order.has_unsent && hasItems && !props.mayBill && (
        <p className="text-center text-sm text-muted-foreground">
          Everything is with the kitchen. A cashier can bill this order.
        </p>
      )}
      <button
        disabled={props.busy}
        onClick={props.onCancel}
        className="text-sm text-muted-foreground transition-colors hover:text-destructive"
      >
        Cancel order
      </button>
    </div>
  )
}


function PaymentForm(props: {
  balance: string
  busy: boolean
  onPay: (body: { method: PaymentMethod; amount: string; reference: string }) => void
  onReopen?: () => void
}) {
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [amount, setAmount] = useState(props.balance)
  const [reference, setReference] = useState('')
  const valid = Number(amount) > 0 && Number(amount) <= Number(props.balance)

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        props.onPay({ method, amount, reference: method === 'cash' ? '' : reference })
      }}
    >
      <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted p-1">
        {METHODS.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMethod(m.value)}
            className={cn(
              'rounded-lg py-2 text-sm transition-colors',
              method === m.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          aria-label="Amount received"
          className="h-11 tabular-nums"
        />
        {method !== 'cash' && (
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Reference"
            aria-label="Payment reference"
            className="h-11"
          />
        )}
      </div>
      <Button type="submit" size="lg" className="h-11" disabled={props.busy || !valid}>
        {valid ? `Take ${money(amount)}` : `Enter up to ${money(props.balance)}`}
      </Button>
      {props.onReopen && (
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onReopen}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Reopen order
        </button>
      )}
    </form>
  )
}

interface BillBody {
  discount: string
  discount_type: 'amount' | 'percent'
  /** Left out for a reservation's order: its advance is set there. */
  advance?: string
  customer_name: string
  customer_phone: string
}

/** Same rule as the server: 10 digits, ignoring spaces, dashes and a +91 / 0 prefix. */
function mobileDigits(value: string): string | null {
  let digits = value.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

/** "Are you sure?" before billing, and the one moment to note who the customer is. */
function BillConfirm(props: {
  order: Order
  total: number
  discount: number
  onClose: () => void
  onConfirm: (details: { customer_name: string; customer_phone: string; advance?: string }) => void
}) {
  const { order } = props
  const fromReservation = order.reservation !== null
  const [advance, setAdvance] = useState(Number(order.advance) > 0 ? String(Number(order.advance)) : '')
  const advanceValue = Number(advance) || 0
  const advanceError =
    !fromReservation && (Number.isNaN(Number(advance)) || advanceValue < 0)
      ? 'Enter an amount.'
      : !fromReservation && advanceValue > props.total
        ? "The advance can't be more than the bill."
        : ''
  const [name, setName] = useState(order.customer_name)
  const [phone, setPhone] = useState(order.customer_phone)
  const [touched, setTouched] = useState(false)
  const digits = mobileDigits(phone)
  const phoneError = digits === null && touched ? 'Enter a 10-digit mobile number, or leave it empty.' : ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (digits === null || advanceError) return
    props.onConfirm({
      customer_name: name.trim(),
      customer_phone: digits,
      ...(fromReservation ? {} : { advance: String(advanceValue) }),
    })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-foreground/20 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <Dialog.Popup className="grid w-full max-w-sm gap-5 rounded-2xl border bg-background p-6 shadow-xl transition-[opacity,scale] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <div className="grid gap-1">
              <Dialog.Title className="text-lg font-semibold tracking-tight">
                Bill {order.table_name ?? 'takeaway'}?
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                Order #{order.id}
                {props.discount > 0 && ` · ${money(props.discount)} off`}. The bill prints right away
                and items can't be changed after this.
              </Dialog.Description>
            </div>
            <div className="grid gap-0.5">
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                {money(Math.max(props.total - advanceValue, 0))}
              </p>
              {advanceValue > 0 && (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {money(props.total)} less {money(advanceValue)} advance
                </p>
              )}
            </div>
            <form id="bill-confirm" onSubmit={submit} className="grid gap-3">
              <Field label="Customer name" hint="Optional">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  autoComplete="off"
                  className="h-10"
                />
              </Field>
              <Field label="Mobile number" hint={phoneError ? undefined : 'Optional. Saved for offers later.'}>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onBlur={() => setTouched(true)}
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="10-digit mobile"
                  aria-invalid={phoneError ? true : undefined}
                  className="h-10 tabular-nums"
                />
              </Field>
              {phoneError && <p className="-mt-1 text-xs text-destructive">{phoneError}</p>}
              <Field
                label="Advance received"
                hint={
                  advanceError
                    ? undefined
                    : fromReservation
                      ? `Paid on reservation #${order.reservation}.`
                      : 'Optional. Taken off the amount due.'
                }
              >
                <Input
                  value={advance}
                  onChange={(e) => setAdvance(e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  disabled={fromReservation}
                  aria-invalid={advanceError ? true : undefined}
                  className="h-10 tabular-nums"
                />
              </Field>
              {advanceError && <p className="-mt-1 text-xs text-destructive">{advanceError}</p>}
            </form>
            <div className="grid grid-cols-2 gap-2">
              <Dialog.Close render={<Button variant="outline" size="lg" className="h-11" />}>
                Not yet
              </Dialog.Close>
              <Button type="submit" form="bill-confirm" size="lg" className="h-11">
                Bill &amp; print
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
