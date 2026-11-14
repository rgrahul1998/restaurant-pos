import { useEffect, useRef } from 'react'

import { useAuth } from '@/lib/auth'

export interface SocketMessage<T = unknown> {
  event: string
  payload: T
}

/** Subscribe to a backend feed (`/ws/kitchen/`, `/ws/floor/`); reconnects with backoff. */
export function useSocket<T = unknown>(path: string, onMessage: (msg: SocketMessage<T>) => void) {
  const access = useAuth((s) => s.access)
  const handler = useRef(onMessage)
  useEffect(() => {
    handler.current = onMessage
  })

  useEffect(() => {
    if (!access) return
    let socket: WebSocket
    let timer: ReturnType<typeof setTimeout>
    let attempt = 0
    let closed = false

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${scheme}://${location.host}${path}?token=${access}`)
      socket.onopen = () => (attempt = 0)
      socket.onmessage = (e) => handler.current(JSON.parse(e.data))
      socket.onclose = () => {
        if (closed) return
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000))
      }
    }
    connect()

    return () => {
      closed = true
      clearTimeout(timer)
      socket.close()
    }
  }, [path, access])
}
