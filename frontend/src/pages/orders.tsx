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
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">
          {title}
          {orders.data && orders.data.length > 0 && (
            <span className="ml-2 font-normal text-muted-foreground">{orders.data.length}</span>
          )}
        </h1>
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
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
          {orders.data.map((order) => {
            const billed = order.status === 'billed'
            const count = order.items.reduce((n, i) => n + i.quantity, 0)
            return (
              <li key={order.id}>
                <Link
                  to={`/orders/${order.id}`}
                  className={cn(
                    'flex h-full flex-col gap-4 rounded-2xl border bg-background p-5 transition-colors hover:border-foreground/30',
                    billed && 'border-warning/50 bg-warning/5',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-semibold tracking-tight">
                        {order.table_name ?? 'Takeaway'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        #{order.id} · {time(order.created_at)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium first-letter:uppercase',
                        billed ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {billed ? 'Awaiting payment' : order.status}
                    </span>
                  </div>
                  <p className="min-w-0 truncate text-sm text-muted-foreground">
                    {order.customer_name && (
                      <span className="font-medium text-foreground">{order.customer_name} · </span>
                    )}
                    {order.waiter_name} · {count} {count === 1 ? 'item' : 'items'}
                  </p>
                  <p className="mt-auto text-right text-lg font-semibold tabular-nums">
                    {money(billed ? order.balance : order.total)}
                  </p>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
