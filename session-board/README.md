# session-board

A **Session** pane beside the Claude Code transcript that shows, at a glance, what you're working on, what's happening, what needs you, and what got done.

```
╭ #57 Login fails after password reset ────╮
│ Users hit a 500 after a reset; done when │
│ they can sign in.              PR #60 ↗  │
╰──────────────────────────────────────────╯

 ⚑ NEEDS YOU
   Approve Bash: git push --force

 ● Working · 12m
   ✓ Run the checkout tests
   ▸ Push branch and open PR

 Done  ·  3 files changed · 26 commands
   ✓ Fixed login after password resets
   ✓ Added a regression test for resets
   + 4 earlier

 ───────────────────────────────────────
 $1.84                   5h ▓▓▓░░░░░ 42%
                         [ Copy summary ]
```

Sections only appear when they have something to say. When the pane is closed, or the terminal is too narrow for it, the same picture shrinks to one line above the prompt while Claude works or something needs you:

```
#57 Login fails · ● Push branch and open PR · 12m · ⚑ Approve git push · $1.84
```

## Sections

- **Issue card**: the issue the session is on, as a title and one-line summary, with links to the issue and to its pull request once one is opened. It picks the issue up when you name one in a prompt (an issue link, `#123`, `issue 123`, or a key like `ENG-42` next to the word issue/ticket/story/bug/task), when Claude reads one (`gh issue view`, a GitHub/Jira/Linear connector, or an issue link), or from `/issue <#123 | ENG-42 | link | pasted text | clear>`. An issue you name stays while Claude reads related ones. GitHub issues are fetched with your own `gh`; other trackers fill in once Claude reads the issue.
- **⚑ Needs you**: shown only when something is waiting on you: a permission dialog actually put to you (none in auto mode unless it asks), a question or plan to approve, or a few-word summary of what Claude's last message asks you to do. The count also shows in the status line and the pane's title.
- **Status**: `● Working · 12m` with the last steps finished (from the short descriptions Claude gives its commands) and the one under way; `○ Idle` otherwise. Scheduled wakeups, recurring jobs and background tasks show beneath it as `⏱` lines. No model calls.
- **Done**: plain-English results of each turn ("Fixed login after password resets"), not a list of commands, newest three with `+ N earlier` to expand; hover one for when it happened and what it took. The header counts the files this work changes, as a PR would show them (on a feature branch, the branch against where it left the default branch; on the default branch, your own commits since the session began, never what a pull brought in; plus uncommitted edits and files created during the session), and the commands run.
- **Footer**: the session's running cost as `/cost` totals it (an API-equivalent estimate on a subscription), and your nearest usage limit as a meter, yellow from 80%. Where a setup reports no cost to mods, it says so instead of showing $0.00, and shows tokens processed instead.
- **Copy summary** (or `c` while the pane has focus): copies the issue, PR link, Done list and totals as a short write-up for a PR description, standup or status message.

The pane opens by itself in terminals 144+ columns wide; otherwise type `/board`, or rely on the band above the prompt. Links are clickable in terminals that support them (iTerm2, Ghostty, WezTerm, Kitty, VS Code's terminal) and in the Desktop app. Hover details need mouse support (Claude Code's fullscreen layout, or the Desktop app).

## Install

Needs Claude Code v2.1.287 or later (`claude --version`; `claude update` to upgrade).

```
claude plugin marketplace add srwiseman/claude-mods
claude plugin install session-board@srwiseman
```

Or inside a session: `/plugin marketplace add srwiseman/claude-mods`, then `/plugin install session-board@srwiseman`. Start a new session, or run `/reload-plugins`. Run `/plugin` to confirm it loaded (`1 mod active · session-board`).

Optional: with the GitHub CLI installed and logged in (`gh auth login`), GitHub issues get their summary right away instead of once Claude reads them.

Update with `claude plugin marketplace update srwiseman` and `claude plugin update session-board@srwiseman`.

## What it can see and do

Like any mod, it runs with your permissions.

- It reads every prompt and tool call in the session.
- At the end of each turn it sends your request, a list of the files changed and commands run (last two path segments only), and Claude's last message to Claude Haiku, which writes the "Done" and "Needs you" lines: one small model call per turn on your plan or API key.
- When it follows an issue, it sends the issue's text (up to 6,000 characters) to Haiku for the summary, and for GitHub issues it runs `gh issue view` as you.
- It runs read-only git commands in the session's folder (`rev-parse`, `symbolic-ref`, `merge-base`, `config user.email`, `log`, `diff --name-only`, `ls-files`) and reads file times to count files changed.
- The Done log, files-changed count and issue are saved on your machine in Claude Code's plugin store, one entry per session, so they survive restarts and resumes. Entries untouched for 30 days are deleted.

Run `claude plugin validate` on this folder to list every event it handles and every call it makes.
