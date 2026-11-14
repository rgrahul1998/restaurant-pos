import { Capacitor, registerPlugin } from '@capacitor/core'

import { post } from './api'

/**
 * Printing straight to a network printer from the Android app (android-app/). A browser
 * can't open a connection to a printer, so on the web this is off and the laptop's
 * Printer page prints instead.
 */

interface DirectPrintPlugin {
  /** Sends raw ESC/POS bytes (base64) to host:port; rejects if the printer can't be reached. */
  print(options: { host: string; port: number; data: string }): Promise<void>
}

const DirectPrint = registerPlugin<DirectPrintPlugin>('DirectPrint')

/** A ticket the server handed this device to print (printing.services.for_device). */
export interface DeviceTicket {
  kind: 'kot' | 'bill'
  id: number
  label: string
  ticket: string
  host: string
  port: number
}

/** True inside the Android app. */
export const canPrintHere = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('DirectPrint')

/** Sends raw ticket bytes to a printer, e.g. a test page from Settings. */
export const printRaw = (host: string, port: number, data: string) =>
  DirectPrint.print({ host, port, data })

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Prints each ticket and tells the server it's on paper. Returns a message for the ones
 * that didn't print; the server lets the Printer page print those after 30 seconds.
 */
export async function printHere(tickets: DeviceTicket[]): Promise<string | null> {
  const failed: string[] = []
  for (const t of tickets) {
    try {
      await printRaw(t.host, t.port, t.ticket)
    } catch (error) {
      failed.push(`${t.label} (${reason(error)})`)
      continue
    }
    // On paper: record it, or the Printer page would print it again once the claim ends.
    await post('/printing/printed/', { kind: t.kind, id: t.id, printer: t.host }).catch(() =>
      post('/printing/printed/', { kind: t.kind, id: t.id, printer: t.host }).catch(() => {}),
    )
  }
  if (!failed.length) return null
  return `Not printed: ${failed.join(', ')}. Check the printer is on and has paper; the Printer page will print it if it's open.`
}
