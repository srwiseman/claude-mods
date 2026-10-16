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

export type Watch = { taskId: string | null; armedAt: number; deadline: number | null; heads: string[] }

export type Board = {
  /** The round's plan line, from `rounds`. */
  plan: string | null
  issues: number[]
  phase: Phase | null
  phaseAt: number
  layers: Layer[]
  watch: Watch | null
  updatedAt: number
}

/** An agent the round dispatched (a layer's stream agent or a reviewer). */
export type AgentRow = { id: string; description: string; type: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'workstreams-board': { board: Board; agents: AgentRow[]; autoOpened: boolean; tick: number }
  }
}
