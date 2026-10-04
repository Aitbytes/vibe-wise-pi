# VibeWise for pi

**You build. AI writes.**

A [pi coding agent](https://github.com/badlogic/pi-mono) package that puts learning first and keeps you in control while the AI writes the code you designed. The agent **asks for your approach first**, helps you examine tradeoffs, and explains unfamiliar concepts. You shape the design and decide when it's ready to implement. The agent writes the code, then explains what it changed and why.

This is a port of [nykooi1/vibe-wise](https://github.com/nykooi1/vibe-wise) (a Claude Code plugin by Noah Kim) to the pi coding agent's package system. All credit for the VibeWise learning method and content goes to the original author; this repository only adapts the packaging and integration layer.

## What's in the port

| Original (Claude Code) | Port (pi) |
| --- | --- |
| `skills/learn` + `skills/reset` skills | Same skills, adapted to pi tooling (`read` tool, no `${CLAUDE_PLUGIN_ROOT}`, harness-agnostic pickers) |
| `hooks/session_start.py` (SessionStart hook) | `extensions/vibe-wise.ts` — pi extension restoring learning context on `session_start` and `session_compact` |
| `.claude-plugin/plugin.json` + marketplace | `package.json` with a `pi` manifest (`pi install`) |
| `/vibe-wise:learn`, `/vibe-wise:reset` | `/skill:learn`, `/skill:reset` |

State format is unchanged: notes still live in `.vibe-wise/` (legacy `.sensible-vibes/` is still read in place), so you can move between the Claude Code plugin and this port without losing learning history.

## Requirements

- pi coding agent
- Python 3 (used only by the `reset` skill's helper; no extra packages)

## Install

```sh
pi install git:github.com/Aitbytes/vibe-wise-pi
```

Or pin a ref:

```sh
pi install git:github.com/Aitbytes/vibe-wise-pi@v0.1.0
```

For a single project instead of globally, add `-l` (writes to `.pi/settings.json`; pi installs the package after the project is trusted).

## Usage

Start in your project with:

```text
/skill:learn
```

Setup asks one question at a time; pick **Use defaults** to skip preference setup. Then ask the agent to build something. Starting fresh or joining an unfamiliar repository both work — for an existing repository, the agent first inspects the code and sketches a small system map.

**Automatic context restore:** once learning is active (a non-empty `.vibe-wise/profile.md` without `Learning mode: paused`), the bundled extension silently re-injects reading instructions whenever you start or resume a session in that project, and after compaction. The agent then reloads your profile, project map, and pending decisions before coding. Restoration is invisible by design (it mirrors the original hook's `additionalContext`); you can confirm it by asking the agent what stage your learning is at, or by checking for the `vibe-wise-restore` entry in the session file.

Reset learning with `/skill:reset`. It previews what will change, asks for explicit confirmation, backs up your notes under `.vibe-wise/backups/`, and restarts onboarding. Source code is never touched.

Pause anytime with "Pause learning"; resume with `/skill:learn`. Preferences, learning notes, and the project map live in `.vibe-wise/` — add it to your `.gitignore` to keep notes out of Git; the package won't change it silently.

## Differences from the Claude Code plugin

- Restores happen via a queued invisible message (`deliverAs: "nextTurn"`) instead of `SessionStart` `additionalContext`; no turn is triggered.
- Interactive pickers (Claude Code's `AskUserQuestion`) fall back to plain-text questions when the host doesn't provide an equivalent UI.
- No marketplace auto-update; update with `pi update git:github.com/Aitbytes/vibe-wise-pi` (pinned refs don't move automatically — re-run `pi install` with a new ref).

## Development

```sh
python3 -m unittest discover -s tests -v           # reset helper tests
deno check extensions/vibe-wise.ts                 # extension type check
deno test --allow-read --allow-write --allow-env   # extension behavior tests
```

## License

[MIT](LICENSE). Original work Copyright (c) 2026 Noah Kim; port adaptations Copyright (c) 2026 Aitbytes.
