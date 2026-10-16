import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Board, Layer, Phase } from '../types'
import {
  STAGES,
  applyOutput,
  applyWatch,
  emptyBoard,
  headsOf,
  ordered,
  parseJson,
  phaseOf,
  span,
  stageIndex,
  subcommandOf,
} from './board'

const PANE = 'workstreams-board'
const TITLE = 'Workstreams round'
const board = atom({ plugin: 'workstreams-board', key: 'board' } as const, emptyBoard())
const agents = atom({ plugin: 'workstreams-board', key: 'agents' } as const, [] as AgentRow[])
const autoOpened = atom({ plugin: 'workstreams-board', key: 'autoOpened' } as const, false)
const tick = atom({ plugin: 'workstreams-board', key: 'tick' } as const, 0)

/** Agents a round dispatches: a layer's stream agent and its reviewers. */
const ROUND_AGENT = /workstreams|pr-review/i
const PHASES: Phase[] = ['sweep', 'question', 'stream', 'review', 'tick', 'round-end']

const isActive = (b: Board) => b.layers.length > 0 || b.phase !== null || b.plan !== null

/** The first sign of a round in this session opens the pane, once. */
async function touch($: EngineInterface) {
  const opened = await read($, autoOpened)
  if (opened) return
  await update($, autoOpened, () => true)
  // Nothing draws a pane under -p or an SDK host; the board still fills.
  $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
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

    return next(e)
  })

  on('command.run', { command: 'workstreams-board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Workstreams board opened.' }
  })

  // The round's own reads: rounds, pr-state and intersect print JSON the board folds in.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const sub = subcommandOf(e.command)
    const ran = await next(e)
    if (sub === null || sub === 'watch' || ran.deny !== undefined || ran.isError) return ran
    const stdout = (ran.result as { stdout?: string } | undefined)?.stdout ?? ''
    const out = parseJson(stdout)
    if (out === null) return ran
    const now = await $.clock.now()
    await update($, board, b => applyOutput(b ?? emptyBoard(), sub, out, now))
    await touch($)
    return ran
  }).catch(($, e, next) => next(e))

  // The watch is the round's wake: armed under Monitor, with the plan's branches.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    if (subcommandOf(e.command ?? '') !== 'watch' || ran.deny !== undefined || ran.isError) return ran
    const result = ran.result as { taskId?: string; timeoutMs?: number } | undefined
    const now = await $.clock.now()
    const watch = { taskId: result?.taskId ?? null, heads: headsOf(e.command ?? ''), timeoutMs: result?.timeoutMs ?? null }
    await update($, board, b => applyWatch(b ?? emptyBoard(), watch, now))
    await touch($)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    await update($, board, b => {
      const current = b ?? emptyBoard()
      return current.watch !== null && current.watch.taskId === id ? { ...current, watch: null } : current
    })
    return ran
  }).catch(($, e, next) => next(e))

  // Where the round is: the sub-skill invoked, or the step file the orchestrator read.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const phase = phaseOf({ skill: e.skill })
    if (phase !== null) {
      const now = await $.clock.now()
      await update($, board, b => ({ ...(b ?? emptyBoard()), phase, phaseAt: now }))
      await touch($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const phase = phaseOf({ file_path: e.file_path })
    if (phase !== null) {
      const now = await $.clock.now()
      await update($, board, b => ({ ...(b ?? emptyBoard()), phase, phaseAt: now }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, board)
    const running = await read($, agents)
    await read($, tick)
    const now = await $.clock.now()

    if (!isActive(b)) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No workstreams round seen in this session yet.</Text>
          <Text dimColor>Run /workstreams:start; the board fills from its reads.</Text>
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
      return { text: `watch armed ${span(now - b.watch.armedAt)} ago${left}`, color: 'success' as const }
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
        {b.phase !== null && <Text dimColor>{`  since ${span(now - b.phaseAt)} ago`}</Text>}

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
