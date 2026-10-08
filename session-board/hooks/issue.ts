import type { Issue } from '../types'

// A reference to an issue found in text: its key as people say it, and where it lives when known
// isBare: only a lone #123 named it, too weak to replace an issue already on the board
export type IssueRef = { key: string; url?: string; repo?: string; number?: number; isBare?: boolean }

const GITHUB_ISSUE_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/
const GITHUB_PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const TRACKER_URL = /https?:\/\/[\w.-]*(?:linear\.app|atlassian\.net|jira\.[\w.-]+)\/\S*?\b([A-Z][A-Z0-9]+-\d+)\b\S*/
const HASH_NUMBER = /(?:^|[\s(])#(\d{1,7})\b/g
// Words that make a #123 a pull request, a step or a list item rather than an issue
const NOT_ISSUE_BEFORE = /\b(?:pr|prs|pull|pull request|pull requests|mr|merge request|step|item|line|option|no|number|rank|comment)\s*$/i
const ISSUE_NUMBER = /\b(?:issue|ticket|bug)\s+(?:number\s+|no\.?\s*)?#?(\d{1,7})\b/i
const TRACKER_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/
const ISSUE_WORD = /\b(?:issue|ticket|story|bug|task|epic)s?\b/i
// Look like tracker keys but are not
const NOT_KEYS = /^(?:UTF|ISO|SHA|RFC|HTTP|TLS|SSL|GPT|ES|MP|IPV|CVE|COVID|AES|RSA|PEP|WCAG)-/

// The issue a person's prompt points at, if any; only clear references count, so stray numbers do not
export const findIssueRef = (text: string): IssueRef | null => {
  const url = text.match(GITHUB_ISSUE_URL)
  if (url?.[1] && url[2]) {
    return { key: `#${url[2]}`, url: url[0], repo: url[1], number: Number(url[2]) }
  }
  const tracker = text.match(TRACKER_URL)
  if (tracker?.[1]) {
    return { key: tracker[1], url: tracker[0] }
  }
  const named = text.match(ISSUE_NUMBER)
  if (named?.[1]) {
    return { key: `#${named[1]}`, number: Number(named[1]) }
  }
  for (const hash of text.matchAll(HASH_NUMBER)) {
    const before = text.slice(0, hash.index ?? 0)
    if (hash[1] && !NOT_ISSUE_BEFORE.test(before)) {
      return { key: `#${hash[1]}`, number: Number(hash[1]), isBare: true }
    }
  }
  const key = text.match(TRACKER_KEY)
  if (key?.[1] && !NOT_KEYS.test(key[1]) && ISSUE_WORD.test(text)) {
    return { key: key[1] }
  }
  return null
}

// Tool calls that read an issue: gh, a tracker connector, or fetching an issue page
export const isIssueRead = (tool: string, input: Record<string, unknown>): boolean => {
  if (tool === 'Bash') {
    return /\bgh\s+issue\s+view\b/.test(String(input.command ?? ''))
  }
  if (tool === 'WebFetch') {
    return GITHUB_ISSUE_URL.test(String(input.url ?? '')) || TRACKER_URL.test(String(input.url ?? ''))
  }
  return tool.startsWith('mcp__') && /(?:get|read|fetch|view)_?(?:issue|ticket)|(?:issue|ticket)_?(?:get|read|view)|getjiraissue/i.test(tool)
}

// Which issue a read is for, from the call's own arguments: gh's number, the fetched link, or a connector's id field
export const issueRefFromRead = (tool: string, input: Record<string, unknown>): IssueRef | null => {
  if (tool === 'Bash') {
    const command = String(input.command ?? '')
    const number = command.match(/\bgh\s+issue\s+view\s+#?(\d+)/)?.[1]
    const repo = command.match(/(?:--repo|-R)[\s=]+([\w.-]+\/[\w.-]+)/)?.[1]
    const url = command.match(GITHUB_ISSUE_URL)
    if (url) return findIssueRef(url[0])
    return number ? { key: `#${number}`, number: Number(number), ...(repo ? { repo } : {}) } : null
  }
  if (tool === 'WebFetch') {
    return findIssueRef(String(input.url ?? ''))
  }
  for (const field of ['issue_number', 'issueNumber', 'number']) {
    const value = input[field]
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      return { key: `#${value}`, number: Number(value) }
    }
  }
  for (const field of ['issueIdOrKey', 'issueKey', 'issue_key', 'issueId', 'id', 'key', 'identifier']) {
    const value = input[field]
    if (typeof value === 'string' && /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(value)) {
      return { key: value }
    }
  }
  return null
}

// Text a failed read prints instead of an issue: a CLI or API error, an auth prompt, a miss
const ERROR_TEXT = /unknown json field|graphql:|\bhttp [45]\d\d\b|could not resolve|not found|no such|^error\b|\berror:|failed to|authentication|gh auth login|rate limit|permission denied|bad credentials|requires authentication/i

export const looksLikeError = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed) return true
  // JSON from gh --json or a connector: an error object only when it carries no title
  if (trimmed.startsWith('{')) return /^\{\s*"(error|errors|message)"\s*:/.test(trimmed) && !/"title"\s*:/.test(trimmed)
  // gh issue view's own layout opens with the title: a real issue, whatever it is about
  if (/^title:\s/im.test(trimmed)) return false
  return trimmed.length < 600 && ERROR_TEXT.test(trimmed)
}

