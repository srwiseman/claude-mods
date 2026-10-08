// detail: what the turn took (commands, files), shown when the line is hovered
export type Done = { text: string; at: number; detail?: string }
// edits counts the file tools alone; filesChanged is git's count since baseSha, however the files were changed
export type Activity = { edits: number; commands: number; baseSha?: string; filesChanged?: number }
export type Upcoming = { id: string; label: string; at?: number }
export type Need = { id: string; label: string; at: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
// usd as /cost totals it; tokens summed from each turn, so a setup that reports no price still shows use
export type Spend = { usd?: number; limits: Limit[]; tokens?: number; isUnpriced?: boolean }
// The turn running now: what it was asked, what it is doing, and the steps finished so far
export type Live = {
  startedAt: number
  now: number
  request: string
  current?: { id: string; label: string }
  steps: string[]
  edits: number
  commands: number
}
export type Issue = {
  key: string
  title: string
  summary: string
  state?: 'open' | 'closed'
  url?: string
  pr?: { number: number; url: string }
  // Set by the person (named in a prompt or /issue): Claude reading another issue does not replace it
  isPinned?: boolean
  // Named but not read yet: shown by key until its text is found
  isPending?: boolean
  // Fingerprint of the text last summarized, so re-reading the same issue costs nothing
  sourceHash?: string
  at?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': { done: Done[]; activity: Activity; upcoming: Upcoming[]; needs: Need[]; spend: Spend; issue: Issue | null; live: Live | null; isExpanded: boolean }
  }
}
