// What one chip copies, exactly as it is pasted
export type Chip = string

declare module 'claude-code' {
  interface PluginState {
    // items: newest reply's first; isHidden: turned off with /chips
    'copy-chips': { items: Chip[]; isHidden: boolean }
  }
}
