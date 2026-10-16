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
  phaseAt: null,
  layers: [],
  watch: null,
  script: null,
  updatedAt: 0,
})

export const isActive = (board: Board): boolean =>
  board.layers.length > 0 || board.phase !== null || board.plan !== null

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

/** Records the watch the model armed, and a planned layer for each head it names.
 *  `armedAt` is null for a watch rebuilt from history, whose start nobody knows. */
export const applyWatch = (
  board: Board,
  watch: { taskId: string | null; heads: string[]; timeoutMs: number | null; armedAt: number | null },
  now: number,
): Board => {
  let layers = board.layers
  for (const head of watch.heads) {
    if (layers.some(layer => layer.head === head)) continue
    layers = [...layers, blank(head, now)]
  }
  const deadline = watch.armedAt !== null && watch.timeoutMs ? watch.armedAt + watch.timeoutMs : null
  return {
    ...board,
    layers,
    watch: { taskId: watch.taskId, armedAt: watch.armedAt, deadline, heads: watch.heads },
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

const PLAN_BRANCH = /Branch:\s*`([^`]+)`/g

/**
 * The layers a plan comment names, as planned branches in plan order. The
 * plan's shape is each repository's own; this reads the `Branch: \`name\``
 * lines the bje-settings plan shape writes, and adds nothing where it finds none.
 */
export const applyPlan = (board: Board, text: string, now: number): Board => {
  const heads = [...text.matchAll(PLAN_BRANCH)].map(match => match[1]!).filter(Boolean)
  if (heads.length === 0) return board
  let layers = board.layers
  for (const head of heads) {
    if (!layers.some(layer => layer.head === head)) layers = [...layers, blank(head, now)]
  }
  return layers === board.layers ? board : { ...board, layers, updatedAt: now }
}

const ISSUE_VIEW = /\bgh issue view\b/

/** One tool call as the board reads it: a live one, or one from the session's history. */
export type Call = {
  tool: string
  input: Record<string, unknown>
  result?: unknown
  text?: string
  isError?: boolean
}

const SCRIPT_PATH = /(["']?)(\/[^"'\s]*\/scripts\/workstreams\.ts)\1/

/** The script path a command runs, for Refresh to run it the same way. */
export const scriptOf = (command: string): string | null => SCRIPT_PATH.exec(command)?.[2] ?? null

const stdoutOf = (call: Call): string => {
  const result = call.result as { stdout?: unknown } | undefined
  return typeof result?.stdout === 'string' ? result.stdout : (call.text ?? '')
}

/**
 * Folds one finished tool call into the board. Live calls and replayed ones
 * go through here alike, so the board rebuilt from history is the board the
 * live hooks would have drawn. `isReplay` marks times nobody recorded.
 */
export const foldCall = (board: Board, call: Call, now: number, isReplay = false): Board => {
  const at = isReplay ? null : now
  switch (call.tool) {
    case 'Bash': {
      const command = str(call.input.command) ?? ''
      const sub = subcommandOf(command)
      // The orchestrator reads the plan comment off a round issue.
      if (sub === null && ISSUE_VIEW.test(command) && !call.isError) {
        const text = stdoutOf(call)
        const isThisPlan = board.plan !== null && text.trimStart().startsWith(board.plan)
        return isThisPlan ? applyPlan(board, text, now) : board
      }
      if (sub === null || call.isError) return board
      const script = scriptOf(command) ?? board.script
      const out = sub === 'watch' ? null : parseJson(stdoutOf(call))
      const next = script === board.script ? board : { ...board, script }
      return out === null || sub === 'watch' ? next : applyOutput(next, sub, out, now)
    }
    case 'Monitor': {
      const command = str(call.input.command) ?? ''
      if (subcommandOf(command) !== 'watch' || call.isError) return board
      const result = call.result as { taskId?: unknown; timeoutMs?: unknown } | undefined
      const script = scriptOf(command) ?? board.script
      return applyWatch(
        { ...board, script },
        { taskId: str(result?.taskId), heads: headsOf(command), timeoutMs: num(result?.timeoutMs), armedAt: at },
        now,
      )
    }
    case 'TaskStop': {
      const id = str(call.input.task_id) ?? str(call.input.shell_id)
      return board.watch !== null && id !== null && board.watch.taskId === id ? { ...board, watch: null } : board
    }
    case 'Skill':
    case 'Read': {
      const phase = phaseOf({ skill: str(call.input.skill) ?? undefined, file_path: str(call.input.file_path) ?? undefined })
      return phase === null ? board : { ...board, phase, phaseAt: at }
    }
    default:
      return board
  }
}

/** A row of the session's history, as `$.session.messages()` gives it. */
export type Row = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true }[]
}

const ENDED = /\b(completed|failed|killed|stopped|exited|expired|timed out)\b/i

/**
 * The board rebuilt from the session's history: every call the round made
 * before this mod was loaded, folded in order. A user row that reports the
 * watch's task ended (a task notification) takes the watch down.
 */
export const replay = (rows: readonly Row[], now: number): Board => {
  let board = emptyBoard()
  for (const row of rows) {
    if (row.role === 'assistant') {
      for (const use of row.toolUses) {
        if (use.result === undefined && use.text === undefined) continue
        board = foldCall(board, use, now, true)
      }
    } else {
      const id = board.watch?.taskId
      if (id && row.text.includes(id) && ENDED.test(row.text)) board = { ...board, watch: null }
    }
  }
  return board
}

/** One pull request from `gh pr list --json number,headRefName,closingIssuesReferences`. */
export type ListedPull = {
  number: number
  headRefName: string
  closingIssuesReferences?: readonly { number: number }[]
}

/**
 * The round's pull requests, as the orchestrator finds them: each that closes
 * a round issue, or whose head is a branch the board knows, plus every one the
 * board already holds. When one branch has several, the newest is its layer's.
 */
export const roundPullRequests = (board: Board, pulls: readonly ListedPull[]): number[] => {
  const issues = new Set(board.issues)
  const heads = new Set(board.layers.map(layer => layer.head))
  const newest = new Map<string, number>()
  for (const pull of [...pulls].sort((a, b) => b.number - a.number)) {
    const closes = (pull.closingIssuesReferences ?? []).some(ref => issues.has(ref.number))
    if ((closes || heads.has(pull.headRefName)) && !newest.has(pull.headRefName)) {
      newest.set(pull.headRefName, pull.number)
    }
  }
  const known = board.layers.flatMap(layer => (layer.pullRequest === null ? [] : [layer.pullRequest]))
  return [...new Set([...newest.values(), ...known])].sort((a, b) => a - b)
}
