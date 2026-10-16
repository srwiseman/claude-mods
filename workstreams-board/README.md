# workstreams-board

A live pane for a round of the [workstreams](https://github.com/bje-settings/claude/tree/main/plugins/workstreams) plugin. It shows every layer of the stack and where each one is in the review loop, as the round runs.

```
<plan> milestone 7
1/4 layers done · watch armed 3m ago · 57m left
issues #41 #42 #43 #44

sweep › question › stream ›  review  › tick › round-end

L1 #301 lsp-core
   PR › CI › R1 › fix › R2 › rot ›  done
   CI green
L2 #302 lsp-diag
   PR › CI › R1 ›  fix  › R2 › rot › done
   CI red  3 threads  review round 1  ⚠ collides with #318
L3 lsp-hover
   PR › CI › R1 › fix › R2 › rot › done
   ◐ agent at work
```

- **One row per layer, in stack order.** Each row moves through the review loop that `workstreams.ts pr-state` reports: PR, CI, round 1, fixing, round 2, rot check, done. A merged layer and a closed one say so.
- **Under each layer:** the CI result, unresolved review threads, the review round, whether a layer agent is working on it, and a red **⚠ collides with #n** when `intersect` finds a merge conflict with a pull request from another stream. Layers of the same stack overlap on purpose and are never flagged.
- **The header** shows the round's plan line and issues, how many layers are done, whether the watch that wakes the round is armed (and how long it has left), and which step the round is on.
- Branches the plan names that don't have a pull request yet show as "no pull request yet". Agents that can't be matched to a layer are listed under **Agents** at the bottom.

The pane opens on its own the first time a session does anything with workstreams. `/workstreams-board` opens it any time.

## How it knows

The workstreams plugin keeps no state file. On every tick the model reads the round's state from GitHub by running `workstreams.ts rounds`, `pr-state` and `intersect` with `--json`. This mod reads the JSON those calls already return. It also follows the skill calls, the step files the orchestrator reads, the `watch` the model arms under Monitor, and the session's list of agents.

So the board is exactly as fresh as the round's own picture. It fills in after the first `rounds` or `pr-state` call, and it makes no GitHub calls of its own.

## Install

Needs Claude Code v2.1.287 or later (`claude --version`; `claude update` to upgrade), and the workstreams plugin.

```
claude plugin marketplace add srwiseman/claude-mods
claude plugin install workstreams-board@srwiseman
```

Start a new session, or run `/reload-plugins` in an open one.

## What it can see and do

- Sees the input and output of the main conversation's Bash calls. It only keeps output from commands that run the workstreams script, parsed as JSON. It also sees Skill, Read, Monitor and TaskStop calls, and keeps only the workstreams skill names, step-file names and watch details.
- Reads the session's agent list every 3 seconds while a round is on the board, and keeps the description and status of the workstreams and pr-review agents.
- Everything is kept for the session only. Nothing is written to disk or sent anywhere.
- Never blocks, changes or retries a tool call. If the board itself fails, the call goes through untouched.
