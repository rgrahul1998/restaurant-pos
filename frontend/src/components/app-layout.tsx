import { LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'

import { useAuth } from '@/lib/auth'
import { NAV, homeFor } from '@/lib/nav'
import { cn } from '@/lib/utils'

export function AppLayout() {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)

  if (!user) return <Navigate to="/login" replace />

  const allowed = NAV.filter((item) => item.roles.includes(user.role))
  const current = allowed.find((item) => pathname.startsWith(item.path))
  if (!current) return <Navigate to={homeFor(user.role)} replace />

  // The links sit in the header when they fit: a few (waiter, kitchen) from tablet width,
  // all eleven (admin) from laptop width. Otherwise a menu button opens them.
  const inline = allowed.length <= 5 ? 'md' : 'xl'
  const name = user.first_name || user.username

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
          {/* Small screens: the page you're on, and the menu button. */}
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
              'hidden text-sm text-muted-foreground transition-colors hover:text-foreground',
              inline === 'md' ? 'md:inline' : 'xl:inline',
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
              inline === 'md' ? 'md:hidden' : 'xl:hidden',
            )}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>

        {open && (
          <div className="border-t bg-background px-4 pt-3 pb-4 shadow-sm sm:px-8 lg:px-12">
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
      <main className="mx-auto w-full max-w-[110rem] flex-1 px-4 py-6 sm:px-8 lg:px-12 xl:px-20">
        <Outlet />
      </main>
    </div>
  )
}
