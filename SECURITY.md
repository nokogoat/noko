# Security

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub's security advisories:
repository → **Security** tab → **Report a vulnerability**. Do not open a public issue.
You will get an answer as soon as possible; please allow time for a fix before any
public disclosure.

Only the latest release is supported.

## Threat model

noko can **approve tool calls** made by Claude: whoever controls noko (its socket, its
hooks, its config) can run code with your user's rights. What noko protects: the right to
approve, the content of prompts and answers, `~/.claude/settings.json`, and keys. When in
doubt, noko picks the most restrictive option.

## IPC socket

- Only in `$XDG_RUNTIME_DIR`, which must exist, belong to the user and be `0700`. Never a
  fallback to `/tmp`, never TCP or HTTP, even locally.
- Socket created `0600` (umask before `listen()`, checked with `stat`). An existing path
  must be a socket owned by the user: a dead one is removed, a live one means another
  daemon is running and noko refuses to start.
- Every line is validated against a schema, in both directions, with a size limit per line
  and a bounded number of connections. An invalid message is rejected and the connection
  closed; it never crashes the daemon.

## Permissions

- The Agent SDK always runs with `permissionMode: "default"`; never
  `bypassPermissions`, never bare tool names in `allowedTools`.
- Project settings (`.claude/settings.json`, hooks, `allow` rules of a cloned repository)
  are only loaded for folders you already trusted in Claude Code, like in the terminal.
- Each approval request has a random, single-use id. Unknown, expired or reused ids are
  refused. No answer before the timeout means **deny**.
- The panel shows the exact tool input (command, path, diff), never a summary. No
  "allow all" button, no automatic rules. "Allow" is only enabled after a short delay, to
  avoid accidental clicks, and has no keyboard shortcut.
- The only input noko ever adds to a tool call is the `answers` of `AskUserQuestion`,
  built from your explicit choices and validated by the daemon.
- File diffs are a complement to the exact input. To place a change in a file, the daemon
  reads only regular files of at most 1 MiB, valid UTF-8; their content is never logged.

## Terminal hooks

- `command` hooks only, with an explicit short timeout, and in exec form (absolute paths
  to `node` and to the script, no shell).
- **Fail open means deciding nothing**: if the daemon is missing, slow or errors, the hook
  exits without a decision and Claude Code asks in the terminal. It never answers `allow`
  on an error or a timeout, only when you explicitly allowed that exact request.
- The installer shows the diff, asks for confirmation, merges without overwriting your
  hooks and keeps a `0600` backup of `settings.json`. The script and its folders must
  belong to you (or to root, for a system package) and be writable by nobody else.

## External processes

- Processes are started with an argument array, never through a shell. A pid is checked to
  be an integer before being passed to `hyprctl`.
- The config cannot contain any command. Sounds are file paths played by a fixed player
  (`pw-play`, else `paplay`): absolute path, regular file, at most 10 MiB, audio extension.

## Data

- Session list in SQLite (`node:sqlite`), prepared statements only, database `0600` and
  folders `0700`. The conversation history stays Claude Code's own, it is not copied.
- Config and theme files are untrusted input, validated field by field. A theme only holds
  colors, a few numbers and a font name, all validated: no free CSS.
- Text from Claude or from tools is displayed as plain text, never as markup.
- Logs never contain prompts, answers, tool output, keys or `settings.json` content.

## Dependencies

- Locked versions (`package-lock.json`), installed with `npm ci`, with install scripts
  disabled (`ignore-scripts=true`) and a 7-day quarantine on new releases.
- As few dependencies as possible; each one is checked (exact name, repository,
  maintainers) before being added.
- GitHub Actions are pinned by full commit SHA, with read-only permissions by default.
