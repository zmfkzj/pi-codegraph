/**
 * orche worker capability `codegraph`: every orche worker and sub-worker (orche asks for each one, with its cwd and role)
 * gets its own connection to the CodeGraph MCP server in its own session, never the main session's MCP instance.
 *
 * Contract (orche's WorkerCapabilityProvider): orche emits `{ capability, cwd, workerId?, role?, readOnly?, provide }` on
 * `pi.events` channel {@link WORKER_CAPABILITY_CHANNEL}; the answer lists the extension factories to load into the
 * worker's session and the exact tool names to allow there, or `{ error }`, which orche tells the worker.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createMcpExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  findProjectIndex, parseMode, resolveCodegraphBinary, SERVER_DESCRIPTION, SERVER_NAME, serverConfig, type Environment,
} from "./core.ts";

export const WORKER_CAPABILITY_CHANNEL = "orche:worker-capability";
export const CODEGRAPH_CAPABILITY = "codegraph";
/** The tools upstream defines (`codegraph_<name>`); all are read-only (`readOnlyHint: true`). Upstream lists only explore by default. */
export const UPSTREAM_TOOLS = ["explore", "search", "node", "callers", "callees", "impact", "files", "status"] as const;
/** Liveness bound of one call: a large explore on a cold daemon can take a while. */
export const WORKER_TOOL_TIMEOUT_MS = 120_000;

export interface WorkerCapabilityRequest {
  capability: string;
  cwd: string;
  workerId?: string;
  role?: string;
  readOnly?: boolean;
  provide(answer: WorkerCapabilityAnswer | { error: string }): void;
}
export interface WorkerCapabilityAnswer {
  key: string;
  tools: string[];
  extensionFactories: ExtensionFactory[];
  instructions?: string;
  toolTimeoutsMs?: Record<string, number>;
}

export function isWorkerCapabilityRequest(value: unknown): value is WorkerCapabilityRequest {
  const request = value as Partial<WorkerCapabilityRequest> | undefined;
  return !!request && typeof request.capability === "string" && typeof request.cwd === "string" && typeof request.provide === "function";
}

const SHARED_WORKER_MCP = Symbol.for("pi.orche.worker-mcp-extension");
/**
 * Pi's MCP extension for a worker session: only the servers that session's extensions register, never the user's
 * mcp.json. One factory object per process, shared through `globalThis` with other capability providers (pi-gui), so
 * orche, which merges capability factories by identity, loads one MCP extension per worker session, not one per
 * provider (two would each connect every registered server).
 */
export function workerMcpExtension(): ExtensionFactory {
  const store = globalThis as { [SHARED_WORKER_MCP]?: ExtensionFactory };
  return store[SHARED_WORKER_MCP] ??= createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) });
}

type ServerEntry = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const namespace = (name: string) => name.replace(/-/g, "_");

/** The `codegraph` entry of one Pi mcp.json (exact name first, then a name differing only in `-`/`_`), if any. */
export function readServerEntry(path: string): ServerEntry | undefined {
  try {
    const servers = (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown })?.mcpServers;
    if (!isRecord(servers)) return undefined;
    const name = SERVER_NAME in servers ? SERVER_NAME : Object.keys(servers).find(key => namespace(key) === namespace(SERVER_NAME));
    const entry = name ? servers[name] : undefined;
    return isRecord(entry) ? entry : undefined;
  } catch { return undefined; }
}

/** Pi's MCP config rule: an entry without `command`, `url` or `type` only overrides `enabled`, `exposure` and `toolExposure`. */
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];
const isOverride = (entry: ServerEntry) => entry.command === undefined && entry.url === undefined && entry.type === undefined;

/**
 * The user's effective `codegraph` server entry, merged the way Pi's MCP config loader does: the global mcp.json, then the
 * trusted project's `.pi/mcp.json` (only for `projectDir`, the directory whose trust is known): a full project entry
 * replaces the global one (but may not use `auth`, which only the global file may set), an override entry changes only
 * `enabled`, `exposure` and `toolExposure` and keeps the rest of the global one (credentials included). Undefined: none.
 */
export function effectiveServerEntry(agentDir: string, projectDir: string | undefined): ServerEntry | undefined {
  const global = readServerEntry(join(agentDir, "mcp.json"));
  const project = projectDir ? readServerEntry(join(projectDir, ".pi", "mcp.json")) : undefined;
  if (!project) return global;
  if (isOverride(project)) {
    if (!global || Object.keys(project).some(key => !OVERRIDE_KEYS.includes(key))) return global;
    return { ...global, ...project };
  }
  if (project.url !== undefined && project.auth !== undefined) return global;
  return project;
}

/**
 * The worker's server config from the user's entry: the same server, but `direct` (workers have no tool_search or codemode).
 * What the user hid stays hidden: a `hidden` server is not given to workers (undefined), and `hidden` tool entries are kept.
 */
