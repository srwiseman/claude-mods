# claude-mods

Claude Code mods by srwiseman.

## session-board

A **Session** pane beside the transcript with three live sections:

- **Needs you**: permission dialogs actually shown to you (nothing in auto mode unless it asks), questions and plans waiting on you, and a few-word summary of what Claude's last message asks you to do. The count also shows in the status line.
- **Up next**: scheduled wakeups, recurring jobs, and running background tasks.
- **Cost**: the session's running cost as `/cost` totals it (an API-equivalent estimate on a subscription), plus your plan's 5-hour and weekly limits.
- **Done this session**: plain-English results of each turn ("Published the mod to GitHub so it installs on any machine"), not a list of commands.

Opens by itself in terminals 144+ columns wide; otherwise type `/board`.

### Install

```
claude plugin marketplace add srwiseman/claude-mods
claude plugin install session-board@my-mods
```

Run `/reload-plugins` in sessions that are already open.

### What it can see

Like any mod, it runs with your permissions. It reads every prompt and tool call in the session, and at the end of each turn sends your request, a list of the files changed and commands run (last two path segments only), and Claude's last message to Haiku, which writes the "Done" and "Needs you" lines. The Done log is saved on your machine in Claude Code's plugin store, one entry per session, so it survives restarts and resumes; entries untouched for 30 days are deleted. That is one small model call per turn on your plan or API key.
