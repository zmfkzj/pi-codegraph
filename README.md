# pi-codegraph

Connects [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT, by Colby McHenry) to Pi. CodeGraph is a local, pre-built knowledge graph of a project's symbols, call edges and dependencies (SQLite + FTS5, 30+ languages); its MCP tool returns the relevant source, call paths and blast radius of a question in one call instead of a grep/read loop.

This package does not bundle or reimplement CodeGraph. It wires the upstream CLI's own MCP server into Pi's built-in MCP support and adds a `/codegraph` command for the per-project index.

## What it adds

| Piece | Behavior |
|---|---|
| MCP server `codegraph` | `codegraph serve --mcp`, registered with `pi.registerMcpServer()` and `exposure: "direct"`, so the model sees **`mcp__codegraph__codegraph_explore`** (`query`, optional `maxFiles`, `projectPath`) from the first prompt. That is upstream's default (and only listed) MCP tool. |
| `/codegraph [status]` | CLI path and version, whether the server is registered (or why not), whether the tool is available, the project index, and `codegraph status` statistics. |
| `/codegraph init` | Runs `codegraph init --yes <cwd>` (index the session directory), then connects the server right away, without `/reload`. |
| `/codegraph sync` | Runs `codegraph sync <project root>` (incremental update, for when the file watcher is off). |
| `/codegraph doctor` | Read-only health check of the CLI, your `codegraph` mcp.json entry and this project's index, with the fix for each problem (see [Dependency check and install](#dependency-check-and-install)). |
| `/codegraph install-deps` | Installs a **missing** CLI with upstream's `install.sh` (user-level, no sudo); never upgrades, never writes mcp.json, never indexes. |
| `/codegraph help` | Usage. |
| orche worker capability `codegraph` | Every orche worker (`orche_task`) and sub-worker (`orche_spawn`), read-only roles included, gets **its own** CodeGraph MCP connection and `mcp__codegraph__codegraph_explore` in its own session (see below). |

Registration rule (on every `session_start`, and after `/codegraph init`):

