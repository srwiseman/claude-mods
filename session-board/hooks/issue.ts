import type { Issue } from '../types'

// A reference to an issue found in text: its key as people say it, and where it lives when known
export type IssueRef = { key: string; url?: string; repo?: string; number?: number }

const GITHUB_ISSUE_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/
const GITHUB_PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const TRACKER_URL = /https?:\/\/[\w.-]*(?:linear\.app|atlassian\.net|jira\.[\w.-]+)\/\S*?\b([A-Z][A-Z0-9]+-\d+)\b\S*/
const HASH_NUMBER = /(?:^|[\s(])#(\d{1,7})\b/
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
  const numbered = text.match(ISSUE_NUMBER) ?? text.match(HASH_NUMBER)
  if (numbered?.[1]) {
    return { key: `#${numbered[1]}`, number: Number(numbered[1]) }
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

Reply with JSON only, no prose:
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
