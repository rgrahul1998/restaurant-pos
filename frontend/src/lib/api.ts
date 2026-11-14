import { useAuth } from './auth'
import type { Paginated, User } from './types'

export class ApiError extends Error {
  status: number
  data: unknown

  constructor(status: number, data: unknown) {
    super(describe(data) ?? `Request failed (${status})`)
    this.status = status
    this.data = data
  }
}

// DRF errors come as {detail}, {field: [messages]} or [messages].
function describe(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return describe(data[0])
  if (data && typeof data === 'object') return describe(Object.values(data)[0])
}

// One refresh at a time, shared by every request that hits a 401 together.
let refreshing: Promise<boolean> | null = null

async function refreshAccess(): Promise<boolean> {
  const { refresh, setTokens, logout } = useAuth.getState()
  if (!refresh) return false
  const res = await fetch('/api/auth/token/refresh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh }),
  })
  if (!res.ok) {
    logout()
    return false
  }
  setTokens((await res.json()).access)
  return true
}

/** fetch() against /api with the access token, refreshing it once on a 401. */
async function authFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const { access } = useAuth.getState()
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      // FormData sets its own multipart boundary.
      ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
      ...init.headers,
    },
  })

  if (res.status === 401 && retry && access) {
    refreshing ??= refreshAccess().finally(() => (refreshing = null))
    if (await refreshing) return authFetch(path, init, false)
  }
  return res
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, init)
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data)
  return data as T
}

/** Download a file the server sends as an attachment, under the name it gives. */
export async function download(path: string): Promise<string> {
  const res = await authFetch(path)
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  const name =
    /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'download'
  const url = URL.createObjectURL(await res.blob())
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}

/** Every page of a list endpoint. */
export async function apiAll<T>(path: string): Promise<T[]> {
  const all: T[] = []
  let next: string | null = path
  while (next) {
    const page: Paginated<T> = await api<Paginated<T>>(next)
    all.push(...page.results)
    const url: URL | null = page.next ? new URL(page.next) : null
    next = url ? (url.pathname + url.search).replace(/^\/api/, '') : null
  }
  return all
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) })

export const remove = (path: string) => api<null>(path, { method: 'DELETE' })

/** POST or PATCH as multipart, for requests that carry a file. */
export function sendForm<T>(method: 'POST' | 'PATCH', path: string, fields: Record<string, unknown>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    body.append(key, value instanceof Blob ? value : value === null ? '' : String(value))
  }
  return api<T>(path, { method, body })
}

export async function login(username: string, password: string): Promise<User> {
  const tokens = await api<{ access: string; refresh: string }>('/auth/token/', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  useAuth.getState().setTokens(tokens.access, tokens.refresh)
  const user = await api<User>('/auth/me/')
  useAuth.getState().setUser(user)
  return user
}
