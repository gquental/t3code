---
name: t3ctl
description: Control an existing T3 Code environment through the t3ctl CLI. Use for pairing, project and model selection, creating or following agent threads, submitting prompts, and responding to pending requests. Server hosting and development of T3 Code use separate tools.
---

# T3 Control CLI

Use `t3ctl` to operate a paired T3 Code server. The server runs providers and owns projects, threads, model settings, and workspace files. Paths passed to `project add` belong to the server machine. A prompt supplied with `--file` comes from the agent's local machine.

## Connect to the intended environment

Run `t3ctl --help` to check the installed command set. This CLI requires Node.js 24.13.1 or later. It is a prototype that has not been published to npm; use an installed build supplied by the user or build `apps/control-cli` from the T3 Code checkout.

List saved connections and verify the target before changing server state:

```sh
t3ctl connections list
t3ctl --connection work connections status
```

If pairing is needed, use a fresh URL from the host's `t3 pair` command:

```sh
t3ctl pair 'PAIRING_URL' --name work
```

Quote the complete URL. Treat pairing URLs and saved credentials as secrets. Saved CLI connections are independent of the desktop client's connections. Credentials normally live in `~/.config/t3ctl/connections.json`; `--config-dir DIRECTORY` selects separate storage. `connections remove NAME` forgets the local credential; revoking a server session requires the host's Connections settings.

Use `--connection NAME` on remote commands when multiple environments are saved. The first pairing becomes active; `connections use NAME` changes the default. Pairing supports reachable local, remote, and existing T3 Connect tunnel URLs. Account-based Connect login, relay discovery, SSH, and tunnel creation are not implemented.

## Select a project and model

Read IDs from command output rather than guessing them:

```sh
t3ctl --connection work project list
t3ctl --connection work project add /server/path/to/repo --title Repo
t3ctl --connection work models --project PROJECT_ID
t3ctl --connection work thread list --project PROJECT_ID
```

Reuse the intended project or thread when it already exists. `project add` requires an existing directory unless `--mkdir` is supplied.

New threads inherit the effective project model and runtime defaults. If no model default exists, supply both `--instance INSTANCE_ID` and `--model MODEL` using the server's `models` output. A provider instance identifies a configured account; its driver name does not identify the account. Use `--selection` instead of those two flags when model options are needed:

```sh
t3ctl --connection work thread create PROJECT_ID --title 'Investigate tests'
t3ctl --connection work thread create PROJECT_ID --instance INSTANCE_ID --model MODEL
t3ctl --connection work thread create PROJECT_ID --selection '{"instanceId":"INSTANCE_ID","model":"MODEL","options":[{"id":"reasoningEffort","value":"high"}]}'
```

Choose options from the model's reported capabilities. `project set-model` changes the default for new threads; `project reset-model` restores inheritance from the environment. Existing threads keep their model selection. Do not change a project default just to select a model for one thread.

## Submit work and observe its result

Use the returned `threadId` to submit a prompt. For multiline text, write a local UTF-8 file and use `--file` to avoid shell quoting problems:

```sh
t3ctl --connection work thread send THREAD_ID --file prompt.txt
t3ctl --connection work thread get THREAD_ID
t3ctl --connection work thread watch THREAD_ID --timeout 3600
```

A successful send reports `messageId` and command acceptance, not completed work. Check the thread's messages, pending requests, and `thread.latestTurn.state` before reporting a result. `get` returns the latest ten turns when the server supports pagination; use `--all` for older history. `watch` prints a snapshot followed by events and stays open until stopped or timed out, including after a turn completes. Fetch `get` for a current snapshot when interpreting events is unnecessary.

Stopping or timing out `watch` leaves the turn running. Use `thread interrupt THREAD_ID` to interrupt a turn and `thread stop-session THREAD_ID` to stop its provider session when requested.

## Handle pending requests

Read the current requests, including their details and question IDs:

```sh
t3ctl --connection work thread requests THREAD_ID
t3ctl --connection work thread approve THREAD_ID REQUEST_ID accept
t3ctl --connection work thread answer THREAD_ID REQUEST_ID '{"question_id":"answer"}'
```

The output contains `approvals` and `userInputs`. Match `requestId` and question IDs exactly. Approval decisions include `accept`, `acceptForSession`, `acceptAlways`, `decline`, and `cancel`; inspect `thread approve --help` for the installed version. Respond within the user's authorized scope. Creating a thread does not grant blanket approval of its provider's later requests. Use `dismiss-question` only for user inputs with `dismissible: true`. Re-read requests and thread state after responding to confirm the provider continued or to identify a failed response.

## Output and recovery

Commands return JSON on stdout; `watch` returns one JSON object per line. Help and version are text. Failures return JSON with `error.code` and `error.message` on stderr and exit with status 1. The default deadline is 30 seconds, including connection setup; `--timeout SECONDS` changes it.

Commands are not replayed on reconnect. A transport failure or timeout can happen after a mutation was accepted. Inspect state before retrying; resending a prompt may start duplicate work. Do not edit the server database or the desktop client's state to recover a CLI connection.

Use `archive` and `reopen` to change a thread's visibility. `thread delete` and `project remove` remove records and should match the user's requested scope. Terminal, git, worktree, browser, and attachment controls are not exposed in this version; report that limit instead of inventing commands.
