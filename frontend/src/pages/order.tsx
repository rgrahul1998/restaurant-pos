import { Dialog } from '@base-ui/react/dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Minus, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { JainTag } from '@/components/jain-tag'
import { Field } from '@/components/sheet'
import { PageState } from '@/components/page-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, apiAll, patch, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { money } from '@/lib/format'
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
      const fresh = await post<Order>(`/orders/${orderId}/${name}/`, body)
      // Billing prints the bill. A printing problem is reported but doesn't undo the bill.
      if (name === 'bill') await printBill()
      return fresh
    })
  const [notice, setNotice] = useState('')
  const printBill = async () => {
    setNotice('')
    try {
      await post(`/orders/${orderId}/print-bill/`)
      setNotice('Bill sent to the printer.')
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

  const add = (menuItem: MenuItem, jain = false) => {
    const line = items.find((i) => i.menu_item === menuItem.id && i.is_jain === jain && !i.note)
    change([
      line
        ? { id: line.id, quantity: line.quantity + 1 }
        : { menu_item: menuItem.id, ...(jain ? { is_jain: true } : {}) },
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
      />

      {current && <Totals order={current} />}
    </>
  )

  const actions = (
    <>
      {error && <p className="text-sm text-destructive">{error}</p>}

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
      {(status === 'paid' || status === 'cancelled') &&
        // Closed orders are usually opened from history; go back there with its filters.
        (location.key !== 'default' ? (
          <button
            onClick={() => navigate(-1)}
            className="text-center text-sm text-muted-foreground hover:text-foreground"
          >
            Back
          </button>
        ) : (
          <Link to="/floor" className="text-center text-sm text-muted-foreground hover:text-foreground">
            Back to floor
          </Link>
        ))}
    </>
  )

  const panel = 'grid gap-5 rounded-2xl border bg-background p-5'

  // Taking an order: the menu fills the screen and the cart sits on the right.
  if (status === 'open')
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 pb-20 lg:grid-cols-[minmax(0,1fr)_26rem] lg:pb-0">
        <MenuPicker items={items} onAdd={add} busy={run.isPending} />
        <aside id="cart" className={cn(panel, 'scroll-mt-20 lg:sticky lg:top-20')}>
          {summary}
          {actions}
        </aside>
        <CartBar items={items} total={current?.total} />
      </div>
    )

  // Billed, paid or cancelled: the bill (receipt width) beside payment and printing.
  return (
    <div className="mx-auto grid w-full max-w-[68rem] grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
      <section className={panel}>{summary}</section>
      <aside className={cn(panel, 'lg:sticky lg:top-20')}>{actions}</aside>
    </div>
  )
}

/** Phones and tablets: the cart is below the menu, so this bar keeps it one tap away. */
function CartBar({ items, total }: { items: OrderItem[]; total?: string }) {
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
          {unsent > 0 && <p className="text-xs text-amber-700">{unsent} not sent to the kitchen</p>}
        </div>
        <Button
          size="lg"
          onClick={() => document.getElementById('cart')?.scrollIntoView({ behavior: 'smooth' })}
        >
          View order
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

  const query = search.trim().toLowerCase()
  const visible = menu.data.filter(
    (m) =>
      (query ? m.name.toLowerCase().includes(query) : category === null || m.category === category),
  )

  return (
    <section className="grid gap-4">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search the menu"
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
                  <span className="pr-6 text-sm leading-snug font-medium">{m.name}</span>
                  <span className="text-sm text-muted-foreground tabular-nums">{money(m.price)}</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button variant="outline" disabled={props.busy} onClick={() => props.onAdd(m)}>
                      Regular
                    </Button>
                    <Button
                      variant="outline"
                      disabled={props.busy}
                      onClick={() => props.onAdd(m, true)}
                      className="border-emerald-300 text-emerald-800 hover:bg-emerald-50 hover:text-emerald-900"
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
                className={cn(tile, 'hover:border-foreground/40 active:bg-muted disabled:pointer-events-none')}
              >
                <span className="pr-6 text-sm leading-snug font-medium">{m.name}</span>
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
                {money(item.line_total)}
                {unsent !== 0 && (
                  <span className={unsent > 0 ? 'text-amber-600' : 'text-destructive'}>
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
                  onClick={() => props.onChange([{ id: item.id, quantity: item.quantity + 1 }])}
                >
                  <Plus />
                </Button>
              </div>
            ) : (
              <span className="text-sm tabular-nums">× {item.quantity}</span>
            )}
            {props.editable && item.kot_quantity === 0 ? (
              <input
                key={item.note}
                defaultValue={item.note}
                placeholder="Add a note for the kitchen"
                maxLength={255}
                onBlur={(e) => {
                  const note = e.target.value.trim()
                  if (note !== item.note) props.onChange([{ id: item.id, note }])
                }}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                className="col-span-2 mt-1 w-full bg-transparent text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50 focus:text-foreground"
              />
            ) : (
              item.note && <p className="col-span-2 mt-1 text-xs text-muted-foreground">{item.note}</p>
            )}
          </li>
        )
      })}
    </ul>
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
          <dt>Advance · reservation #{order.reservation}</dt>
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
            <div className="flex h-11 w-40 items-center rounded-lg border bg-background pr-1 focus-within:border-ring">
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
  onConfirm: (customer: { customer_name: string; customer_phone: string }) => void
}) {
  const { order } = props
  const [name, setName] = useState(order.customer_name)
  const [phone, setPhone] = useState(order.customer_phone)
  const [touched, setTouched] = useState(false)
  const digits = mobileDigits(phone)
  const phoneError = digits === null && touched ? 'Enter a 10-digit mobile number, or leave it empty.' : ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (digits === null) return
    props.onConfirm({ customer_name: name.trim(), customer_phone: digits })
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
            <p className="text-3xl font-semibold tracking-tight tabular-nums">{money(props.total)}</p>
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