export function workerServerConfig(entry: ServerEntry): ServerEntry | undefined {
  if (entry.enabled === false || entry.exposure === "hidden") return undefined;
  const { enabled: _enabled, exposure: _exposure, toolExposure, ...rest } = entry;
  const hidden = isRecord(toolExposure) ? Object.entries(toolExposure).filter(([, value]) => value === "hidden") : [];
  return {
    ...rest, exposure: "direct", ...(hidden.length ? { toolExposure: Object.fromEntries(hidden) } : {}),
    description: typeof rest.description === "string" ? rest.description : SERVER_DESCRIPTION,
  };
}

/** Where a stdio server looks for its index: its `--path`/`-p` argument or its `cwd` (relative to the session's), else the session's. */
export function serverProjectDir(config: ServerEntry, cwd: string, home = homedir()): string {
  const expand = (value: string) => value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
  const at = args.findIndex(arg => arg === "--path" || arg === "-p");
  const inline = args.find(arg => arg.startsWith("--path="));
  const base = typeof config.cwd === "string" ? resolve(cwd, expand(config.cwd)) : cwd;
  const path = at >= 0 ? args[at + 1] : inline?.slice("--path=".length);
  return path ? resolve(base, expand(path)) : base;
}

/**
 * Every tool upstream defines, as Pi names it. The worker's allowlist names them all: a name is usable only when the server
 * lists that tool (by default only codegraph_explore; `CODEGRAPH_MCP_TOOLS` decides, however the server's env sets it).
 */
export const WORKER_TOOLS = UPSTREAM_TOOLS.map(name => `mcp__${SERVER_NAME}__codegraph_${name}`);
export const WORKER_EXPLORE_TOOL = `mcp__${SERVER_NAME}__codegraph_explore`;

export function workerInstructions(root: string | undefined): string {
  return [
    `CodeGraph: ${WORKER_EXPLORE_TOOL} answers questions about this project's code from a pre-built local code graph${root ? ` (index of ${root})` : ""}: symbols, definitions, callers/callees, call paths and change impact, with the relevant source in one call. Other mcp__${SERVER_NAME}__codegraph_* tools are present only when the server enables them.`,
    `Use it first for "where is / how does / what calls / what breaks if" questions instead of a grep/read crawl, then read or grep only what it did not cover. It only reads; the index follows file changes after a short delay, so re-check code you just edited with read.`,
  ].join("\n");
}

export interface WorkerProviderOptions extends Environment {
  agentDir: string;
  /**
   * The main session's directory and whether it is trusted: only that directory's `.pi/mcp.json` is read (Pi reads a project
   * mcp.json only for a trusted project), so a worker in another directory never runs a server command from an unapproved one.
   */
  project?: () => { cwd: string; trusted: boolean } | undefined;
}

/**
 * Answer one capability request. Silent (no answer, the worker gets nothing) when the user turned CodeGraph off:
 * `PI_CODEGRAPH_MCP=off`, or a `codegraph` mcp.json entry with `enabled: false` or `exposure: "hidden"`. `{ error }`, which
 * orche tells the worker, when it cannot run for this worker: no index for its directory (auto mode, local servers), no CLI.
 */
export function answerWorkerCapability(request: WorkerCapabilityRequest, options: WorkerProviderOptions): void {
  if (request.capability !== CODEGRAPH_CAPABILITY) return;
  const env = options.env ?? process.env;
  const { mode } = parseMode(env.PI_CODEGRAPH_MCP);
  if (mode === "off") return;
  const main = options.project?.();
  const trustedDir = main?.trusted && resolve(main.cwd) === resolve(request.cwd) ? main.cwd : undefined;
  const entry = effectiveServerEntry(options.agentDir, trustedDir);
  let config: ServerEntry | undefined;
  if (entry) {
    config = workerServerConfig(entry);
    if (!config) return;
  }
  // An HTTP server has its own index; a local one reads the index of its project directory.
  const index = config?.url !== undefined ? undefined : findProjectIndex(config ? serverProjectDir(config, request.cwd, options.home) : request.cwd, env);
  if (mode === "auto" && config?.url === undefined && !index) {
    return request.provide({ error: `CodeGraph unavailable: ${request.cwd} has no CodeGraph index (the main session can run /codegraph init).` });
  }
  if (!config) {
    const binary = resolveCodegraphBinary({ ...options, env });
    if (!binary.ok) return request.provide({ error: `CodeGraph unavailable: ${binary.message}` });
    config = { ...serverConfig(binary.path) };
  }
  const server = config;
  request.provide({
    // A digest, so a server env or header (which may hold secrets) never lands in orche's worker metadata.
    key: createHash("sha256").update(JSON.stringify({ server, root: index?.root })).digest("hex").slice(0, 16),
    tools: [...WORKER_TOOLS],
    // An entry Pi rejects (invalid config) leaves the worker without the tools instead of failing its session.
    extensionFactories: [workerMcpExtension(), (pi: ExtensionAPI) => { try { pi.registerMcpServer(SERVER_NAME, server as never); } catch { /* the worker runs without CodeGraph */ } }],
    instructions: workerInstructions(index?.root),
    toolTimeoutsMs: Object.fromEntries(WORKER_TOOLS.map(name => [name, WORKER_TOOL_TIMEOUT_MS])),
  });
}
