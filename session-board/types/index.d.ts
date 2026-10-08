export type Done = { text: string; at: number }
export type Activity = { edits: number; commands: number }
export type Upcoming = { id: string; label: string; at?: number }
export type Need = { id: string; label: string; at: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Spend = { usd?: number; limits: Limit[] }
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
  at?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': { done: Done[]; activity: Activity; upcoming: Upcoming[]; needs: Need[]; spend: Spend; issue: Issue | null }
  }
}
