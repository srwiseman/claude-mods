import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Board, Layer, Phase, Refresh } from '../types'
import {
  STAGES,
  applyOutput,
  applyPlan,
  emptyBoard,
  foldCall,
  isActive,
  ordered,
  parseJson,
  replay,
  roundPullRequests,
  span,
  stageIndex,
  subcommandOf,
} from './board'
import type { Call, ListedPull, Row } from './board'

const PANE = 'workstreams-board'
const TITLE = 'Workstreams round'
const board = atom({ plugin: 'workstreams-board', key: 'board' } as const, emptyBoard())
const agents = atom({ plugin: 'workstreams-board', key: 'agents' } as const, [] as AgentRow[])
const autoOpened = atom({ plugin: 'workstreams-board', key: 'autoOpened' } as const, false)
const tick = atom({ plugin: 'workstreams-board', key: 'tick' } as const, 0)
const refreshing = atom({ plugin: 'workstreams-board', key: 'refresh' } as const, { isBusy: false, note: null } as Refresh)

/** Agents a round dispatches: a layer's stream agent and its reviewers. */
const ROUND_AGENT = /workstreams|pr-review/i
const PHASES: Phase[] = ['sweep', 'question', 'stream', 'review', 'tick', 'round-end']

/** The first sign of a round in this session opens the pane, once. */
async function touch($: EngineInterface) {
  const opened = await read($, autoOpened)
  if (opened) return
  await update($, autoOpened, () => true)
  // Nothing draws a pane under -p or an SDK host; the board still fills.
  $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

/** Folds one live call into the board, and opens the pane when it was the round's. */
async function fold($: EngineInterface, call: Call) {
  const now = await $.clock.now()
  let changed = false
  await update($, board, b => {
    const before = b ?? emptyBoard()
    const after = foldCall(before, call, now)
    changed = after !== before
    return after
  })
  if (changed) await touch($)
}

/**
 * Rebuilds the board from the session's history when it has nothing yet: a
 * mod installed mid-round, or a session resumed with --resume. A reload keeps
 * the board (it is the host's state), so this only fills an empty one.
 */
async function rebuild($: EngineInterface) {
  if (isActive(await read($, board))) return
  const rows = (await $.session.messages()) as unknown as Row[]
  const rebuilt = replay(rows, await $.clock.now())
  if (!isActive(rebuilt)) return
  await update($, board, b => (isActive(b ?? emptyBoard()) ? (b as Board) : rebuilt))
  await touch($)
}

/** The workstreams script: as the round last ran it, else the installed plugin's newest. */
async function findScript($: EngineInterface): Promise<string | null> {
  const known = (await read($, board)).script
  if (known !== null) return known
  const found = await $.process.run(
    ['sh', '-c', 'ls -t ~/.claude/plugins/cache/*/workstreams/*/scripts/workstreams.ts 2>/dev/null | head -1'],
    { timeoutMs: 10_000 },
  )
  return found.stdout.trim() || null
}

/**
 * Reads the round afresh, the way a tick does: rounds, the round's pull
 * requests, pr-state for each, intersect. For a board history cannot give
 * (a compacted session). Read-only, and only when the person presses it.
 */
async function refresh($: EngineInterface) {
  const busy = await read($, refreshing)
  if (busy.isBusy) return
  await update($, refreshing, () => ({ isBusy: true, note: 'Refreshing…' }))
  const say = (note: string) => update($, refreshing, () => ({ isBusy: false, note }))
  try {
    const script = await findScript($)
    if (script === null) return void (await say('Could not find the workstreams plugin.'))
    const cwd = await $.session.cwd()
    const run = (args: string[]) => $.process.run(['node', script, ...args, '--json'], { cwd, timeoutMs: 120_000 })
    const foldOut = async (sub: 'rounds' | 'pr-state' | 'intersect', stdout: string) => {
      const out = parseJson(stdout)
      if (out === null) return
      const now = await $.clock.now()
      await update($, board, b => applyOutput({ ...(b ?? emptyBoard()), script }, sub, out, now))
    }

    const rounds = await run(['rounds'])
    const roundCount = (parseJson(rounds.stdout)?.rounds as unknown[] | undefined)?.length ?? 0
    await foldOut('rounds', rounds.stdout)

    // The plan comment names each layer's branch, before any has a pull request.
    const planned = await read($, board)
    const first = planned.issues[0]
    if (planned.plan !== null && first !== undefined) {
      const filter = `[.comments[].body | select(startswith(${JSON.stringify(planned.plan)}))] | last // ""`
      const plan = await $.process.run(['gh', 'issue', 'view', String(first), '--json', 'comments', '--jq', filter], {
        cwd,
        timeoutMs: 60_000,
      })
      const now = await $.clock.now()
      await update($, board, b => applyPlan(b ?? emptyBoard(), plan.stdout, now))
    }

    const listed = await $.process.run(
      ['gh', 'pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,headRefName,closingIssuesReferences'],
      { cwd, timeoutMs: 60_000 },
    )
    let pulls: ListedPull[] = []
    try {
      pulls = JSON.parse(listed.stdout) as ListedPull[]
    } catch {
      pulls = []
    }
    const numbers = roundPullRequests(await read($, board), pulls)
    for (const n of numbers) await foldOut('pr-state', (await run(['pr-state', String(n)])).stdout)
    await foldOut('intersect', (await run(['intersect'])).stdout)

    const current = await read($, board)
    if (!isActive(current)) {
      return void (await say(roundCount > 1 ? `${roundCount} rounds in flight; run /workstreams:start to pick one.` : 'No round in flight here.'))
    }
    await say(`Refreshed ${numbers.length} pull request${numbers.length === 1 ? '' : 's'} from GitHub.`)
  } catch (err) {
    await say(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workstreams-board',
      description: 'Show the workstreams round board: each layer through the review loop',
    })

    // The agents list and the "ago" times change with no event of their own.
    $.clock.every(3000, async () => {
      if (!isActive(await read($, board))) return
      const list = (await $.agent.list())
        .filter(agent => ROUND_AGENT.test(agent.type) || ROUND_AGENT.test(agent.description))
        .map(agent => ({ id: agent.id, description: agent.description, type: agent.type, status: agent.status }))
      const before = await read($, agents)
      if (JSON.stringify(before) !== JSON.stringify(list)) await update($, agents, () => list)
    })
    $.clock.every(30_000, async () => {
      if (isActive(await read($, board))) await update($, tick, n => n + 1)
    })

    const ran = await next(e)
    await rebuild($).catch(() => undefined)
    return ran
  })

  on('command.run', { command: 'workstreams-board' }, async $ => {
    await rebuild($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Workstreams board opened.' }
  })

  // The round's own reads (rounds, pr-state, intersect print JSON), the watch
  // it arms under Monitor, and its stop. Each hook only observes: it hands the
  // call on untouched, and a board that fails never fails the call.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const isRound = subcommandOf(e.command) !== null || /\bgh issue view\b/.test(e.command)
    if (!isRound || ran.deny !== undefined) return ran
    await fold($, { tool: 'Bash', input: e, result: ran.result, isError: ran.isError === true })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    if (subcommandOf(e.command ?? '') !== 'watch' || ran.deny !== undefined) return ran
    await fold($, { tool: 'Monitor', input: e, result: ran.result, isError: ran.isError === true })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    await fold($, { tool: 'TaskStop', input: e })
    return ran
  }).catch(($, e, next) => next(e))

  // Where the round is: the sub-skill invoked, or the step file the orchestrator read.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    await fold($, { tool: 'Skill', input: e })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    await fold($, { tool: 'Read', input: e })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, board)
    const r = await read($, refreshing)
    const running = await read($, agents)
    await read($, tick)
    const now = await $.clock.now()

    if (!isActive(b)) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No workstreams round seen in this session yet.</Text>
          <Text dimColor>Run /workstreams:start, or read a round in flight from GitHub:</Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>
              {r.isBusy ? 'Refreshing…' : 'Refresh'}
            </Button>
            {r.note !== null && !r.isBusy && <Text dimColor>{r.note}</Text>}
          </Box>
        </Box>
      )
    }

    const layers = ordered(b.layers)
    const agentFor = (layer: Layer) =>
      running.find(
        agent =>
          agent.description.includes(layer.head) ||
          (layer.pullRequest !== null && agent.description.includes(`#${layer.pullRequest}`)),
      )
    const claimed = new Set(layers.map(agentFor).filter(Boolean))
    const loose = running.filter(agent => !claimed.has(agent))
    const done = layers.filter(layer => layer.state === 'done' || layer.state === 'merged').length
    const isBusy = (status: string) => status === 'running' || status === 'pending' || status === 'waiting'

    const watchText = (() => {
      if (b.watch === null) return { text: 'no watch', color: 'subtle' as const }
      if (b.watch.deadline !== null && b.watch.deadline <= now) return { text: 'watch expired', color: 'warning' as const }
      const left = b.watch.deadline === null ? '' : ` · ${span(b.watch.deadline - now)} left`
      const ago = b.watch.armedAt === null ? '' : ` ${span(now - b.watch.armedAt)} ago`
      return { text: `watch armed${ago}${left}`, color: 'success' as const }
    })()

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {b.plan ?? 'Round in flight'}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>
            {done}/{layers.length} layers done
          </Text>
          <Text dimColor>·</Text>
          <Text color={watchText.color}>{watchText.text}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" hotkey="r" plain dimColor onPress={() => void refresh($)}>
            {r.isBusy ? '↻ refreshing…' : '↻ refresh'}
          </Button>
          {r.note !== null && !r.isBusy && <Text dimColor>{r.note}</Text>}
        </Box>
        {b.issues.length > 0 && (
          <Text dimColor wrap="truncate-end">
            issues {b.issues.map(n => `#${n}`).join(' ')}
          </Text>
        )}

        <Box flexDirection="row" gap={1} marginTop={1}>
          {PHASES.map((phase, i) => (
            <Box key={phase} flexDirection="row" gap={1}>
              {i > 0 && <Text dimColor>›</Text>}
              {phase === b.phase ? (
                <Text color="claude" bold inverse>
                  {` ${phase} `}
                </Text>
              ) : (
                <Text dimColor>{phase}</Text>
              )}
            </Box>
          ))}
        </Box>
        {b.phase !== null && b.phaseAt !== null && <Text dimColor>{`  since ${span(now - b.phaseAt)} ago`}</Text>}

        {layers.map((layer, i) => {
          const agent = agentFor(layer)
          const label = layer.pullRequest === null ? layer.head : `#${layer.pullRequest} ${layer.head}`
          return (
            <Box key={layer.head} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text bold>{`L${i + 1}`}</Text>
                <Text wrap="truncate-end">{label}</Text>
              </Box>
              <Box flexDirection="row" gap={1} paddingLeft={3}>
                {strip(Text, Box, layer)}
              </Box>
              <Box flexDirection="row" gap={1} paddingLeft={3}>
                {layer.pullRequest === null && !agent && <Text dimColor>no pull request yet</Text>}
                {agent && (
                  <Text color={isBusy(agent.status) ? 'warning' : 'subtle'}>
                    {isBusy(agent.status) ? '◐ agent at work' : `agent ${agent.status}`}
                  </Text>
                )}
                {layer.verdict !== null && <Text color={verdictColor(layer.verdict)}>{`CI ${layer.verdict}`}</Text>}
                {layer.threads !== null && layer.threads > 0 && (
                  <Text color="warning">{`${layer.threads} thread${layer.threads === 1 ? '' : 's'}`}</Text>
                )}
                {layer.reviewRound !== null && layer.reviewRound > 0 && (
                  <Text dimColor>{`review round ${layer.reviewRound}`}</Text>
                )}
                {layer.conflicts.length > 0 && (
                  <Text color="error" bold>
                    {`⚠ collides with ${layer.conflicts.map(n => `#${n}`).join(' ')}`}
                  </Text>
                )}
              </Box>
            </Box>
          )
        })}

        {loose.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Agents</Text>
            {loose.map(agent => (
              <Text key={agent.id} color={isBusy(agent.status) ? 'warning' : 'subtle'} wrap="truncate-end">
                {`${isBusy(agent.status) ? '◐' : '·'} ${agent.description} (${agent.status})`}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

const verdictColor = (verdict: string) =>
  verdict === 'green' ? 'success' : verdict === 'red' ? 'error' : verdict === 'pending' ? 'warning' : 'subtle'

/** The review loop for one layer: passed stages green, the current one lit. */
const strip = (Text: any, Box: any, layer: Layer) => {
  if (layer.state === 'merged') return <Text color="merged">{STAGES.join(' › ')} · merged</Text>
  if (layer.state === 'closed') return <Text dimColor strikethrough>{`${STAGES.join(' › ')} · closed`}</Text>
  const at = stageIndex(layer.state)
  return (
    <Box flexDirection="row" gap={1}>
      {STAGES.map((stage, i) => (
        <Box key={stage} flexDirection="row" gap={1}>
          {i > 0 && <Text dimColor>›</Text>}
          {i < at ? (
            <Text color="success">{stage}</Text>
          ) : i === at ? (
            <Text color={stage === 'done' ? 'success' : stage === 'fix' ? 'error' : 'warning'} bold inverse>
              {` ${stage} `}
            </Text>
          ) : (
            <Text dimColor>{stage}</Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
