// The extension against a recording fake of the ExtensionAPI: registration decisions, the /codegraph command and
// the precedence report. The real Pi MCP connection to the real CLI is covered by pi-mcp.test.ts.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createCodegraphExtension, EXPLORE_TOOL, SERVER_NAME } from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Exec { command: string; args: string[]; cwd?: string }

function harness(t: TestContext, options: { env?: Record<string, string>; index?: boolean; binary?: boolean; registerThrows?: string; onExec?: (call: Exec) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi codegraph ext "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "my project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const binary = join(dir, "bin", "codegraph");
  if (options.binary !== false) {
    mkdirSync(join(dir, "bin"));
    writeFileSync(binary, "#!/bin/sh\n");
    chmodSync(binary, 0o755);
  }
  const makeIndex = () => { mkdirSync(join(cwd, ".codegraph"), { recursive: true }); writeFileSync(join(cwd, ".codegraph", "codegraph.db"), ""); };
  if (options.index) makeIndex();
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: unknown }>();
  const servers = new Map<string, unknown>();
  const calls: string[] = [];
  const execs: Exec[] = [];
  const notes: { text: string; level: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const channels = new Map<string, ((data: unknown) => void)[]>();
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      on: (channel: string, handler: (data: unknown) => void) => { channels.set(channel, [...(channels.get(channel) ?? []), handler]); return () => undefined; },
      emit: (channel: string, data: unknown) => { for (const handler of channels.get(channel) ?? []) handler(data); },
    },
    registerCommand: (name: string, command: never) => { commands.set(name, command); },
    registerMcpServer: (name: string, config: unknown) => {
      if (options.registerThrows) throw new Error(options.registerThrows);
      calls.push(`register ${name}`); servers.set(name, config);
    },
    unregisterMcpServer: (name: string) => { calls.push(`unregister ${name}`); servers.delete(name); },
    getAllTools: () => servers.has(SERVER_NAME) ? [{ name: EXPLORE_TOOL, exposure: "direct" }] : [],
    exec: async (command: string, args: string[], opts?: { cwd?: string }) => {
      const call = { command, args, cwd: opts?.cwd };
      execs.push(call);
      options.onExec?.(call);
      if (args[0] === "--version") return { stdout: "1.6.2\n", stderr: "", code: 0, killed: false };
      if (args.includes("init")) makeIndex();
      return { stdout: `\x1b[1mran ${args.slice(1).join(" ")}\x1b[0m\n│\n`, stderr: "", code: 0, killed: false };
    },
  };
  createCodegraphExtension({ agentDir, env: { PATH: "", ...options.env }, home: join(dir, "home"), pathDirs: [join(dir, "bin")] })(pi as never);
  const ctx = {
    cwd, hasUI: true, signal: undefined, isProjectTrusted: () => true,
    ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "startup" }, ctx); };
  const command = (args: string) => commands.get("codegraph")!.handler(args, ctx);
  /** What orche asks on pi.events for a worker; the first answer wins, as in orche. */
  const ask = (request: { capability: string; cwd: string; role?: string; readOnly?: boolean }) => {
    let answer: unknown;
    pi.events.emit("orche:worker-capability", { workerId: "W1", ...request, provide: (value: unknown) => { answer ??= value; } });
    return answer as { key: string; tools: string[]; extensionFactories: unknown[]; instructions?: string; toolTimeoutsMs?: Record<string, number> } | { error: string } | undefined;
  };
  return { dir, agentDir, cwd, binary, calls, servers, execs, notes, statuses, commands, emit, command, makeIndex, ask };
}

test("session_start registers upstream's MCP server for an indexed project, and only then", async (t) => {
  const h = harness(t, { index: true });
  await h.emit("session_start");
  assert.deepEqual(h.calls, ["register codegraph"]);
  assert.deepEqual(h.servers.get(SERVER_NAME), {
    command: h.binary, args: ["serve", "--mcp"], exposure: "direct",
    description: (h.servers.get(SERVER_NAME) as { description: string }).description,
  });
  await h.emit("session_start");
  assert.deepEqual(h.calls, ["register codegraph"], "an unchanged registration is not repeated");
  await h.emit("session_shutdown");
  await h.emit("session_start");
  assert.deepEqual(h.calls, ["register codegraph", "register codegraph"], "a new session registers again");
  rmSync(join(h.cwd, ".codegraph"), { recursive: true });
  await h.emit("session_start");
  assert.deepEqual(h.calls.at(-1), "unregister codegraph", "a removed index withdraws the server");
});

