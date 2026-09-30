# T3 Control CLI

`t3ctl` controls an existing T3 Code server using the same typed commands, pairing, and WebSocket session code as the web, desktop, and mobile clients. This package is an initial local implementation and has not been published to npm.

Requires Node.js 24.13.1 or later. Build from this checkout after installing the workspace dependencies:

```sh
cd apps/control-cli
vp pack
node dist/bin.mjs --help
```

To install it locally, run `npm install -g ./apps/control-cli/dist` from the repository root. The build produces a standalone package with its runtime dependencies bundled. You can also substitute `node apps/control-cli/dist/bin.mjs` for `t3ctl` below.

## Pair and select an environment

On the host, use the existing `t3 pair` command to obtain a fresh pairing URL. Pass that URL to the control CLI on the agent's machine:

```sh
t3ctl pair 'PAIRING_URL' --name work
t3ctl connections list
t3ctl connections use work
t3ctl connections status
```

The first saved connection becomes active. Use `--connection NAME` on a command to target another environment without changing the active selection. `connections remove NAME` forgets a local credential; revoke its server session in T3 Code's Connections settings if needed.

Pairing works with a reachable local or remote server URL, including an existing T3 Connect tunnel URL. The CLI does not yet implement account-based T3 Connect login, relay discovery, SSH connections, or creating tunnels. The host's existing connection tools continue to handle those tasks.

Saved credentials live in `~/.config/t3ctl/connections.json`, independently of the desktop client's state. Use `--config-dir DIRECTORY` to isolate an agent's credentials. The directory and file receive owner-only permissions on systems that support them. Connection output omits credentials.

## Projects, models, and threads

Workspace paths refer to the **server machine**. Use `--mkdir` when adding a project if its directory should be created when absent.

```sh
t3ctl project add /server/path/to/repo --title Repo
t3ctl project list
t3ctl models --project PROJECT_ID
t3ctl thread create PROJECT_ID --title 'Investigate the tests'
t3ctl thread list --project PROJECT_ID
t3ctl thread send THREAD_ID 'Inspect the failing tests and explain the cause.'
t3ctl thread get THREAD_ID
t3ctl thread watch THREAD_ID --timeout 3600
```

New threads inherit the environment's effective project model and runtime defaults. If no model default is configured, supply both `--instance INSTANCE_ID` and `--model MODEL` from `models`. Instance IDs identify configured provider accounts; driver names alone do not identify an account. To include model options, use `--selection` instead:

```sh
t3ctl thread create PROJECT_ID --selection '{"instanceId":"codex","model":"MODEL","options":[{"id":"reasoningEffort","value":"high"}]}'
t3ctl project set-model PROJECT_ID --instance INSTANCE_ID --model MODEL
t3ctl project reset-model PROJECT_ID
```

`models` reports the server's catalogue, model capabilities, and effective default source. `reset-model` removes the project override so new threads inherit the environment default again. Existing threads keep their model selections.

Use `thread send THREAD_ID --file prompt.txt` for a multiline prompt. A successful send returns the message ID and accepted command sequence. Acceptance does not mean the provider has completed the turn. Follow the thread with `get` or `watch` for results, provider errors, or requests. `get` loads the latest ten turns when the server supports pagination; `--all` loads the complete history.

```sh
t3ctl thread requests THREAD_ID
t3ctl thread approve THREAD_ID REQUEST_ID accept
t3ctl thread answer THREAD_ID REQUEST_ID '{"question_id":"answer"}'
t3ctl thread interrupt THREAD_ID
t3ctl thread archive THREAD_ID
t3ctl thread reopen THREAD_ID
```

`--help` lists further commands, including renaming and removing records, stopping sessions, and dismissing asynchronous questions. This first version covers the core conversation workflow; terminal, git, worktree, browser, and attachment controls are not yet exposed.

## Agent output

Successful commands print JSON to stdout. `thread watch` prints a snapshot followed by typed events, one JSON object per line. Help and version output are text. Errors print a JSON object with `error.code` and `error.message` to stderr and exit with status 1; success exits with status 0. The default deadline is 30 seconds, including connection setup. `--timeout SECONDS` changes it.

Commands are not replayed on reconnect. A transport error or timeout can occur after the server accepted a mutation. Inspect the server's current state before retrying, especially after submitting a prompt. A timed-out watch leaves any running turn active; use `thread interrupt` to stop it.

The executable bundles the shared client runtime and contracts at build time. Protocol changes flow into the CLI when it is rebuilt and released; new client features still need a corresponding CLI command.

## Agent skill

The package includes [the `t3ctl` skill](skills/t3ctl/SKILL.md) with guidance for selecting an environment, submitting work, tracking results, and handling pending requests. Copy the `skills/t3ctl` directory into your agent's skills directory. For Codex, after a global CLI installation:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R "$(npm root -g)/@t3tools/control-cli/skills/t3ctl" "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Invoke it as `$t3ctl`, or let the agent select it for T3 Code control tasks. Other agents that support `SKILL.md` can load the same directory using their own skill installation procedure.
