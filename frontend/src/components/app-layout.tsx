import {
  BookOpen,
  CalendarDays,
  Ellipsis,
  ChartColumn,
  ChefHat,
  History,
  LayoutGrid,
  LogOut,
  Menu,
  Printer,
  ReceiptText,
  Settings,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'

import { useAuth } from '@/lib/auth'
import { canPrintHere } from '@/lib/device-printer'
import { NAV, homeFor } from '@/lib/nav'
import { cn } from '@/lib/utils'

const ICONS: Record<string, typeof LayoutGrid> = {
  '/floor': LayoutGrid,
  '/orders': ReceiptText,
  '/reservations': CalendarDays,
  '/kitchen': ChefHat,
  '/billing': Wallet,
  '/history': History,
  '/reports': ChartColumn,
  '/menu': BookOpen,
  '/staff': Users,
  '/settings': Settings,
  '/printer': Printer,
}

// The four screens that get a tab on a phone, in this order, when a role has more than five.
const PRIMARY = ['/floor', '/orders', '/reservations', '/billing', '/kitchen']

export function AppLayout() {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  // The menu belongs to the page it was opened on: any change of page (a link, the Android
  // back button) closes it.
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = openOn === pathname
  const setOpen = (next: boolean | ((was: boolean) => boolean)) =>
    setOpenOn((typeof next === 'function' ? next(open) : next) ? pathname : null)

  if (!user) return <Navigate to="/login" replace />

  // In the Android app, tickets print straight from the tablet: no Printer page.
  const allowed = NAV.filter(
    (item) => item.roles.includes(user.role) && !(canPrintHere && item.path === '/printer'),
  )
  const current = allowed.find((item) => pathname.startsWith(item.path))
  if (!current) return <Navigate to={homeFor(user.role)} replace />

  // The links sit in the header when they fit: a few (waiter, kitchen) from tablet width,
  // all eleven (admin) from laptop width. Otherwise a menu button opens them.
  const inline = allowed.length <= 5 ? 'md' : 'xl'
  const name = user.first_name || user.username
  // Phones and portrait tablets (below md): a tab bar at the bottom, for every role. Up to
  // five screens fit as tabs; with more, the four used most are tabs and More holds the
  // rest. The order screen has its own back button and cart bar, so the bar steps aside.
  const tabs = inline === 'md'
  const showTabs = !/^\/orders\/./.test(pathname)
  const primary =
    allowed.length <= 5
      ? allowed
      : PRIMARY.map((path) => allowed.find((i) => i.path === path)!).filter(Boolean).slice(0, 4)
  const more = allowed.filter((i) => !primary.includes(i))
  const inMore = more.includes(current)

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="flex h-14 items-center gap-6 px-4 sm:px-8 lg:px-12 xl:px-20">
          <span className="text-sm font-semibold tracking-tight">POS</span>

          <nav className={cn('hidden flex-1 gap-5', inline === 'md' ? 'md:flex' : 'xl:flex')}>
            {allowed.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'relative py-4 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
                    isActive &&
                      'font-medium text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          {/* Small screens: the page you're on (and below md, the tab bar's More). */}
          <span className={cn('flex-1 text-sm font-medium', inline === 'md' ? 'md:hidden' : 'xl:hidden')}>
            {current.label}
          </span>

          <span className="hidden text-sm whitespace-nowrap text-muted-foreground sm:inline">
            {name}
            <span className="mx-1.5">·</span>
            <span className="capitalize">{user.role}</span>
          </span>
          <button
            onClick={logout}
            className={cn(
              'hidden text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
              tabs ? 'inline' : 'xl:inline',
              !tabs && 'max-md:!hidden',
            )}
          >
            Log out
          </button>
          <button
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={cn(
              '-mr-2 grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground',
              tabs ? 'hidden' : 'max-md:hidden xl:hidden',
            )}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>

        {open && (
          <div className="border-t bg-background px-4 pt-3 pb-4 shadow-sm max-md:hidden sm:px-8 lg:px-12">
            <nav className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
              {allowed.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'rounded-lg px-3 py-2.5 text-sm transition-colors',
                      isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-sm text-muted-foreground">
              <span>
                {name} · <span className="capitalize">{user.role}</span>
              </span>
              <button onClick={logout} className="inline-flex items-center gap-1.5 hover:text-foreground">
                <LogOut className="size-4" /> Log out
              </button>
            </div>
          </div>
        )}
      </header>
      {/* Wide, with side margins that grow with the screen; capped on very wide monitors. */}
      <main
        className={cn(
          'mx-auto w-full max-w-[110rem] flex-1 px-4 py-6 sm:px-8 lg:px-12 xl:px-20',
          showTabs && 'max-md:pb-24',
        )}
      >
        <Outlet />
      </main>
      {showTabs && open && more.length > 0 && (
        // More: the remaining screens, above the tab bar. A tap outside closes it.
        <div className="fixed inset-0 z-20 md:hidden">
          <button aria-label="Close" className="absolute inset-0 bg-foreground/20" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-16 mb-[env(safe-area-inset-bottom)] rounded-t-2xl border-t bg-background p-4 shadow-xl">
            <nav className="grid grid-cols-3 gap-2">
              {more.map((item) => {
                const Icon = ICONS[item.path] ?? LayoutGrid
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        'flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl text-sm transition-colors',
                        isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
                      )
                    }
                  >
                    <Icon className="size-5" />
                    {item.label}
                  </NavLink>
                )
              })}
            </nav>
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-sm text-muted-foreground">
              <span>
                {name} · <span className="capitalize">{user.role}</span>
              </span>
              <button onClick={logout} className="inline-flex h-10 items-center gap-1.5 hover:text-foreground">
                <LogOut className="size-4" /> Log out
              </button>
            </div>
          </div>
        </div>
      )}
      {showTabs && (
        <nav
          className="fixed inset-x-0 bottom-0 z-30 grid border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
          style={{ gridTemplateColumns: `repeat(${primary.length + (more.length ? 1 : 0)}, minmax(0, 1fr))` }}
        >
          {primary.map((item) => {
            const Icon = ICONS[item.path] ?? LayoutGrid
            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex h-16 flex-col items-center justify-center gap-1 text-xs transition-colors',
                    isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )
                }
              >
                <Icon className="size-5" />
                {item.label}
              </NavLink>
            )
          })}
          {more.length > 0 && (
            <button
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className={cn(
                'flex h-16 flex-col items-center justify-center gap-1 text-xs transition-colors',
                inMore || open ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              <Ellipsis className="size-5" />
              {inMore ? current.label : 'More'}
            </button>
          )}
        </nav>
      )}
    </div>
  )
}
