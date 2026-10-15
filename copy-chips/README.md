# copy-chips

Click-to-copy chips above the Claude Code prompt for the things in Claude's replies you'd otherwise select and copy by hand: commands to run, ids, paths, URLs, branch names.

```
Copy  1: git push -u origin feat/login   2: wf_abc123   3: https://github.com/acme/app/pull/60   4: npm ci +1 lines
```

- **Click a chip**, or **type its digit into an empty prompt**, to copy it. A toast says what was copied.
- Chips come from inline code, fenced code blocks and bare links in each reply. Lone words in backticks (`main`, `true`) are left out, as are diffs and blocks over 40 lines. A shell block that shows `$ ` prompts copies just the commands, without the prompts or the output.
- The newest reply's items come first. Older ones stay until nine are showing, so the id from two replies back is still a keypress away.
- Subagents' reports and interrupted turns add nothing.
- The chips sit on top of whatever else draws above the prompt (another mod's band, for one) rather than replacing it.

## Commands

- `/chips`: hide or show the chips
- `/chips clear`: empty them

## Install

Needs Claude Code v2.1.287 or later (`claude --version`; `claude update` to upgrade).

```
claude plugin marketplace add srwiseman/claude-mods
claude plugin install copy-chips@srwiseman
```

Start a new session, or run `/reload-plugins` in an open one.

## What it can see and do

- Reads the final text of each of Claude's replies in the main conversation, and keeps the items it finds for the session only. Nothing is written to disk or sent anywhere.
- Adds one short section to the system prompt, asking Claude to put copyable values in code formatting so the chips find them reliably. Where an organization manages Claude Code, that section is only added if the organization allows the mod; the chips still work without it.
- Writes to your clipboard only when you press a chip, the same way `/copy` does (it works over SSH in terminals that support OSC 52).
