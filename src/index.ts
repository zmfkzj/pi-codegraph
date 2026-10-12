import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cleanOutput, completeArguments, decide, EXPLORE_TOOL, fileConfiguredServer, findProjectIndex, parseMode,
  resolveCodegraphBinary, SERVER_NAME, serverConfig, type BinaryResolution, type Decision, type Environment,
} from "./core.ts";
import { answerWorkerCapability, isWorkerCapabilityRequest, WORKER_CAPABILITY_CHANNEL } from "./worker.ts";

export * from "./core.ts";
export * from "./worker.ts";

export interface CodegraphExtensionOptions extends Environment {
  agentDir?: string;
}

export const USAGE = "Usage: /codegraph [status] | init | sync | help";

/**
 * pi-codegraph: connects the upstream CodeGraph MCP server (`codegraph serve --mcp`, tool `codegraph_explore`)
 * through Pi's built-in MCP support, and adds `/codegraph` to inspect, index and sync the current project.
 * Indexing stays a user action, as upstream asks: the model gets no tool that builds an index.
 */
export function createCodegraphExtension(options: CodegraphExtensionOptions = {}) {
  return function codegraph(pi: ExtensionAPI): void {
    const env = options.env ?? process.env;
    const agentDir = options.agentDir ?? getAgentDir();
    let registeredKey: string | undefined;
    let lastDecision: Decision | undefined;
    let lastError: string | undefined;
    let binary: BinaryResolution | undefined;

    const fileSources = (ctx: ExtensionContext) => fileConfiguredServer([
      join(agentDir, "mcp.json"),
      ...(ctx.isProjectTrusted() ? [join(ctx.cwd, ".pi", "mcp.json")] : []),
    ]);

    /** Register or withdraw the server for this session's directory; returns what it decided. */
    const apply = (ctx: ExtensionContext): Decision => {
      const { mode, warning } = parseMode(env.PI_CODEGRAPH_MCP);
      if (warning && ctx.hasUI) ctx.ui.notify(`codegraph: ${warning}`, "warning");
      binary = resolveCodegraphBinary({ ...options, env });
      const decision = decide({ mode, binary, index: findProjectIndex(ctx.cwd, env) });
      lastDecision = decision;
      if (decision.register && binary.ok) {
        const config = serverConfig(binary.path);
        const key = JSON.stringify(config);
        if (key !== registeredKey) {
          try {
            pi.registerMcpServer(SERVER_NAME, config);
            registeredKey = key;
            lastError = undefined;
          } catch (error) {
            // e.g. another extension already registered `codegraph`: leave it alone and report it.
            registeredKey = undefined;
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
      } else {
        lastError = undefined;
        if (registeredKey) pi.unregisterMcpServer(SERVER_NAME);
        registeredKey = undefined;
      }
      return decision;
    };

    let project: { cwd: string; trusted: boolean } | undefined;
    pi.on("session_start", (_event, ctx) => { project = { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }; apply(ctx); });

    // orche workers and sub-workers: each gets its own CodeGraph MCP connection in its own session (src/worker.ts).
    pi.events.on(WORKER_CAPABILITY_CHANNEL, data => {
      if (!isWorkerCapabilityRequest(data)) return;
      answerWorkerCapability(data, { ...options, env, agentDir, project: () => project });
    });
    // Pi closes MCP connections itself; forget the key so the next session registers again.
    pi.on("session_shutdown", () => { registeredKey = undefined; });

    const connected = () => pi.getAllTools().some(tool => tool.name === EXPLORE_TOOL && tool.exposure !== "hidden");

    const run = async (ctx: ExtensionCommandContext, path: string, args: string[], label: string) => {
      if (ctx.hasUI) ctx.ui.setStatus("codegraph", `codegraph: ${label}…`);
      try {
        return await pi.exec(path, ["--no-color", ...args], { cwd: ctx.cwd, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      } finally {
        if (ctx.hasUI) ctx.ui.setStatus("codegraph", undefined);
      }
    };

    const status = async (ctx: ExtensionCommandContext): Promise<string> => {
      const decision = apply(ctx);
      const lines: string[] = [];
      const files = fileSources(ctx);
      if (binary?.ok) {
        const version = await pi.exec(binary.path, ["--version"], { cwd: ctx.cwd, timeout: 15_000 }).catch(() => undefined);
        lines.push(`CLI: ${binary.path} (${binary.source}${version?.code === 0 ? `, v${version.stdout.trim()}` : ""})`);
      } else lines.push(`CLI: ${binary?.message}`);
      if (files.length) lines.push(`MCP: your ${files.join(", ")} entry "${SERVER_NAME}" takes precedence over this extension's registration.`);
      if (lastError) lines.push(`MCP: not registered: ${lastError}`);
      else if (registeredKey) lines.push(`MCP: registered "${SERVER_NAME}" (direct, ${decision.reason})`);
      else lines.push(`MCP: not registered (${decision.reason})`);
      lines.push(`Tool: ${EXPLORE_TOOL} ${connected() ? "available" : "not available"}`);
      const index = findProjectIndex(ctx.cwd, env);
      lines.push(index ? `Index: ${index.dir}` : `Index: none at or above ${ctx.cwd}`);
      if (index && binary?.ok) {
        const result = await run(ctx, binary.path, ["status", index.root], "status");
        lines.push(cleanOutput(result.stdout + result.stderr));
      }
      return lines.join("\n");
    };

    pi.registerCommand("codegraph", {
      description: "CodeGraph code graph: /codegraph [status] | init | sync | help",
      getArgumentCompletions: completeArguments,
      handler: async (args, ctx) => {
        const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const notify = (text: string, level: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(text, level); };
        if (rest.length || !["status", "init", "sync", "help"].includes(sub)) return notify(USAGE, "warning");
        if (sub === "help") {
          return notify(`${USAGE}\n status: CLI, MCP and index state\n init: index this directory (codegraph init --yes), then connect the MCP server\n sync: update the index (codegraph sync)\nEnv: PI_CODEGRAPH_MCP=auto|always|off, PI_CODEGRAPH_BIN, CODEGRAPH_MCP_TOOLS`);
        }
        if (sub === "status") return notify(await status(ctx));
        apply(ctx);
        if (!binary?.ok) return notify(`codegraph: ${binary?.message}`, "error");
        const index = findProjectIndex(ctx.cwd, env);
        if (sub === "sync") {
          if (!index) return notify(`codegraph: no index at or above ${ctx.cwd}; run /codegraph init first.`, "warning");
          const result = await run(ctx, binary.path, ["sync", index.root], "syncing");
          return notify(cleanOutput(result.stdout + result.stderr) || `codegraph sync exited ${result.code}`, result.code === 0 ? "info" : "error");
        }
        if (index) return notify(`codegraph: ${ctx.cwd} is already indexed at ${index.dir}; use /codegraph sync.`, "warning");
        const result = await run(ctx, binary.path, ["init", "--yes", ctx.cwd], "indexing");
        const output = cleanOutput(result.stdout + result.stderr) || `codegraph init exited ${result.code}`;
        if (result.code !== 0) return notify(output, "error");
        const decision = apply(ctx);
        notify(`${output}\nMCP: ${registeredKey ? `registered "${SERVER_NAME}"` : lastError ?? `not registered (${decision.reason})`}`);
      },
    });
  };
}

export default createCodegraphExtension();
