/**
 * Forgiving menu search, so a waiter can type a few letters instead of the whole name.
 * For "Dal Khichdi" (number 12) all of these find it, best matches first:
 *   12        the dish number
 *   dal kh    the start of each word
 *   dk        the initials
 *   al hdi    any part of each word, in order
 *   dl        letters in order, skipping some
 */

interface Searchable {
  name: string
  code: number | null
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

/** Higher is a better match; 0 is no match. */
function score(item: Searchable, query: string, tokens: string[]): number {
  if (/^\d+$/.test(query) && item.code !== null) {
    const code = String(item.code)
    if (code === query) return 1000
    if (code.startsWith(query)) return 900 - code.length
  }

  const nameWords = words(item.name)
  const full = nameWords.join(' ')
  if (full === tokens.join(' ')) return 850
  if (full.startsWith(tokens.join(' '))) return 800

  // Every typed word is found in a later word of the name: "dal kh", "al hdi".
  let at = 0
  let prefixes = true
  for (const token of tokens) {
    while (at < nameWords.length && !nameWords[at].includes(token)) at++
    if (at === nameWords.length) {
      prefixes = false
      at = -1
      break
    }
    if (!nameWords[at].startsWith(token)) prefixes = false
    at++
  }
  if (at !== -1) return prefixes ? 700 : 500

  const compact = tokens.join('')
  const initials = nameWords.map((w) => w[0]).join('')
  if (compact.length >= 2 && initials.startsWith(compact)) return 650
  if (full.includes(tokens.join(' '))) return 450

  // Letters in order, anywhere: "dl", "dlkhc". Tighter matches rank higher.
  if (compact.length < 2) return 0
  const letters = nameWords.join('')
  let first = -1
  let pos = -1
  for (const ch of compact) {
    pos = letters.indexOf(ch, pos + 1)
    if (pos === -1) return 0
    if (first === -1) first = pos
  }
  const spread = pos - first + 1 - compact.length
  return Math.max(100, 300 - spread * 10 - first)
}

/** Items matching `query`, best first; ties keep their menu order. */
export function searchMenu<T extends Searchable>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  const tokens = words(q)
  if (tokens.length === 0) return items
  return items
    .map((item, index) => ({ item, index, score: score(item, q, tokens) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((m) => m.item)
}
