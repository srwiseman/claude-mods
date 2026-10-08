# claude-mods

[Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) by srwiseman. A mod adds panes, commands and behavior inside Claude Code; this repo is a plugin marketplace you add once, then install the mods you want.

| Mod | What it does |
| --- | --- |
| [session-board](session-board/) | A sidebar showing the issue you're on, live progress, what needs you, what got done, and what it cost |

## Get started

Needs Claude Code v2.1.287 or later (`claude --version`; `claude update` to upgrade).

Add this marketplace once:

```
claude plugin marketplace add srwiseman/claude-mods
```

Then install any mod by name:

```
claude plugin install <mod>@srwiseman
```

Start a new session, or run `/reload-plugins` in an open one. Each mod's README has its details.

To update later: `claude plugin marketplace update srwiseman`, then `claude plugin update <mod>@srwiseman`.

## Before you install

A mod is code that runs inside Claude Code with your permissions, unsandboxed. Each mod's README has a "What it can see and do" section, and `claude plugin validate <folder>` lists every event a mod handles and every call it makes, without running it.

## License

[MIT](LICENSE)
