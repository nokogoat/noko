# noko

A small always-available panel for **Hyprland** to run, follow and approve Claude agent
sessions. Powered by Claude.

Start a prompt, go do something else, come back when the pill says it's your turn: read
the answer, review the file changes, approve tool calls in one click.

- **Sessions from the panel**: pick a folder, write a prompt, follow the answer as it
  streams. Resume or delete a session later.
- **Approvals in one click**: every tool call that needs your approval shows its exact
  input (command, path, before/after diff). No "allow all" button.
- **Terminal sessions too** (optional): sessions started with `claude` in a terminal show
  up in the panel, and their approval requests can be answered there.
- **Yours to customize**: themes, size, corner, language (English, French), sounds.

## Install

From the AUR (CachyOS, Arch):

```sh
paru -S noko        # or: yay -S noko
```

Then:

1. Log in to Claude once, if not done yet: run `claude` in a terminal.
2. Start noko: `noko` (or from your app launcher).

To start it with Hyprland and toggle it with a shortcut, in your Hyprland config:

```
exec-once = noko
bind = SUPER, N, exec, noko toggle
```

To also follow sessions started in a terminal: `noko hooks` (shows the change to
`~/.claude/settings.json`, asks for confirmation and keeps a backup;
`noko hooks --uninstall` removes it).

## Use

- **Click** the pill to open the card; **drag** it to move it to another corner.
- **Resize** the card with the grip in its free corner. Size and position are remembered.
- **+** starts a new session; the menu at the top switches sessions (type to search).

## Configure

`~/.config/noko/config.toml` is created on first launch, with comments. It is reloaded
live. Themes go in `~/.config/noko/themes/<name>.toml`: copy a built-in one from the
repository's `ui/themes/` folder and change its colors.

## Security

noko can approve tool calls, so it is built to be strict: a Unix socket only reachable by
your user, every message validated, no network listener, no shell commands from the
config. Please report vulnerabilities privately, through GitHub's security advisories
(Security tab of the repository), not in public issues.

## Build from source

Requirements: Node.js ≥ 22.18, `gjs`, `gtk4`, `gtk4-layer-shell`.

```sh
npm ci
npm run build && npm test
npm run dev    # daemon
npm run ui     # panel
```

## License

MIT. noko is not affiliated with Anthropic.
