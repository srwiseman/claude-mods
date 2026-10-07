export type Change = { key: string; verb: string; what: string; count: number; at: number }
export type Upcoming = { id: string; label: string; at?: number }
export type Need = { id: string; label: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'session-board': { changes: Change[]; upcoming: Upcoming[]; needs: Need[] }
  }
}
