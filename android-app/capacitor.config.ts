import type { CapacitorConfig } from '@capacitor/cli'

// The app opens the POS site. POS_URL points a test build elsewhere, e.g. the dev server
// on an emulator: POS_URL=http://localhost:5173 npm run build (plus `adb reverse tcp:5173 tcp:5173`).
const url = process.env.POS_URL ?? 'https://34-93-36-245.sslip.io'

const config: CapacitorConfig = {
  appId: 'com.restaurantpos.app',
  appName: 'Restaurant POS',
  webDir: 'www',
  server: {
    url,
    cleartext: url.startsWith('http://'),
    errorPath: 'offline.html',
  },
}

export default config
