// Finds what in a reply is meant to be copied: fenced code blocks, inline code that
// reads as a command, id, path or URL, and bare URLs. Pure, so tests call it directly.

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm
const INLINE = /(`+)([^`\n]+?)\1(?!`)/g
const URL = /\bhttps?:\/\/[^\s<>()[\]`'"]+(?:\([^\s<>()`'"]*\)[^\s<>()[\]`'"]*)*/g
const SHELL = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'fish', 'powershell', 'ps1', 'cmd'])
// Longer blocks are code to read, not something to paste
const MAX_BLOCK_LINES = 40
const MAX_INLINE = 400

// A lone word (`main`, `register`, `true`) names a thing; it is rarely what you paste
const isCopyableInline = (s: string) => s.length >= 3 && s.length <= MAX_INLINE && !/^[A-Za-z]+$/.test(s)

const trimUrl = (u: string) => u.replace(/[.,;:!?*_]+$/, '')

// A shell block that shows `$ ` prompts mixes commands with their output: keep the commands
const PROMPT = /^\s*[$%] /
const unprompt = (code: string, lang: string) => {
  const lines = code.split('\n')
  if (!SHELL.has(lang) || !lines.some(l => PROMPT.test(l))) return code
  return lines.filter(l => PROMPT.test(l)).map(l => l.replace(PROMPT, '')).join('\n')
}

export function extractCopyables(answer: string): string[] {
  const found: { at: number; text: string }[] = []
  // Text outside fences, with fenced spans blanked so offsets still order everything
  let prose = answer

  for (const m of answer.matchAll(FENCE)) {
    const lang = (m[2] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const body = (m[3] ?? '').replace(/\n+$/, '')
    prose = prose.slice(0, m.index) + ' '.repeat(m[0].length) + prose.slice(m.index + m[0].length)
    if (!body.trim() || body.split('\n').length > MAX_BLOCK_LINES || lang === 'diff') continue
    found.push({ at: m.index, text: unprompt(body, lang) })
  }

  const inCode: [number, number][] = []
  for (const m of prose.matchAll(INLINE)) {
    inCode.push([m.index, m.index + m[0].length])
    const text = (m[2] ?? '').trim()
    if (isCopyableInline(text)) found.push({ at: m.index, text })
  }

  for (const m of prose.matchAll(URL)) {
    if (inCode.some(([a, b]) => m.index >= a && m.index < b)) continue
    found.push({ at: m.index, text: trimUrl(m[0]) })
  }

  const seen = new Set<string>()
  return found
    .sort((a, b) => a.at - b.at)
    .map(f => f.text)
    .filter(t => (seen.has(t) ? false : (seen.add(t), true)))
}

// Newest reply's items first, in reading order, then the older ones; no repeats
export function mergeHistory(fresh: readonly string[], old: readonly string[], cap: number): string[] {
  const seen = new Set(fresh)
  return [...fresh, ...old.filter(t => !seen.has(t))].slice(0, cap)
}

// One line for a chip: the first line, squeezed, cut to fit, with a count of the rest
export function chipLabel(text: string, width: number): string {
  const lines = text.split('\n').filter(l => l.trim())
  const more = lines.length > 1 ? ` +${lines.length - 1} lines` : ''
  const first = (lines[0] ?? '').trim().replace(/\s+/g, ' ')
  const room = Math.max(8, width - more.length)
  return (first.length > room ? first.slice(0, room - 1) + '…' : first) + more
}
