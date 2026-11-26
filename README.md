# Kepler Homebrew Plugin

A [Kepler](https://kplr.space) plugin that surfaces outstanding Homebrew updates as a Look Ahead card and provides a `/brew` search mode to browse and upgrade outdated formulae and casks in your terminal.

## Features

- **Look Ahead card**: Checks `brew outdated --json=v2` (with `HOMEBREW_NO_AUTO_UPDATE=1`) and caches results locally. Hides automatically when up to date, dismisses until the outdated set changes, and jumps into `/brew` (or opens Terminal directly) on click/Return.
- **`/brew` search mode**: Filter outdated formulae and casks with `installed → current` versions, and run `brew upgrade` (all or single package) in Terminal, iTerm, or copy the command.
- **Settings**: Choose upgrade action (`Open in Terminal`, `Open in iTerm`, `Copy Command`), Look Ahead card click behavior, cask / `--greedy` inclusion, refresh interval, and custom `brew` executable path.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run install:local
```

Requires Kepler with `ctx.process.exec`, `Action.searchMode`, and interactive Look Ahead plugin support (`@kepler-app/plugin-sdk` >= 1.3.0).
