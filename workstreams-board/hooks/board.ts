// The board's model: pure functions from what the workstreams plugin already
// prints to the board the pane draws. Nothing here calls GitHub. The board
// is fed by the reads the model makes on each tick (`rounds`, `pr-state`,
// `intersect`, all with `--json`) and by the watch it arms, so it is exactly
// as fresh as the round's own picture of itself.

import type { Board, Layer, LoopState, Phase } from '../types'

export const emptyBoard = (): Board => ({
  plan: null,
  issues: [],
  phase: null,
  phaseAt: 0,
  layers: [],
  watch: null,
  updatedAt: 0,
})

export type Subcommand = 'rounds' | 'pr-state' | 'intersect' | 'watch'

const SCRIPT = /workstreams\.ts["']?\s+(rounds|pr-state|intersect|watch)\b/

/** The subcommand a shell command runs, when it runs the workstreams script. */
export const subcommandOf = (command: string): Subcommand | null =>
  (SCRIPT.exec(command)?.[1] as Subcommand | undefined) ?? null

/** The branches a `watch --heads a,b` command names. */
export const headsOf = (command: string): string[] => {
  const list = /--heads[= ]+["']?([^\s"']+)/.exec(command)?.[1]
  return list === undefined ? [] : list.split(',').filter(Boolean)
}

const SKILL = /^workstreams:(start|sweep|question|stream|review)$/
const STEP = /skills\/start\/(tick|round-end)\.md$/

/** The phase a Skill call or a Read of a step file puts the round in. */
export const phaseOf = (call: { skill?: string; file_path?: string }): Phase | null => {
  const skill = call.skill === undefined ? null : SKILL.exec(call.skill)?.[1]
  if (skill) return skill as Phase
  const step = call.file_path === undefined ? null : STEP.exec(call.file_path)?.[1]
  return (step as Phase | undefined) ?? null
}

/** A JSON payload from stdout, or null when the model piped it elsewhere. */
export const parseJson = (stdout: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(stdout)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const blank = (head: string, now: number): Layer => ({
  head,
  pullRequest: null,
  title: null,
  headSha: null,
  state: null,
  verdict: null,
  threads: null,
  reviewRound: null,
  stackedOn: null,
  conflicts: [],
  updatedAt: now,
})

const sameLayer = (layer: Layer, pullRequest: number | null, head: string | null): boolean =>
  (pullRequest !== null && layer.pullRequest === pullRequest) ||
  (head !== null && layer.head === head)

const upsert = (
  layers: Layer[],
  key: { pullRequest: number | null; head: string | null },
  now: number,
  change: (layer: Layer) => Layer,
): Layer[] => {
  const at = layers.findIndex(layer => sameLayer(layer, key.pullRequest, key.head))
  if (at === -1) {
    const fresh = blank(key.head ?? `#${key.pullRequest}`, now)
    return [...layers, change({ ...fresh, pullRequest: key.pullRequest })]
  }
  return layers.map((layer, i) => (i === at ? change(layer) : layer))
}

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Folds one subcommand's JSON into the board. */
export const applyOutput = (
  board: Board,
  sub: Subcommand,
  out: Record<string, unknown>,
  now: number,
): Board => {
  if (sub === 'rounds') return applyRounds(board, out, now)
  if (sub === 'pr-state') return applyPrState(board, out, now)
  if (sub === 'intersect') return applyIntersect(board, out, now)
  return board
}

const applyRounds = (board: Board, out: Record<string, unknown>, now: number): Board => {
  const rounds = Array.isArray(out.rounds) ? (out.rounds as Record<string, unknown>[]) : []
  const round = rounds[0]
  if (rounds.length !== 1 || round === undefined) return board
  const issues = Array.isArray(round.issues)
    ? (round.issues as Record<string, unknown>[]).map(issue => num(issue.number)).filter(n => n !== null)
    : []
  const plan = str(round.plan)
  // A different plan is a different round: its layers are not this one's.
  const isNewRound = board.plan !== null && plan !== null && plan !== board.plan
  const base = isNewRound ? emptyBoard() : board
  return { ...base, plan, issues: issues as number[], updatedAt: now }
}

const applyPrState = (board: Board, out: Record<string, unknown>, now: number): Board => {
  const pullRequest = num(out.pullRequest)
  if (pullRequest === null) return board
  const layers = upsert(board.layers, { pullRequest, head: str(out.head) }, now, layer => ({
    ...layer,
    pullRequest,
    head: str(out.head) ?? layer.head,
    title: str(out.title) ?? layer.title,
    headSha: str(out.headSha) ?? layer.headSha,
    state: (str(out.state) as LoopState | null) ?? layer.state,
    verdict: str(out.verdict) ?? layer.verdict,
    threads: num(out.unresolvedThreads) ?? layer.threads,
    reviewRound: num(out.round) ?? layer.reviewRound,
    updatedAt: now,
  }))
  return { ...board, layers, updatedAt: now }
}

type PullReport = {
  number: number
  title: string
  head: string
  headSha: string
  stackedOn: number | null
}

const applyIntersect = (board: Board, out: Record<string, unknown>, now: number): Board => {
  const pulls = (Array.isArray(out.pullRequests) ? out.pullRequests : []) as PullReport[]
  const pairs = (Array.isArray(out.pairs) ? out.pairs : []) as {
    pullRequests: [number, number]
    merge: { result: string }
  }[]

  // The round's pull requests: those it already knows, and any stacked on one
  // of them (a layer opened since the last pr-state read).
  const known = new Set(board.layers.flatMap(layer => (layer.pullRequest === null ? [] : [layer.pullRequest])))
  const heads = new Set(board.layers.map(layer => layer.head))
  const inRound = (pull: PullReport) => known.has(pull.number) || heads.has(pull.head)
  let grew = true
  while (grew) {
    grew = false
    for (const pull of pulls) {
      if (known.has(pull.number)) continue
      if (inRound(pull) || (pull.stackedOn !== null && known.has(pull.stackedOn))) {
        known.add(pull.number)
        grew = true
      }
    }
  }

  const stackedOn = new Map(pulls.map(pull => [pull.number, pull.stackedOn]))
  const streamOf = (n: number): number => {
    const seen = new Set<number>()
    let at = n
    while (!seen.has(at)) {
      seen.add(at)
      const below = stackedOn.get(at)
      if (below === null || below === undefined) return at
      at = below
    }
    return at
  }
  const conflicts = new Map<number, number[]>()
  for (const pair of pairs) {
    if (pair.merge?.result !== 'conflict') continue
    const [a, b] = pair.pullRequests
    // Layers of one stream overlap by design; only two streams collide.
    if (streamOf(a) === streamOf(b)) continue
    conflicts.set(a, [...(conflicts.get(a) ?? []), b])
    conflicts.set(b, [...(conflicts.get(b) ?? []), a])
  }

  let layers = board.layers
  for (const pull of pulls) {
    if (!known.has(pull.number)) continue
    layers = upsert(layers, { pullRequest: pull.number, head: pull.head }, now, layer => ({
      ...layer,
      pullRequest: pull.number,
      head: pull.head,
      title: pull.title ?? layer.title,
      headSha: pull.headSha ?? layer.headSha,
      stackedOn: pull.stackedOn,
      conflicts: conflicts.get(pull.number) ?? [],
      // An open pull request with no pr-state read yet is at least past awaiting-pr.
      state: layer.state ?? 'no-run',
      updatedAt: now,
    }))
  }
  return { ...board, layers, updatedAt: now }
}

/** Records the watch the model armed, and a planned layer for each head it names. */
export const applyWatch = (
  board: Board,
  watch: { taskId: string | null; heads: string[]; timeoutMs: number | null },
  now: number,
): Board => {
  let layers = board.layers
  for (const head of watch.heads) {
    if (layers.some(layer => layer.head === head)) continue
    layers = [...layers, blank(head, now)]
  }
  const deadline = watch.timeoutMs ? now + watch.timeoutMs : null
  return {
    ...board,
    layers,
    watch: { taskId: watch.taskId, armedAt: now, deadline, heads: watch.heads },
    updatedAt: now,
  }
}

/** Layers in stack order: each stream bottom-up, then branches with no pull request yet. */
export const ordered = (layers: Layer[]): Layer[] => {
  const opened = layers.filter(layer => layer.pullRequest !== null)
  const numbers = new Set(opened.map(layer => layer.pullRequest))
  const roots = opened
    .filter(layer => layer.stackedOn === null || !numbers.has(layer.stackedOn))
    .sort((a, b) => (a.pullRequest ?? 0) - (b.pullRequest ?? 0))
  const out: Layer[] = []
  const visit = (layer: Layer) => {
    if (out.includes(layer)) return
    out.push(layer)
    opened
      .filter(child => child.stackedOn === layer.pullRequest)
      .sort((a, b) => (a.pullRequest ?? 0) - (b.pullRequest ?? 0))
      .forEach(visit)
  }
  roots.forEach(visit)
  opened.forEach(visit) // a cycle leaves layers no root reached
  return [...out, ...layers.filter(layer => layer.pullRequest === null)]
}

/** The review loop as the board draws it, left to right. */
export const STAGES = ['PR', 'CI', 'R1', 'fix', 'R2', 'rot', 'done'] as const

/** How far along STAGES a state is: stages before it are passed, it is current. */
export const stageIndex = (state: LoopState | null): number => {
  switch (state) {
    case null:
    case 'awaiting-pr':
      return 0
    case 'no-run':
      return 1
    case 'review-1':
      return 2
    case 'fixing':
      return 3
    case 'review-2':
      return 4
    case 'rot-check':
      return 5
    case 'done':
      return 6
    case 'merged':
    case 'closed':
      return STAGES.length
  }
}

/** Minutes, or seconds under one, for a short "ago" or "left". */
export const span = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
