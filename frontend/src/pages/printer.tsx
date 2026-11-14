import qz from 'qz-tray'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { api, post } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Runs on the laptop the thermal printers are plugged into. Every few seconds it asks
 * the server what is waiting, prints it through QZ Tray, and only then reports it as
 * printed, so an outage delays tickets instead of losing them.
 */

const POLL_MS = 3000
const MAX_HISTORY = 30
const SETTINGS_KEY = 'pos-printer'

interface Settings {
  /** Only KOTs created after this page's first run are printed. Set by the server. */
  since?: string
  width: '48' | '32'
  kotPrinter: string
  billPrinter: string
}
interface Ticket {
  kind: 'kot' | 'bill'
  id: number
  label: string
  /** ESC/POS bytes, base64. */
  ticket: string
}
interface Status {
  state: 'ok' | 'bad' | 'warn'
  title: string
  detail: string
}

function loadSettings(): Settings {
  let saved: Partial<Settings> = {}
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
  } catch {
    // unreadable settings: start fresh
  }
  return { width: '48', kotPrinter: '', billPrinter: '', ...saved }
}

// The server signs QZ Tray's requests when a certificate is configured; otherwise both
// come back empty and QZ Tray asks the user to allow each connection.
qz.security.setCertificatePromise((resolve, reject) => {
  api<{ certificate: string }>('/printing/qz/certificate/').then(
    (r) => resolve(r.certificate || undefined),
    reject,
  )
})
qz.security.setSignatureAlgorithm('SHA512')
qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
  post<{ signature: string }>('/printing/qz/sign/', { message: toSign }).then(
    (r) => resolve(r.signature || undefined),
    reject,
  )
})

const printRaw = (printer: string, ticket: string) =>
  qz.print(qz.configs.create(printer), [
    { type: 'raw', format: 'command', flavor: 'base64', data: ticket },
  ])

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function describe(error: unknown) {
  if (!qz.websocket.isActive()) {
    return "QZ Tray isn't running on this computer. Start it and this page will reconnect."
  }
  return message(error)
}

