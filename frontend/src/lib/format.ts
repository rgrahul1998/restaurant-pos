// The one place that knows the currency.
const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})

export const money = (value: string | number) => currency.format(Number(value))

export const time = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
