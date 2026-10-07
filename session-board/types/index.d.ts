export type Done = { text: string; at: number }
export type Activity = { edits: number; commands: number }
export type Upcoming = { id: string; label: string; at?: number }
export type Need = { id: string; label: string; at: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Spend = { usd?: number; limits: Limit[] }

declare module 'claude-code' {
  interface PluginState {
    'session-board': { done: Done[]; activity: Activity; upcoming: Upcoming[]; needs: Need[]; spend: Spend }
  }
}
