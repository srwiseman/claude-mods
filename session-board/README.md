# session-board

A **Session** pane beside the Claude Code transcript that shows, at a glance, what you're working on, what's happening, what needs you, and what got done.

```
Working on #57 · open
  Login fails after password reset
  Users hit a 500 after a reset; done when they can sign in.
  PR #60 opened

In progress · 12m
  ✓ Run the checkout tests
  ▸ Push branch and open PR

Needs you (1)
  ⚑ Decide: merge now or wait for review?

Done this session (2)
  ✓ Fixed the login error after password resets
  ✓ Opened a pull request with the fix and tests
  3 files changed · 26 commands run

Cost
  $1.84 this session
  210k tokens used
```

## Sections

- **Working on**: the issue the session is on, as a title and one-line summary, with links to the issue and to its pull request once one is opened. It picks the issue up when you name one in a prompt (an issue link, `#123`, `issue 123`, or a key like `ENG-42` next to the word issue/ticket/story/bug/task), when Claude reads one (`gh issue view`, a GitHub/Jira/Linear connector, or an issue link), or from `/issue <#123 | ENG-42 | link | pasted text | clear>`. An issue you name stays on top while Claude reads related ones. GitHub issues are fetched with your own `gh`; other trackers fill in once Claude reads the issue.
- **In progress**: while Claude works, how long the turn has run, what it is doing now, the last few steps it finished (from the short descriptions Claude gives its commands), and a command count. No model calls.
- **Needs you**: permission dialogs actually shown to you (none in auto mode unless it asks), questions and plans waiting on you, and a few-word summary of what Claude's last message asks you to do. The count also shows in the status line.
- **Up next**: scheduled wakeups, recurring jobs, and running background tasks.
- **Done this session**: plain-English results of each turn ("Opened a pull request with the fix and tests"), not a list of commands, and the files changed this session (counted with git from the commit the session started on, so edits made through shell commands count too).
- **Cost**: the session's running cost as `/cost` totals it (an API-equivalent estimate on a subscription), tokens used, and your plan's 5-hour and weekly limits. Where a setup reports no cost to mods, it says so instead of showing $0.00.

The pane opens by itself in terminals 144+ columns wide; otherwise type `/board`. Links are clickable in terminals that support them (iTerm2, Ghostty, WezTerm, Kitty, VS Code's terminal) and in the Desktop app.

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
- It runs `git rev-parse`, `git diff --name-only` and `git ls-files` in the session's folder to count files changed.
- The Done log, files-changed count and issue are saved on your machine in Claude Code's plugin store, one entry per session, so they survive restarts and resumes. Entries untouched for 30 days are deleted.

Run `claude plugin validate` on this folder to list every event it handles and every call it makes.
