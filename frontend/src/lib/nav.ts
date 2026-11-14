import type { Role } from './types'

export interface NavItem {
  path: string
  label: string
  roles: Role[]
}

const MANAGEMENT: Role[] = ['admin', 'manager']

// Mirrors the backend permission matrix (apps/core/permissions.py). The backend
// is the authority; this only decides which screens and buttons a role is offered.
export const NAV: NavItem[] = [
  { path: '/floor', label: 'Floor', roles: [...MANAGEMENT, 'cashier', 'waiter'] },
  { path: '/orders', label: 'Orders', roles: [...MANAGEMENT, 'cashier', 'waiter'] },
  { path: '/reservations', label: 'Reservations', roles: [...MANAGEMENT, 'cashier', 'waiter'] },
  { path: '/kitchen', label: 'Kitchen', roles: [...MANAGEMENT, 'kitchen'] },
  { path: '/billing', label: 'Billing', roles: [...MANAGEMENT, 'cashier'] },
  { path: '/history', label: 'History', roles: [...MANAGEMENT, 'cashier'] },
  { path: '/reports', label: 'Reports', roles: [...MANAGEMENT, 'cashier'] },
  { path: '/menu', label: 'Menu', roles: MANAGEMENT },
  { path: '/staff', label: 'Staff', roles: ['admin'] },
  { path: '/settings', label: 'Settings', roles: ['admin'] },
  { path: '/printer', label: 'Printer', roles: [...MANAGEMENT, 'cashier', 'waiter', 'kitchen'] },
]

export const homeFor = (role: Role) => NAV.find((item) => item.roles.includes(role))!.path

/** Create, edit, seat and cancel reservations; waiters only view. */
export const canManageReservations = (role: Role) => MANAGEMENT.includes(role) || role === 'cashier'

export const canBill = (role: Role) => MANAGEMENT.includes(role) || role === 'cashier'
/** Cancelling something the kitchen already has. */
export const canCancelSent = (role: Role) => MANAGEMENT.includes(role)
