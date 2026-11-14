import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { PageState } from '@/components/page-state'
import { buttonVariants } from '@/components/ui/button'
import { useSocket } from '@/hooks/use-socket'
import { apiAll } from '@/lib/api'
import { money, time } from '@/lib/format'
import type { Order } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  title: string
  statuses: Order['status'][]
  empty: string
  allowNew?: boolean
}

export function OrdersPage({ title, statuses, empty, allowNew }: Props) {
  const queryClient = useQueryClient()
  const orders = useQuery({
    queryKey: ['orders', statuses],
    queryFn: () => apiAll<Order>(`/orders/?status__in=${statuses.join(',')}`),
    refetchInterval: 15_000, // takeaway orders don't touch a table, so no socket event
  })
  useSocket('/ws/floor/', () => queryClient.invalidateQueries({ queryKey: ['orders'] }))

  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {allowNew && (
          <Link to="/orders/new" className={buttonVariants({ size: 'lg' })}>
            New takeaway
          </Link>
        )}
      </div>

      {orders.isPending ? (
        <PageState>Loading…</PageState>
      ) : orders.isError ? (
        <PageState error>Could not load orders.</PageState>
      ) : orders.data.length === 0 ? (
        <PageState>{empty}</PageState>
      ) : (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-background">
          {orders.data.map((order) => (
            <li key={order.id}>
              <Link
                to={`/orders/${order.id}`}
                className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {order.table_name ?? 'Takeaway'}
                    <span className="ml-2 font-normal text-muted-foreground">#{order.id}</span>
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {order.customer_name && (
                      <span className="font-medium text-foreground">{order.customer_name} · </span>
                    )}
                    {time(order.created_at)} · {order.waiter_name} ·{' '}
                    {order.items.reduce((n, i) => n + i.quantity, 0)} items
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-xs font-medium first-letter:uppercase',
                    order.status === 'billed'
                      ? 'bg-amber-100 text-amber-900'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {order.status === 'billed' ? 'Awaiting payment' : order.status}
                </span>
                <span className="w-24 text-right font-medium tabular-nums">
                  {money(order.status === 'billed' ? order.balance : order.total)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
