// Real integration: Pi's own resource loader, session and built-in MCP extension load this extension in an isolated
// agent directory (no user mcp.json), `/codegraph init` runs the real CLI on a copy of test/fixtures/sample in a
// path with spaces, and the real `codegraph serve --mcp` answers `codegraph_explore` through Pi's tool definition.
// Skipped when the codegraph CLI is not installed.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { EXPLORE_TOOL, resolveCodegraphBinary, SERVER_NAME } from "../src/core.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../src/index.ts");
const binary = resolveCodegraphBinary();
const skip = binary.ok ? false : `codegraph CLI not installed: ${binary.ok ? "" : binary.message}`;

async function start(t: TestContext, setup: (paths: { agentDir: string; project: string }) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "pi codegraph it "));
  const agentDir = join(root, "agent dir");
  const project = join(root, "my project");
  mkdirSync(agentDir, { recursive: true });
  cpSync(join(here, "fixtures", "sample"), project, { recursive: true });
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, noDaemon: process.env.CODEGRAPH_NO_DAEMON };
  process.env.PI_CODING_AGENT_DIR = agentDir; // the MCP extension reads <agent dir>/mcp.json
  // Serve in-process, so the stdio server Pi stops is the whole server (no detached shared daemon outlives the test).
  process.env.CODEGRAPH_NO_DAEMON = "1";
  let session: AgentSession | undefined;
  t.after(async () => {
    try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
    finally {
      session?.dispose();
      for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.agentDir], ["CODEGRAPH_NO_DAEMON", previous.noDaemon]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  setup({ agentDir, project });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: project, agentDir, settingsManager, additionalExtensionPaths: [extensionPath],
    extensionFactories: [createMcpExtension({ logPath: join(root, "mcp.log") })],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const created = await createAgentSession({ cwd: project, agentDir, modelRuntime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(project) });
  session = created.session;
  const current = created.session;
  const notes: string[] = [];
  const errors: string[] = [];
  // A headless UI: notifications are recorded, every other UI method is a no-op (Pi copies the methods it binds).
  const methods = ["addAutocompleteProvider", "confirm", "getAllThemes", "getEditorComponent", "getEditorText", "getTheme", "getToolsExpanded",
    "input", "onTerminalInput", "pasteToEditor", "select", "setEditorComponent", "setEditorText", "setFooter", "setHeader", "setHiddenThinkingLabel",
    "setStatus", "setTheme", "setTitle", "setToolsExpanded", "setWidget", "setWorkingIndicator", "setWorkingMessage", "setWorkingVisible"];
  const ui = { ...Object.fromEntries(methods.map(name => [name, () => undefined])), notify: (text: string) => { notes.push(text); } };
  await current.bindExtensions({ uiContext: ui as never, onError: error => errors.push(String((error as { error?: unknown }).error ?? error)) });
  // Read the runner on each use: a reload replaces it.
  const command = (args: string) => current.extensionRunner.getCommand("codegraph")!.handler(args, current.extensionRunner.createCommandContext());
  const tool = () => current.getAllTools().find(info => info.name === EXPLORE_TOOL);
  const waitFor = async <T>(probe: () => T | undefined, ms: number): Promise<T | undefined> => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise(done => setTimeout(done, 200))) {
      const value = probe();
      if (value) return value;
    }
    return probe();
  };
  return { session: current, project, agentDir, notes, errors, command, tool, waitFor };
}

test("isolated Pi session: /codegraph init indexes the project and the real codegraph_explore tool answers", { skip, timeout: 180_000 }, async (t) => {
  const h = await start(t);
  assert.equal(h.session.extensionRunner.getRegisteredCommands().some(command => command.name === "codegraph"), true);
  assert.equal(await h.waitFor(h.tool, 2_000), undefined, "no server for a project without an index");

  await h.command("init");
  assert.equal(existsSync(join(h.project, ".codegraph", "codegraph.db")), true, h.notes.join("\n"));
  assert.match(h.notes.at(-1)!, /MCP: registered "codegraph"/);
  const info = await h.waitFor(h.tool, 60_000);
  assert.ok(info, `the explore tool connects; errors: ${h.errors.join("; ")}`);
  assert.equal(info.exposure, "direct");
  assert.ok(h.session.getActiveToolNames().includes(EXPLORE_TOOL), "declared to the model");

  const explore = async () => {
    const definition = h.session.getToolDefinition(EXPLORE_TOOL)!;
    const result = await definition.execute("call-1", { query: "sum add totalReport" }, undefined, undefined, h.session.extensionRunner.createContext() as never);
    return result.content.map(block => block.type === "text" ? block.text : "").join("\n");
  };
  const text = await explore();
  assert.match(text, /src\/math\.ts/);
  assert.match(text, /export function sum\(values: number\[\]\): number/);
  assert.match(text, /src\/report\.ts/);

  await h.command("status");
  assert.match(h.notes.at(-1)!, /Tool: mcp__codegraph__codegraph_explore available/);
  assert.match(h.notes.at(-1)!, /Files:\s+2/);
  writeFileSync(join(h.project, "src", "extra.ts"), "export function triple(x: number): number { return x * 3; }\n");
  await h.command("sync");
  assert.doesNotMatch(h.notes.at(-1)!, /error|not initialized/i);

  // /reload: a new extension runtime registers the server again at its session_start.
  await h.session.reload();
  assert.ok(await h.waitFor(h.tool, 60_000), `the tool is back after reload; errors: ${h.errors.join("; ")}`);
  assert.match(await explore(), /export function sum/);
});

test("a user mcp.json codegraph entry keeps precedence over the extension's registration", { skip, timeout: 180_000 }, async (t) => {
  // Index first, outside Pi, so the extension registers at session start; the user's entry picks another exposure.
  const h = await start(t, ({ agentDir, project }) => {
    const { execFileSync } = process.getBuiltinModule("node:child_process");
    execFileSync((binary as { path: string }).path, ["init", "--yes", project], { stdio: "ignore" });
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: (binary as { path: string }).path, args: ["serve", "--mcp"], exposure: "deferred" } } }));
  });
  const info = await h.waitFor(h.tool, 60_000);
  assert.ok(info, `the user's server connects; errors: ${h.errors.join("; ")}`);
  assert.equal(info.exposure, "deferred", "the mcp.json entry wins over the extension's direct registration");
  assert.equal(h.session.getAllTools().filter(tool => tool.name.startsWith(`mcp__${SERVER_NAME}__`)).length, 1, "one server, no duplicate tools");
  await h.command("status");
  assert.match(h.notes.at(-1)!, /entry "codegraph" takes precedence/);
  assert.match(h.notes.at(-1)!, /MCP: registered "codegraph"/, "the registration exists and is overridden, not dropped");
  assert.deepEqual(h.errors, []);
});

test("a user mcp.json entry with enabled: false stays disabled", { skip, timeout: 180_000 }, async (t) => {
  const h = await start(t, ({ agentDir, project }) => {
    const { execFileSync } = process.getBuiltinModule("node:child_process");
    execFileSync((binary as { path: string }).path, ["init", "--yes", project], { stdio: "ignore" });
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: (binary as { path: string }).path, args: ["serve", "--mcp"], enabled: false } } }));
  });
  assert.equal(await h.waitFor(h.tool, 8_000), undefined, "the disabled user entry is not replaced by the registration");
  await h.command("status");
  assert.match(h.notes.at(-1)!, /entry "codegraph" takes precedence[\s\S]*MCP: registered "codegraph"[\s\S]*Tool: mcp__codegraph__codegraph_explore not available/);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.notes.slice(0, -1), [], "the override raises no startup notice");
});