- **auto** (default): register only when the CLI is found and an index exists at or above the session directory (`.codegraph/codegraph.db`, or `CODEGRAPH_DIR`, or WSL's `.codegraph-wsl/`). Sessions in non-indexed directories get no extra tool and no server process.
- **always**: register whenever the CLI is found (monorepos whose root is not indexed: the tool takes `projectPath`).
- **off**: never register; `/codegraph` still works.

Indexing stays a user action, as upstream asks: the model gets no tool that builds an index.

## Requirements

1. **The `codegraph` CLI** (not an npm dependency of this package; it ships its own Node runtime). `/codegraph install-deps` runs the first command below for you when the CLI is missing (Linux/macOS); or install it yourself:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh   # macOS / Linux
   # or: npm i -g @colbymchenry/codegraph
   ```

   Found through `PI_CODEGRAPH_BIN`, then `codegraph` on `PATH`, then `~/.local/bin/codegraph` and `~/.codegraph/current/bin/codegraph` (install.sh locations). You do **not** need `codegraph install`: that command writes MCP configs for other agents, and Pi gets the server from this extension.
2. **A per-project index**: run `/codegraph init` in Pi (or `codegraph init` in the project). It creates `.codegraph/` (the SQLite graph plus a `.gitignore` that ignores everything in it) and builds the graph. Upstream's MCP server keeps it fresh with a file watcher; run `/codegraph sync` when the watcher is disabled (for example when the OS watch limit is exhausted, which `codegraph_explore` reports in a banner).
3. Pi with built-in MCP support (`pi.registerMcpServer`). With `--no-mcp`, `-builtin:mcp`, or another MCP extension that does not connect registered servers, the tool is not available.

Verified with Pi 1.1.0 and CodeGraph 1.6.2 on Linux x64.

## Versions and updates

Three things have separate versions, and this package updates only the first:

| Piece | Where it comes from | Who updates it |
|---|---|---|
| pi-codegraph (this package) | the `codegraph/` submodule of oh-my-pi-extensions, or `git:github.com/zmfkzj/pi-codegraph` | `pi update --extensions` (the umbrella's hourly workflow moves its gitlink to the latest `main`) |
| CodeGraph CLI | install.sh (`~/.codegraph/versions/vX.Y.Z`, symlinked from `~/.codegraph/current` and `~/.local/bin/codegraph`) or `npm i -g @colbymchenry/codegraph` | you: `codegraph upgrade` (install.sh installs; `--check` only checks) or `npm update -g @colbymchenry/codegraph` |
| CodeGraph MCP server | the CLI itself: `codegraph serve --mcp` (server name `codegraph`, version = the CLI's package version) | updated with the CLI; a running server or shared daemon keeps its old version until it restarts (new Pi session, `/reload`, or `codegraph daemon` stop) |

This package never upgrades the CLI, and installs it only when you ask: `/codegraph install-deps` (or the umbrella's `/oh-my-pi install-deps`) runs upstream's install.sh when no CLI is found (see below). Upstream's MCP server checks GitHub for a newer release in the background (24 h cache in `~/.codegraph/`) and only reports it (stderr, MCP `initialize` instructions, `codegraph_status`) as "run `codegraph upgrade`"; `CODEGRAPH_NO_UPDATE_CHECK=1` or `DO_NOT_TRACK=1` turns that check off. `/codegraph status` shows the CLI path and version in use.

## Dependency check and install

`/codegraph doctor` (also run by the umbrella's `/oh-my-pi doctor`, provider id `codegraph`) only inspects: it runs `codegraph --version` (5 s bound) and nothing else, downloads nothing, writes no config and creates no index. It reports, with an action for every problem:

| Item | Status |
|---|---|
| `mcp.json "codegraph" entry` (only when `~/.pi/agent/mcp.json` or a trusted project's `.pi/mcp.json` defines one) | `ok` for a remote (`url`, never printed) server, a disabled entry (`enabled: false`), an `enabled`/`exposure` override, or a `command` that resolves; `error` when the entry's `command` is not an executable file or on `PATH` (fix the entry; the extension never edits it); `unverified` for an entry with neither. |
| `PI_CODEGRAPH_MCP` (only when set) | `ok`, or an optional `warn` for an invalid value. |
| `codegraph CLI` | Resolved exactly like the extension: `PI_CODEGRAPH_BIN`, `PATH`, `~/.local/bin/codegraph`, `~/.codegraph/current/bin/codegraph`. `ok` with path and version; `error` when it is missing, `--version` fails, or `PI_CODEGRAPH_BIN` is wrong. When an mcp.json entry supplies the server (remote, own command, or disabled), MCP does not need the local CLI: a missing CLI is then `ok` with a note (only `/codegraph init`, `sync`, `status` need it). |
| `project index` | Per project and optional: `ok` with the index found at or above the session directory (or the entry's `--path`/`cwd`; a remote server keeps its own), otherwise `warn` with the action `/codegraph init`. Never created by doctor or install-deps. |

`/codegraph install-deps` (also `/oh-my-pi install-deps`):

- **Installs automatically** only a missing CLI that MCP needs (no mcp.json entry supplies the server), on Linux or macOS, x64 or arm64, with `curl`, `sh` and `tar` on `PATH`: it downloads upstream's [install.sh](https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh) to a temporary file and runs it with your `HOME` (and without `CODEGRAPH_INSTALL_DIR`/`CODEGRAPH_BIN_DIR`, so it lands where the extension looks): a self-contained bundle with its own Node runtime in `~/.codegraph/versions/<tag>`, linked from `~/.codegraph/current` and `~/.local/bin/codegraph`. It then re-checks (`codegraph --version`) and reports `installed` only when that passes; when the session directory is indexed, the MCP server connects right away. If `~/.local/bin` is not on your `PATH`, Pi still finds the CLI and the report says how to add it for shells.
- **Why install.sh and not npm**: it is upstream's documented installer, needs no privileges, no Node.js and no npm prefix. `npm i -g @colbymchenry/codegraph` works without sudo only when npm's global prefix is user-writable, which a system Node usually is not; it stays a manual alternative.
- **Reports as `manual`** (with the exact command): Windows (`irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex` in PowerShell), other platforms or CPUs (npm with a user-writable prefix), missing `curl`/`tar`, a wrong `PI_CODEGRAPH_BIN`, an existing CLI that does not run (never replaced), a permission error writing `~/.codegraph` or `~/.local/bin` (fix their ownership, then retry), a broken mcp.json entry.
- **`failed`** (with the error tail and the manual `curl … | sh` command): the download, install.sh, or the re-check failed.
- **Already installed**: `ok`, nothing runs. Upgrades stay with you (`codegraph upgrade`). It never writes mcp.json and never creates an index (`/codegraph init`). One install runs at a time per session.

## Configuration

| Variable | Effect |
|---|---|
| `PI_CODEGRAPH_MCP` | `auto` (default), `always` or `off`. |
| `PI_CODEGRAPH_BIN` | Path of the `codegraph` executable. |
| `CODEGRAPH_MCP_TOOLS` | Upstream: re-enables more MCP tools, e.g. `explore,node,search,callers,callees,impact,files,status` (tiny projects: at most search, node, explore). The stdio server inherits Pi's environment, and the extra tools are declared directly too. |
| `CODEGRAPH_DIR`, `CODEGRAPH_NO_DAEMON`, `CODEGRAPH_TELEMETRY=0`, … | Upstream settings, passed through the same way. |

### An existing `mcp.json` entry wins

If `~/.pi/agent/mcp.json` (or a trusted project's `.pi/mcp.json`) already defines a server named `codegraph`, for example from a manual setup, Pi gives that entry precedence over this extension's registration: its command, exposure and `enabled: false` stay in force, and there is still only one `codegraph` server and one set of tools. `/codegraph status` names the file. Remove the entry only if you want this extension's defaults (auto registration, direct exposure); the extension never edits it.

If another extension already registered `codegraph`, Pi rejects the second registration; this extension leaves it alone and `/codegraph status` shows the reason.

## orche workers

orche workers never inherit the main session's extensions or MCP servers. Orche asks every worker and sub-worker for the `codegraph` capability (pi-orche's `orche:worker-capability` channel, `src/worker.ts`), and this extension answers with:

- Pi's MCP extension for that worker session only (no mcp.json of its own; one process-wide factory shared with pi-gui, so orche loads it once even for a GUI worker), and
- the `codegraph` server: your `codegraph` mcp.json entry when there is one (command, args, env and URL kept, merged as Pi merges a trusted project's `.pi/mcp.json` override; a project file counts only for the main session's own trusted directory and may not use `auth`), else `codegraph serve --mcp` from the CLI, always with `exposure: "direct"` because workers have no `tool_search` or codemode. `hidden` tool exposures stay hidden.

The worker's tool allowlist names every upstream tool (`mcp__codegraph__codegraph_explore`, `_search`, `_node`, `_callers`, `_callees`, `_impact`, `_files`, `_status`); only the ones the server lists exist, so by default the worker has `codegraph_explore`, and `CODEGRAPH_MCP_TOOLS` (Pi's environment or the entry's `env`) decides the rest. Upstream also limits tiny projects to search, node and explore. The worker's instructions say when to use it.

When a worker gets nothing, or is told why:

| Situation | Worker |
|---|---|
| `PI_CODEGRAPH_MCP=off`, or the mcp.json entry has `enabled: false` or `exposure: "hidden"` | nothing (your choice is kept) |
| auto mode and no index at or above the worker's directory (a local server) | told "CodeGraph unavailable: … no CodeGraph index"; result `details.codeGraphUnavailable` |
| no CLI and no mcp.json entry | told "CodeGraph unavailable: codegraph CLI not found …" |
| pi-codegraph not loaded in the main session, or an orche without the `codegraph` capability | nothing |

The worker's server starts with its session and stops with it (retirement, idle expiry, `/orche stop`, session end). A worker that already exists keeps its tools; when the answer changes (an index appears, the config changes), orche replaces the reused worker with a fresh one. After updating the packages, `/reload` (or restart Pi) so the main session runs the new orche and pi-codegraph; workers started after that get the tools.

Read-only roles get the tools as well: every upstream tool is marked `readOnlyHint`. The server (or the shared upstream daemon) may still update `.codegraph/` through its file watcher; that directory ignores itself in git.

## Notes from upstream

- The MCP server shares one background daemon per project between clients; `codegraph daemon` lists and stops them. `CODEGRAPH_NO_DAEMON=1` serves in-process instead.
- CodeGraph sends anonymous usage statistics unless turned off (`codegraph telemetry off`, `CODEGRAPH_TELEMETRY=0` or `DO_NOT_TRACK=1`); see upstream's TELEMETRY.md.
- `codegraph_explore` returns dense, verbatim source that stays in the context window; upstream measures fewer tool calls and tokens processed, but more resident context in long sessions.
- The CLI offers more than the MCP tool (`query`, `callers`, `callees`, `impact`, `affected`, `files`, `explore`); the model can run those through bash, and `codegraph uninit` removes a project's index.

## Install

Bundled in [oh-my-pi-extensions](https://github.com/zmfkzj/oh-my-pi-extensions) as the `codegraph/` submodule. On its own:

```sh
pi install git:github.com/zmfkzj/pi-codegraph
# or from a local checkout
pi install /path/to/pi-codegraph
```

It has no runtime npm dependencies (Pi is the host); orche workers get CodeGraph only when the main session runs an orche that asks for the `codegraph` capability.

## Development

```sh
npm install
npm run typecheck
npm test   # unit tests (doctor/install-deps with fake binaries, a fake runner and a temporary HOME: nothing is downloaded), plus real Pi session + real codegraph CLI tests (skipped when the CLI is missing)
```

`test/pi-mcp.test.ts` loads the extension with Pi's resource loader and built-in MCP extension in an isolated agent directory, runs `/codegraph init` on a copy of `test/fixtures/sample` in a path with spaces, and calls `codegraph_explore` through Pi; it also checks that a user `mcp.json` entry (other exposure, or `enabled: false`) keeps precedence.

`test/worker-session.test.ts` answers orche's `codegraph` request from the real extension in a main session, builds a worker session from the answer the way orche's session factory does (only the capability's factories, a tool allowlist, `bindExtensions`), and calls the real `codegraph_explore` there; `test/worker.test.ts` covers the mcp.json merge, trust and hidden/disabled rules.
