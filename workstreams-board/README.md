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
- Layers the plan names that don't have a pull request yet show as "no pull request yet", in plan order. Agents that can't be matched to a layer are listed under **Agents** at the bottom.

The pane opens on its own the first time a session does anything with workstreams. `/workstreams-board` opens it any time.

## Joining a round partway through

The board doesn't need to be there from the start:

- **Installed mid-round, or a session resumed with `--resume`:** when the mod loads, it replays the session's history. Every earlier `rounds`, `pr-state` and `intersect` result, plan read, skill call and watch goes through the same code as a live call, so the board appears already filled in. A watch rebuilt this way doesn't know how long it has left, and the current phase doesn't show how long ago it started.
- **A compacted session, or a fresh one:** history can't help, so press **↻ refresh** (or `r` while the pane has focus). It reads the round from GitHub the way a tick does: `rounds`, the plan comment, the round's pull requests, `pr-state` for each, and `intersect`. These are read-only, and they run only when you press it.

## Keeping current

The board updates on every tick the round runs. Between ticks, while an agent builds, it can fall behind, so it also refreshes itself:

- **Auto-refresh**, every 3 minutes by default. If nothing has updated the board for that long, it reads the round's pull requests from GitHub (`gh pr list`, plus `pr-state` for each one). That's how a PR an agent just opened shows up without waiting for the next tick. Auto-refresh never runs `git fetch`, so it can't get in the way of the round's own git work in your checkout. It stops once every layer is done, merged or closed, at round end, and after three failures in a row.
- **↻ refresh** (`r`) does a full read straight away, including `intersect` and its `git fetch`.

The header shows how fresh the board is: `updated 1m ago · auto every 3m`. To change the interval (off, 1, 3, 5 or 10 minutes), use `/config` → workstreams-board, or set `pluginConfigs.workstreams-board.options.autoRefresh` in settings.

None of this costs tokens. The board runs outside the model, and nothing it reads goes into the conversation.

## How it knows

The workstreams plugin keeps no state file. On every tick the model reads the round's state from GitHub by running `workstreams.ts rounds`, `pr-state` and `intersect` with `--json`. This mod reads the JSON those calls already return. It also follows the skill calls, the step files the orchestrator reads, the `watch` the model arms under Monitor, and the session's list of agents.

So between refreshes, the board is exactly as fresh as the round's own picture.

The layers the plan names come from the plan comment's `Branch: \`name\`` lines, the shape bje-settings/claude's plans use. A plan written another way still gets its layers once their pull requests open.

## Install

Needs Claude Code v2.1.287 or later (`claude --version`; `claude update` to upgrade), and the workstreams plugin.

```
claude plugin marketplace add srwiseman/claude-mods
claude plugin install workstreams-board@srwiseman
```

Start a new session, or run `/reload-plugins` in an open one.

## What it can see and do

- Sees the input and output of the main conversation's Bash calls. It keeps output only from commands that run the workstreams script (parsed as JSON), and the branch names in a `gh issue view` that returns the current round's plan. It also sees Skill, Read, Monitor and TaskStop calls, and keeps only the workstreams skill names, step-file names and watch details.
- When it loads, and on `/workstreams-board`, it reads the session's history (the same calls, as above) to rebuild a board it doesn't have yet.
- **Refresh and auto-refresh** are the only things that run commands: `node <workstreams>/scripts/workstreams.ts rounds | pr-state | intersect --json`, `gh pr list` and `gh issue view` in the session's folder. All of them are read-only. Auto-refresh runs only the `gh pr list` and `pr-state` reads (plus `rounds` and the plan while the board has no plan), and never `intersect`. It finds the script from the round's own calls, or from the installed workstreams plugin.
- Reads the session's agent list every 3 seconds while a round is on the board, and keeps the description and status of the workstreams and pr-review agents.
- Everything is kept for the session only. Nothing is written to disk, and nothing leaves the machine except the GitHub reads that Refresh and auto-refresh make.
- Never blocks, changes or retries a tool call. If the board itself fails, the call goes through untouched.
