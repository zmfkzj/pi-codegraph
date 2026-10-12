// Real integration of the orche worker capability: the extension, loaded into a main session by Pi's resource loader,
// answers orche's `codegraph` request on that session's event bus; the answer's factories are then loaded into a separate
// worker session the way orche's session factory does it (orche/src/pi/session-factory.ts: a DefaultResourceLoader with
// only those factories, a tool allowlist, bindExtensions), and the real `codegraph serve --mcp` answers codegraph_explore
// there. The user's mcp.json is never read by that session. Skipped when the codegraph CLI is not installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { resolveCodegraphBinary } from "../src/core.ts";
import { WORKER_EXPLORE_TOOL, WORKER_TOOLS, type WorkerCapabilityAnswer } from "../src/worker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const binary = resolveCodegraphBinary();
const skip = binary.ok ? false : `codegraph CLI not installed: ${binary.ok ? "" : binary.message}`;
const NO_RESOURCES = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } as const;

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi codegraph worker it "));
  const agentDir = join(root, "agent dir");
  const project = join(root, "my project");
  mkdirSync(agentDir, { recursive: true });
  cpSync(join(here, "fixtures", "sample"), project, { recursive: true });
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, noDaemon: process.env.CODEGRAPH_NO_DAEMON };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CODEGRAPH_NO_DAEMON = "1"; // in-process server: nothing outlives the test
  execFileSync((binary as { path: string }).path, ["init", "--yes", project], { stdio: "ignore" });
  const sessions: AgentSession[] = [];
  t.after(async () => {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agentDir], ["CODEGRAPH_NO_DAEMON", saved.noDaemon]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(done => setTimeout(done, 300));
    rmSync(root, { recursive: true, force: true });
  });

  // Main: the real extension, on an event bus the test can emit on (orche emits on main's pi.events).
  const eventBus = createEventBus();
  const settingsManager = SettingsManager.inMemory({});
  const mainLoader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager, eventBus, additionalExtensionPaths: [resolve(here, "../src/index.ts")], ...NO_RESOURCES });
  await mainLoader.reload();
  assert.deepEqual(mainLoader.getExtensions().errors, []);
  const { session: main } = await createAgentSession({ cwd: project, agentDir, resourceLoader: mainLoader, settingsManager, sessionManager: SessionManager.inMemory(project) });
  sessions.push(main);
  await main.bindExtensions({});

  const ask = (role: string, readOnly: boolean) => {
    let answer: WorkerCapabilityAnswer | { error: string } | undefined;
    eventBus.emit("orche:worker-capability", { capability: "codegraph", cwd: project, workerId: "W1", role, readOnly, provide: (value: typeof answer) => { answer ??= value; } });
    return answer;
  };

  // A worker session as orche builds it: the capability's factories only, the allowlist, then bound.
  const worker = async (answer: WorkerCapabilityAnswer, extra: WorkerCapabilityAnswer["extensionFactories"] = []) => {
    const loader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager: SettingsManager.inMemory({}), extensionFactories: [...new Set([...extra, ...answer.extensionFactories])], ...NO_RESOURCES });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: project, agentDir, resourceLoader: loader, tools: ["read", "grep", ...answer.tools],
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), sessionManager: SessionManager.inMemory(project),
    });
    sessions.push(session);
    await session.bindExtensions({});
    return session;
  };
  const waitForTool = async (session: AgentSession) => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise(done => setTimeout(done, 200))) {
      if (session.getActiveToolNames().includes(WORKER_EXPLORE_TOOL)) return true;
    }
    return false;
  };
  const explore = async (session: AgentSession, query: string) => {
    const result = await session.getToolDefinition(WORKER_EXPLORE_TOOL)!.execute("call-1", { query }, undefined, undefined, session.extensionRunner.createContext() as never);
    return result.content.map(block => block.type === "text" ? block.text : "").join("\n");
  };
  return { project, agentDir, main, ask, worker, waitForTool, explore };
}

test("a read-only worker session discovers and calls the real codegraph_explore; the main session has no worker tools", { skip, timeout: 180_000 }, async (t) => {
  const h = await setup(t);
  const answer = h.ask("answer", true);
  assert.ok(answer && "key" in answer, JSON.stringify(answer));
  assert.deepEqual(answer.tools, WORKER_TOOLS);
  const session = await h.worker(answer);
  assert.equal(await h.waitForTool(session), true, "the worker's own server connected");
  const active = session.getActiveToolNames();
  assert.ok(active.includes("read"));
  assert.deepEqual(active.filter(name => name.startsWith("mcp__")), [WORKER_EXPLORE_TOOL], "only what the server lists (upstream default: explore)");
  assert.equal(session.getAllTools().find(tool => tool.name === WORKER_EXPLORE_TOOL)?.exposure, "direct");
  const text = await h.explore(session, "sum add totalReport");
  assert.match(text, /src\/math\.ts/);
  assert.match(text, /export function sum\(values: number\[\]\): number/);
  assert.match(text, /src\/report\.ts/);
});

test("CODEGRAPH_MCP_TOOLS re-enables more tools, and the worker allowlist activates exactly what the server lists", { skip, timeout: 180_000 }, async (t) => {
  const saved = process.env.CODEGRAPH_MCP_TOOLS;
  // Upstream gates tiny projects (like the fixture) to search, node and explore, whatever the allowlist says.
  process.env.CODEGRAPH_MCP_TOOLS = "explore,search";
  t.after(() => { if (saved === undefined) delete process.env.CODEGRAPH_MCP_TOOLS; else process.env.CODEGRAPH_MCP_TOOLS = saved; });
  const h = await setup(t);
  const answer = h.ask("implement", false) as WorkerCapabilityAnswer;
  const session = await h.worker(answer);
  assert.equal(await h.waitForTool(session), true);
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && !session.getActiveToolNames().includes("mcp__codegraph__codegraph_search");) await new Promise(done => setTimeout(done, 100));
  assert.deepEqual(session.getActiveToolNames().filter(name => name.startsWith("mcp__")).sort(), [WORKER_EXPLORE_TOOL, "mcp__codegraph__codegraph_search"]);
});

test("with another provider's copy of the shared MCP factory (pi-gui) the worker session loads one MCP extension", { skip, timeout: 180_000 }, async (t) => {
  const h = await setup(t);
  const answer = h.ask("answer", true) as WorkerCapabilityAnswer;
  // pi-gui's workerMcpExtension() returns the same process-wide object; orche merges factories by identity.
  const session = await h.worker(answer, [answer.extensionFactories[0]!]);
  assert.equal(await h.waitForTool(session), true);
  const mcpCommands = session.extensionRunner.getRegisteredCommands().filter(command => command.name === "mcp");
  assert.equal(mcpCommands.length, 1, "one /mcp: one MCP extension");
  assert.match(await h.explore(session, "totalReport"), /src\/report\.ts/);
});
