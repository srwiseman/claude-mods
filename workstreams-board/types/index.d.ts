/** The review-loop states `workstreams.ts pr-state` names. */
export type LoopState =
  | 'awaiting-pr'
  | 'no-run'
  | 'review-1'
  | 'fixing'
  | 'review-2'
  | 'rot-check'
  | 'done'
  | 'merged'
  | 'closed'

/** The steps of a round, from the skill the model last invoked or read. */
export type Phase = 'start' | 'sweep' | 'question' | 'stream' | 'review' | 'tick' | 'round-end'

/** One layer of the round: a planned branch, a pull request, or both. */
export type Layer = {
  /** The head branch; the key a layer is known by before it has a pull request. */
  head: string
  pullRequest: number | null
  title: string | null
  headSha: string | null
  state: LoopState | null
  verdict: string | null
  threads: number | null
  reviewRound: number | null
  stackedOn: number | null
  /** Pull requests this one's merge conflicts with, from `intersect`. */
  conflicts: number[]
  updatedAt: number
}

/** The watch that wakes the round. A watch rebuilt from history has no armedAt or deadline. */
export type Watch = { taskId: string | null; armedAt: number | null; deadline: number | null; heads: string[] }

export type Board = {
  /** The round's plan line, from `rounds`. */
  plan: string | null
  issues: number[]
  phase: Phase | null
  /** When the phase began; null when it was rebuilt from history. */
  phaseAt: number | null
  layers: Layer[]
  watch: Watch | null
  /** The workstreams script, as the round last ran it: what Refresh runs. */
  script: string | null
  updatedAt: number
}

/** A Refresh in flight, and what the last one came to. */
export type Refresh = { isBusy: boolean; note: string | null }

/** An agent the round dispatched (a layer's stream agent or a reviewer). */
export type AgentRow = { id: string; description: string; type: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'workstreams-board': { board: Board; agents: AgentRow[]; autoOpened: boolean; tick: number; refresh: Refresh }
  }
}
