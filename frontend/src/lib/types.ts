export type Role = 'admin' | 'manager' | 'cashier' | 'waiter' | 'kitchen'

export interface User {
  id: number
  username: string
  first_name: string
  last_name: string
  phone: string
  role: Role
  is_active: boolean
}

export interface Paginated<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

export interface Room {
  id: number
  name: string
  sort_order: number
  is_active: boolean
}

export interface Table {
  id: number
  room: number
  name: string
  seats: number
  status: 'free' | 'occupied' | 'billed'
  /** `M1`, or `M1 + M2` for the primary of a joined group. */
  label: string
  active_order: number | null
  /** The table this one is joined to, if any. */
  merged_into: number | null
  merged_tables: number[]
  is_active: boolean
}

export interface KOTItem {
  id: number
  name: string
  is_jain: boolean
  quantity: number
  cancelled_quantity: number
  note: string
}

export interface KOT {
  id: number
  order: number
  order_type: 'dine_in' | 'takeaway'
  table: string | null
  /** Only older tickets have one: tickets now list every item. */
  station: number | null
  station_name: string | null
  type: 'new' | 'modified' | 'cancelled' | 'partially_cancelled' | 'duplicate'
  status: 'pending' | 'preparing' | 'ready' | 'served'
  note: string
  items: KOTItem[]
  created_at: string
}

export interface Course {
  id: number
  name: string
  sort_order: number
}

export interface Category {
  id: number
  name: string
  /** Where its items are cooked. Every item prints on the KOT either way. */
  station: number | null
  sort_order: number
  is_active: boolean
}

export interface MenuItem {
  id: number
  category: number
  course: number | null
  name: string
  /** Short number waiters type to find the dish; given automatically when left blank. */
  code: number | null
  description: string
  price: string
  /** Absolute URL, or null when there's no photo. */
  image: string | null
  is_vegetarian: boolean
  /** Can be made Jain; the waiter then picks Regular or Jain. */
  has_jain: boolean
  is_special: boolean
  is_available: boolean
}

export interface OrderItem {
  id: number
  menu_item: number
  name: string
  is_jain: boolean
  unit_price: string
  quantity: number
  /** How much of `quantity` the kitchen already knows about. */
  kot_quantity: number
  note: string
  line_total: string
}

export type PaymentMethod = 'cash' | 'card' | 'upi' | 'other'

export interface Payment {
  id: number
  method: PaymentMethod
  amount: string
  reference: string
  created_at: string
}

export interface Order {
  id: number
  order_type: 'dine_in' | 'takeaway'
  status: 'open' | 'billed' | 'paid' | 'cancelled'
  table: number | null
  table_name: string | null
  waiter_name: string
  guests: number
  customer_name: string
  customer_phone: string
  subtotal: string
  discount: string
  /** Set when the discount was given as a percentage. */
  discount_percent: string | null
  total: string
  /** Paid ahead on a reservation; comes off the balance. */
  advance: string
  reservation: number | null
  paid: string
  balance: string
  has_unsent: boolean
  items: OrderItem[]
  payments: Payment[]
  created_at: string
}

/** A cart change: add a menu item, or edit an existing line by id. */
export type OrderLine =
  | { menu_item: number; quantity?: number; note?: string; is_jain?: boolean }
  | { id: number; quantity?: number; note?: string; unit_price?: string }

export interface Station {
  id: number
  name: string
  is_active: boolean
}

export type Occasion = 'birthday' | 'anniversary' | 'corporate' | 'other'

export interface ReservationPayment {
  id: number
  kind: 'advance' | 'refund'
  method: PaymentMethod
  amount: string
  reference: string
  received_by_name: string
  created_at: string
}

export interface Reservation {
  id: number
  customer_name: string
  customer_phone: string
  guests: number
  occasion: Occasion
  note: string
  start_at: string
  end_at: string
  tables: number[]
  table_names: string
  room: number | null
  status: 'confirmed' | 'seated' | 'cancelled' | 'no_show'
  /** Advances less refunds. */
  advance_paid: string
  advance_outcome: '' | 'refunded' | 'forfeited'
  cancel_reason: string
  payments: ReservationPayment[]
  order: number | null
  created_by_name: string
}

export interface TableAvailability {
  table: number
  name: string
  room: number
  seats: number
  booked_by: { id: number; customer_name: string; start_at: string; end_at: string } | null
}