test("no registration without an index (auto), without the CLI, or with PI_CODEGRAPH_MCP=off; always ignores the index", async (t) => {
  const noIndex = harness(t);
  await noIndex.emit("session_start");
  assert.deepEqual(noIndex.calls, []);
  const noBinary = harness(t, { index: true, binary: false });
  await noBinary.emit("session_start");
  assert.deepEqual(noBinary.calls, []);
  const off = harness(t, { index: true, env: { PI_CODEGRAPH_MCP: "off" } });
  await off.emit("session_start");
  assert.deepEqual(off.calls, []);
  const always = harness(t, { env: { PI_CODEGRAPH_MCP: "always" } });
  await always.emit("session_start");
  assert.deepEqual(always.calls, ["register codegraph"]);
  const invalid = harness(t, { index: true, env: { PI_CODEGRAPH_MCP: "maybe" } });
  await invalid.emit("session_start");
  assert.deepEqual(invalid.calls, ["register codegraph"], "an invalid mode falls back to auto");
  assert.match(invalid.notes[0]!.text, /PI_CODEGRAPH_MCP=maybe/);
});

test("a name another extension owns does not break the session and is reported", async (t) => {
  const h = harness(t, { index: true, registerThrows: 'MCP server "codegraph" is registered by another extension' });
  await h.emit("session_start");
  await h.command("status");
  assert.match(h.notes.at(-1)!.text, /MCP: not registered: MCP server "codegraph" is registered by another extension/);
});

test("/codegraph init indexes the session directory, then connects the server without a reload", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  assert.deepEqual(h.calls, []);
  await h.command("init");
  assert.deepEqual(h.execs.at(-1), { command: h.binary, args: ["--no-color", "init", "--yes", h.cwd], cwd: h.cwd });
  assert.deepEqual(h.calls, ["register codegraph"]);
  assert.match(h.notes.at(-1)!.text, /ran init --yes .*\nMCP: registered "codegraph"/);
  assert.ok(!h.notes.at(-1)!.text.includes("\x1b["), "ANSI escapes are stripped");
  assert.deepEqual(h.statuses, ["codegraph: indexing…", undefined]);
  await h.command("init");
  assert.match(h.notes.at(-1)!.text, /already indexed/);
  await h.command("sync");
  assert.deepEqual(h.execs.at(-1)!.args, ["--no-color", "sync", h.cwd]);
});

test("/codegraph sync needs an index, unknown arguments show usage, and a missing CLI is an error", async (t) => {
  const h = harness(t);
  await h.command("sync");
  assert.match(h.notes.at(-1)!.text, /no index .*run \/codegraph init first/);
  assert.equal(h.execs.length, 0);
  await h.command("index --force");
  assert.match(h.notes.at(-1)!.text, /^Usage: \/codegraph/);
  const missing = harness(t, { binary: false });
  await missing.command("init");
  assert.equal(missing.notes.at(-1)!.level, "error");
  assert.match(missing.notes.at(-1)!.text, /codegraph CLI not found/);
});

test("/codegraph status reports the CLI, registration, tool, index and a user mcp.json entry that takes precedence", async (t) => {
  const h = harness(t, { index: true });
  writeFileSync(join(h.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { codegraph: { command: "~/.local/bin/codegraph", args: ["serve", "--mcp"] } } }));
  await h.emit("session_start");
  await h.command("");
  const text = h.notes.at(-1)!.text;
  assert.match(text, new RegExp(`CLI: ${h.binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(PATH, v1\\.6\\.2\\)`));
  assert.match(text, /MCP: your .*agent\/mcp\.json entry "codegraph" takes precedence/);
  assert.match(text, /MCP: registered "codegraph" \(direct, index at /);
  assert.match(text, /Tool: mcp__codegraph__codegraph_explore available/);
  assert.match(text, /Index: .*my project\/\.codegraph/);
  assert.match(text, /ran status /);
  assert.equal(typeof h.commands.get("codegraph")!.getArgumentCompletions, "function");
});

test("orche asks for the codegraph capability: the main extension answers for an indexed directory, and only for codegraph", async (t) => {
  const h = harness(t, { index: true });
  await h.emit("session_start");
  assert.equal(h.ask({ capability: "web-fetch", cwd: h.cwd }), undefined, "other capabilities are not answered");
  const answer = h.ask({ capability: "codegraph", cwd: h.cwd, role: "answer", readOnly: true });
  assert.ok(answer && "key" in answer, JSON.stringify(answer));
  assert.ok(answer.tools.includes("mcp__codegraph__codegraph_explore"));
  assert.equal(answer.extensionFactories.length, 2);
  assert.match(answer.instructions!, /CodeGraph: mcp__codegraph__codegraph_explore/);
  const other = harness(t);
  await other.emit("session_start");
  assert.match((other.ask({ capability: "codegraph", cwd: other.cwd }) as { error: string }).error, /no CodeGraph index/);
});