// Only an unmistakable CLI failure: a real issue may well be about errors or missing pages
const CLI_FAILURE = /unknown json field|graphql:|gh auth login|bad credentials|requires authentication|could not resolve to an? (issue|repository)/i

// An issue the board took in from an error before reads were checked, kept from showing on
export const isBrokenIssue = (issue: Pick<Issue, 'title' | 'summary'>): boolean => CLI_FAILURE.test(`${issue.title} ${issue.summary}`)

// A short fingerprint of an issue's text, so the same text is never summarized twice
export const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}:${hash.toString(36)}`
}

// The last pull request link in a tool's output (gh pr create prints it)
export const findPrUrl = (text: string): { url: string; number: number } | null => {
  const all = [...text.matchAll(GITHUB_PR_URL)]
  const last = all[all.length - 1]
  return last?.[2] ? { url: last[0], number: Number(last[2]) } : null
}

// The gh command that reads a GitHub issue as JSON
export const githubIssueArgv = (ref: IssueRef): string[] => {
  const argv = ['gh', 'issue', 'view', String(ref.number), '--json', 'number,title,body,state,url']
  return ref.repo ? [...argv, '--repo', ref.repo] : argv
}

export const issuePrompt = (hint: string, text: string) => `Below is an issue (a bug report, feature request or task) from an issue tracker${hint ? `, known as ${hint}` : ''}.

If the text is not an issue at all (an error message, an empty result, a list of many issues), reply exactly {"title": null}.

Otherwise reply with JSON only, no prose:
{"key": the issue's id as people write it (like "#123" or "ENG-42"), or null if none is shown,
 "title": what the issue is about in at most 8 words,
 "summary": one plain sentence of at most 22 words: the problem or ask, and what done looks like,
 "state": "open" or "closed" if the text says, else null}

Issue:
${text.slice(0, 6000)}`

// The model's JSON reply as what the board shows; null when it gives nothing usable
export const parseIssueReply = (reply: string, ref: IssueRef | null): Omit<Issue, 'at'> | null => {
  try {
    const json = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)) as Record<string, unknown>
    const title = typeof json.title === 'string' ? json.title.trim() : ''
    if (!title) {
      return null
    }
    const key = ref?.key ?? (typeof json.key === 'string' && json.key.trim() ? json.key.trim() : 'Issue')
    return {
      key,
      title,
      summary: typeof json.summary === 'string' ? json.summary.trim() : '',
      state: json.state === 'open' || json.state === 'closed' ? json.state : undefined,
      url: ref?.url,
    }
  } catch {
    return null
  }
}
