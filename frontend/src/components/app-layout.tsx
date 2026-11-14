import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'

import { useAuth } from '@/lib/auth'
import { NAV, homeFor } from '@/lib/nav'
import { cn } from '@/lib/utils'

export function AppLayout() {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()

  if (!user) return <Navigate to="/login" replace />

  const allowed = NAV.filter((item) => item.roles.includes(user.role))
  if (!allowed.some((item) => pathname.startsWith(item.path))) {
    return <Navigate to={homeFor(user.role)} replace />
  }

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-6 border-b bg-background/80 px-5 backdrop-blur">
        <span className="text-sm font-semibold tracking-tight">POS</span>
        <nav className="flex flex-1 gap-5 overflow-x-auto">
          {allowed.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                cn(
                  'relative py-4 text-sm text-muted-foreground transition-colors hover:text-foreground',
                  isActive &&
                    'font-medium text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {user.first_name || user.username}
          <span className="mx-1.5">·</span>
          <span className="capitalize">{user.role}</span>
        </span>
        <button
          onClick={logout}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Log out
        </button>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 p-5">
        <Outlet />
      </main>
    </div>
  )
}
