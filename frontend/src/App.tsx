import { lazy, Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from '@/components/app-layout'
import { FloorPage } from '@/pages/floor'
import { HistoryPage } from '@/pages/history'
import { KitchenPage } from '@/pages/kitchen'
import { LoginPage } from '@/pages/login'
import { MenuPage } from '@/pages/menu'
import { OrderPage } from '@/pages/order'
import { OrdersPage } from '@/pages/orders'
import { ReportsPage } from '@/pages/reports'
import { ReservationsPage } from '@/pages/reservations'
import { SettingsPage } from '@/pages/settings'
import { SetupPage } from '@/pages/setup'
import { StaffPage } from '@/pages/staff'

// Only the printing laptop needs the QZ Tray client, so it loads on demand.
const PrinterPage = lazy(() => import('@/pages/printer').then((m) => ({ default: m.PrinterPage })))

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          {/* AppLayout redirects to /login, or to the role's home if the path isn't theirs. */}
          <Route element={<AppLayout />}>
            <Route path="/floor" element={<FloorPage />} />
            <Route
              path="/orders"
              element={
                <OrdersPage
                  title="Open orders"
                  statuses={['open', 'billed']}
                  empty="No open orders."
                  allowNew
                />
              }
            />
            {/* key: /orders/new → /orders/7 must not carry state between orders */}
            <Route path="/orders/new" element={<OrderPage key="new" />} />
            <Route path="/orders/:id" element={<OrderPage />} />
            <Route path="/reservations" element={<ReservationsPage />} />
            <Route path="/kitchen" element={<KitchenPage />} />
            <Route
              path="/billing"
              element={
                <OrdersPage
                  title="Awaiting payment"
                  statuses={['billed']}
                  empty="Nothing is waiting for payment."
                />
              }
            />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/menu" element={<MenuPage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/backup" element={<Navigate to="/settings" replace />} />
            <Route
              path="/printer"
              element={
                <Suspense fallback={null}>
                  <PrinterPage />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/floor" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