export function PrinterPage() {
  const [status, setStatus] = useState<Status>({
    state: 'warn',
    title: 'Starting',
    detail: 'Connecting to QZ Tray',
  })
  const [printers, setPrinters] = useState<string[] | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [history, setHistory] = useState<{ label: string; time: string }[]>([])
  const [testing, setTesting] = useState(false)

  // The polling loop outlives renders, so it reads the latest settings from a ref.
  const live = useRef(settings)
  const update = (changes: Partial<Settings>) => {
    live.current = { ...live.current, ...changes }
    setSettings(live.current)
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(live.current))
    } catch {
      setStatus({
        state: 'warn',
        title: 'Settings not saved',
        detail: 'This browser is blocking saved settings.',
      })
    }
  }
  const updateRef = useRef(update)
  useEffect(() => {
    updateRef.current = update
  })

  const addHistory = (label: string) =>
    setHistory((rows) =>
      [{ label, time: new Date().toLocaleTimeString() }, ...rows].slice(0, MAX_HISTORY),
    )

  const connect = async () => {
    if (qz.websocket.isActive()) return
    await qz.websocket.connect({ retries: 1, delay: 1 })
    const found = await qz.printers.find()
    setPrinters(Array.isArray(found) ? found : [found])
  }

  useEffect(() => {
    let busy = false
    let refused = false
    let stopped = false
    // On paper but not yet recorded: printing these again would duplicate the ticket.
    const printedNotSaved = new Map<string, { kind: string; id: number; printer: string }>()

    const saveMarks = async () => {
      for (const [key, mark] of [...printedNotSaved]) {
        await post('/printing/printed/', mark)
        printedNotSaved.delete(key)
      }
    }

    const printPending = async () => {
      const { since, width } = live.current
      const query = new URLSearchParams({ width, ...(since ? { since } : {}) })
      const data = await api<{ now: string; tickets: Ticket[] }>(`/printing/pending/?${query}`)
      // First run on this computer: start from now, so turning this on mid-service
      // doesn't reprint the whole day.
      if (!since) updateRef.current({ since: data.now })
      for (const ticket of data.tickets) {
        const key = `${ticket.kind}:${ticket.id}`
        if (printedNotSaved.has(key)) continue
        const printer = ticket.kind === 'bill' ? live.current.billPrinter : live.current.kotPrinter
        await printRaw(printer, ticket.ticket)
        printedNotSaved.set(key, { kind: ticket.kind, id: ticket.id, printer })
        addHistory(ticket.label)
        await saveMarks()
      }
    }

    const tick = async () => {
      if (busy || refused || stopped) return
      busy = true
      try {
        await connect()
        const { kotPrinter, billPrinter } = live.current
        // Always an explicit choice: a default could quietly send tickets somewhere
        // like "Microsoft Print to PDF" while this page still says Ready.
        if (!kotPrinter || !billPrinter) {
          setStatus({
            state: 'bad',
            title: 'Choose your printers',
            detail: 'Nothing prints until both a KOT and a bill printer are chosen.',
          })
          return
        }
        await saveMarks()
        await printPending()
        setStatus({
          state: 'ok',
          title: 'Ready',
          detail:
            kotPrinter === billPrinter
              ? `KOTs and bills print to ${kotPrinter}`
              : `KOTs print to ${kotPrinter}, bills to ${billPrinter}`,
        })
      } catch (error) {
        if (/blocked|rejected|denied/i.test(message(error))) {
          // Trying again every few seconds would reopen QZ Tray's pop-up forever.
          refused = true
          setStatus({
            state: 'bad',
            title: 'QZ Tray was blocked',
            detail: 'Refresh this page and click Allow in the QZ Tray pop-up.',
          })
        } else {
          setStatus({ state: 'bad', title: 'Printing has stopped', detail: describe(error) })
        }
      } finally {
        busy = false
      }
    }

    // Browsers slow normal timers in background tabs to about once a minute. Worker
    // timers keep their pace, so tickets still print when this isn't the active tab.
    let timer: Worker | undefined
    let release = () => {}
    const start = () => {
      timer = new Worker(
        URL.createObjectURL(new Blob([`setInterval(function(){postMessage(0)},${POLL_MS})`])),
      )
      timer.onmessage = tick
      tick()
    }

    // A second open tab would print everything twice, so only one may run at a time.
    const claim = (retry: boolean) =>
      navigator.locks.request('pos-printer', { ifAvailable: true }, (lock) => {
        if (stopped) return
        if (!lock) {
          // A lock just released by this same tab can take a moment to free up.
          if (retry) setTimeout(() => claim(false), 400)
          else
            setStatus({
              state: 'warn',
              title: 'Already open',
              detail: 'This page is open in another tab. Use that tab to print.',
            })
          return
        }
        start()
        return new Promise<void>((resolve) => (release = resolve))
      })
    claim(true)

    return () => {
      stopped = true
      timer?.terminate()
      release()
    }
  }, [])

  const test = async (printer: string) => {
    if (!printer) {
      setStatus({
        state: 'bad',
        title: 'Choose a printer first',
        detail: 'Pick a printer from the list, then test it.',
      })
      return
    }
    setTesting(true)
    try {
      await connect()
      const query = new URLSearchParams({ printer, width: settings.width })
      const { ticket } = await api<{ ticket: string }>(`/printing/test-ticket/?${query}`)
      await printRaw(printer, ticket)
      addHistory(`Test - ${printer}`)
    } catch (error) {
      setStatus({ state: 'bad', title: 'Test print failed', detail: describe(error) })
    } finally {
      setTesting(false)
    }
  }

  const tone = { ok: 'bg-emerald-500', bad: 'bg-destructive', warn: 'bg-amber-500' }[status.state]
  const select =
    'h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:border-ring disabled:opacity-50'

  const printerField = (label: string, key: 'kotPrinter' | 'billPrinter') => (
    <div className="grid gap-2">
      <label htmlFor={key} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <select
          id={key}
          className={select}
          disabled={!printers}
          // A saved printer that is no longer installed must be chosen again.
          value={printers?.includes(settings[key]) ? settings[key] : ''}
          onChange={(e) => update({ [key]: e.target.value })}
        >
          <option value="">{printers ? 'Choose a printer' : 'Waiting for QZ Tray'}</option>
          {printers?.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <Button
          variant="outline"
          className="h-11 px-4"
          disabled={!printers || testing}
          onClick={() => test(settings[key])}
        >
          Test
        </Button>
      </div>
    </div>
  )

  return (
    <div className="mx-auto grid max-w-xl gap-5">
      <section
        role="status"
        aria-live="polite"
        className="flex items-center gap-4 rounded-2xl border bg-background p-5"
      >
        <span className={cn('size-3 shrink-0 rounded-full', tone)} />
        <div>
          <p className="text-lg font-semibold tracking-tight">{status.title}</p>
          <p className="text-sm text-muted-foreground">{status.detail}</p>
        </div>
      </section>

      <section className="grid gap-5 rounded-2xl border bg-background p-5">
        {printerField('KOT printer', 'kotPrinter')}
        {printerField('Bill printer', 'billPrinter')}
        <div className="grid gap-2">
          <label htmlFor="width" className="text-sm font-medium">
            Paper width
          </label>
          <select
            id="width"
            className={select}
            value={settings.width}
            onChange={(e) => update({ width: e.target.value as Settings['width'] })}
          >
            <option value="48">80 mm (about 3 inches)</option>
            <option value="32">58 mm (about 2 inches)</option>
          </select>
        </div>
        <p className="text-sm text-muted-foreground">
          Keep this page open while the restaurant is taking orders. It prints new KOTs and bills
          automatically.
        </p>
      </section>

      <section className="grid gap-3 rounded-2xl border bg-background p-5">
        <h2 className="text-sm font-medium">Printed since this page opened</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet</p>
        ) : (
          <ul className="divide-y text-sm">
            {history.map((row, index) => (
              <li key={index} className="flex justify-between gap-3 py-2">
                <span className="min-w-0 break-words">{row.label}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{row.time}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
