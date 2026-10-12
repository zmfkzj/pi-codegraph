// The orche worker capability `codegraph` (src/worker.ts): which server a worker gets, how the user's mcp.json is honoured,
// and the shared MCP extension factory. The real worker session path is covered by test/worker-session.test.ts.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  answerWorkerCapability, effectiveServerEntry, serverProjectDir, WORKER_TOOLS, workerMcpExtension, workerServerConfig,
  type WorkerCapabilityAnswer, type WorkerProviderOptions,
} from "../src/worker.ts";

function setup(t: TestContext, options: { index?: boolean; binary?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi codegraph worker "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "my project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (options.index !== false) { mkdirSync(join(cwd, ".codegraph")); writeFileSync(join(cwd, ".codegraph", "codegraph.db"), ""); }
  const binary = join(dir, "bin", "codegraph");
  if (options.binary !== false) { mkdirSync(join(dir, "bin")); writeFileSync(binary, "#!/bin/sh\n"); chmodSync(binary, 0o755); }
  const mcp = (file: string, servers: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  const base: WorkerProviderOptions = { agentDir, env: { PATH: "" }, home: join(dir, "home"), pathDirs: [join(dir, "bin")], project: () => ({ cwd, trusted: true }) };
  const ask = (overrides: Partial<WorkerProviderOptions> = {}, cwdOverride = cwd) => {
    let answer: WorkerCapabilityAnswer | { error: string } | undefined;
    answerWorkerCapability({ capability: "codegraph", cwd: cwdOverride, workerId: "W1", role: "answer", readOnly: true, provide: value => { answer ??= value; } }, { ...base, ...overrides });
    return answer;
  };
  /** The server config the answer's registration factory registers. */
  const registered = (answer: unknown) => {
    const servers: [string, unknown][] = [];
    const factories = (answer as WorkerCapabilityAnswer).extensionFactories;
    void factories[1]!({ registerMcpServer: (name: string, config: unknown) => { servers.push([name, config]); } } as never);
    return servers;
  };
  return { dir, agentDir, cwd, binary, mcp, ask, registered, globalMcp: join(agentDir, "mcp.json"), projectMcp: join(cwd, ".pi", "mcp.json") };
}

test("without a user entry: the CLI's own server, direct, every upstream tool name allowed, shared MCP factory first", (t) => {
  const s = setup(t);
  const answer = s.ask() as WorkerCapabilityAnswer;
  assert.deepEqual(answer.tools, WORKER_TOOLS);
  assert.equal(WORKER_TOOLS.length, 8);
  assert.equal(answer.extensionFactories[0], workerMcpExtension(), "the process-wide shared MCP factory");
  assert.equal(workerMcpExtension(), workerMcpExtension());
  assert.deepEqual(s.registered(answer), [["codegraph", { command: s.binary, args: ["serve", "--mcp"], exposure: "direct", description: (s.registered(answer)[0]![1] as { description: string }).description }]]);
  assert.equal(answer.toolTimeoutsMs!["mcp__codegraph__codegraph_explore"], 120_000);
  assert.match(answer.instructions!, /index of .*my project/);
  assert.match(answer.key, /^[0-9a-f]{16}$/);
});

test("off, a disabled or hidden user entry: no answer at all; no index or no CLI: an error the worker is told", (t) => {
  const s = setup(t);
  assert.equal(s.ask({ env: { PATH: "", PI_CODEGRAPH_MCP: "off" } }), undefined);
  s.mcp(s.globalMcp, { codegraph: { command: "codegraph", args: ["serve", "--mcp"], enabled: false } });
  assert.equal(s.ask(), undefined);
  s.mcp(s.globalMcp, { codegraph: { command: "codegraph", args: ["serve", "--mcp"], exposure: "hidden" } });
  assert.equal(s.ask(), undefined);
  const noIndex = setup(t, { index: false });
  assert.match((noIndex.ask() as { error: string }).error, /has no CodeGraph index .*\/codegraph init/);
  assert.ok("key" in (noIndex.ask({ env: { PATH: "", PI_CODEGRAPH_MCP: "always" } }) as object), "always skips the index check");
  const noCli = setup(t, { binary: false });
  assert.match((noCli.ask() as { error: string }).error, /codegraph CLI not found/);
});

test("the user's entry is the worker's server: command, args and env kept, exposure direct, hidden tools stay hidden", (t) => {
  const s = setup(t, { binary: false });
  s.mcp(s.globalMcp, { codegraph: {
    command: "~/.local/bin/codegraph", args: ["serve", "--mcp"], env: { CODEGRAPH_MCP_TOOLS: "$MY_TOOLS", SECRET_TOKEN: "s3cr3t-value" },
    exposure: "deferred", toolExposure: { codegraph_status: "hidden", "codegraph_s*": "codemode" }, description: "mine",
  } });
  const answer = s.ask() as WorkerCapabilityAnswer;
  assert.deepEqual(s.registered(answer), [["codegraph", {
    command: "~/.local/bin/codegraph", args: ["serve", "--mcp"], env: { CODEGRAPH_MCP_TOOLS: "$MY_TOOLS", SECRET_TOKEN: "s3cr3t-value" },
    exposure: "direct", toolExposure: { codegraph_status: "hidden" }, description: "mine",
  }]]);
  assert.ok(!JSON.stringify({ key: answer.key, tools: answer.tools, instructions: answer.instructions }).includes("s3cr3t"), "no server env in what orche keeps");
});

test("project mcp.json: an override changes only enabled/exposure/toolExposure; a full entry replaces; auth stays global-only", (t) => {
  const s = setup(t);
  s.mcp(s.globalMcp, { codegraph: { command: "/opt/codegraph", args: ["serve", "--mcp"], env: { A: "1" } } });
  s.mcp(s.projectMcp, { codegraph: { exposure: "direct" } });
  assert.deepEqual(effectiveServerEntry(s.agentDir, s.cwd), { command: "/opt/codegraph", args: ["serve", "--mcp"], env: { A: "1" }, exposure: "direct" });
  s.mcp(s.projectMcp, { codegraph: { enabled: false } });
  assert.equal(s.ask(), undefined, "the project turns it off for its workers");
  s.mcp(s.projectMcp, { codegraph: { enabled: false, command: undefined, args: ["x"] } });
  assert.deepEqual(effectiveServerEntry(s.agentDir, s.cwd)?.command, "/opt/codegraph", "an override with other keys is ignored, as Pi does");
  s.mcp(s.projectMcp, { codegraph: { command: "/project/codegraph", args: ["serve", "--mcp"] } });
  assert.equal(effectiveServerEntry(s.agentDir, s.cwd)?.command, "/project/codegraph");
  s.mcp(s.projectMcp, { codegraph: { url: "https://example.test/mcp", auth: { provider: "x" } } });
  assert.equal(effectiveServerEntry(s.agentDir, s.cwd)?.command, "/opt/codegraph", "a project entry using auth is refused");
});

test("the project mcp.json counts only for the main session's trusted directory", (t) => {
  const s = setup(t);
  s.mcp(s.projectMcp, { codegraph: { command: "/project/codegraph", args: ["serve", "--mcp"] } });
  const command = (answer: unknown) => (s.registered(answer)[0]![1] as { command: string }).command;
  assert.equal(command(s.ask()), "/project/codegraph");
  assert.equal(command(s.ask({ project: () => ({ cwd: s.cwd, trusted: false }) })), s.binary, "untrusted: ignored");
  const other = join(s.dir, "other");
  mkdirSync(join(other, ".pi"), { recursive: true });
  mkdirSync(join(other, ".codegraph"));
  writeFileSync(join(other, ".codegraph", "codegraph.db"), "");
  writeFileSync(join(other, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { codegraph: { command: "/unapproved/codegraph" } } }));
  assert.equal(command(s.ask({}, other)), s.binary, "a worker in another directory never runs that directory's server command");
});

test("an HTTP server or a server with its own --path/cwd is not refused for a missing local index", (t) => {
  const s = setup(t, { index: false });
  s.mcp(s.globalMcp, { codegraph: { url: "http://127.0.0.1:9/mcp" } });
  assert.ok("key" in (s.ask() as object));
  const indexed = join(s.dir, "indexed repo");
  mkdirSync(join(indexed, ".codegraph"), { recursive: true });
  writeFileSync(join(indexed, ".codegraph", "codegraph.db"), "");
  s.mcp(s.globalMcp, { codegraph: { command: "codegraph", args: ["serve", "--mcp", "--path", indexed] } });
  assert.match((s.ask() as WorkerCapabilityAnswer).instructions!, /index of .*indexed repo/);
  assert.equal(serverProjectDir({ args: ["serve", "--path=~/x"] }, "/w", "/home/u"), "/home/u/x");
  assert.equal(serverProjectDir({ cwd: "sub", args: ["-p", "repo"] }, "/w"), "/w/sub/repo");
  assert.equal(serverProjectDir({ args: ["serve"] }, "/w"), "/w");
});

test("workerServerConfig keeps only hidden tool exposures and refuses a disabled or hidden server", () => {
  assert.equal(workerServerConfig({ command: "c", enabled: false }), undefined);
  assert.equal(workerServerConfig({ command: "c", exposure: "hidden" }), undefined);
  assert.deepEqual(workerServerConfig({ command: "c", exposure: "codemode", toolExposure: { a: "direct" } }), { command: "c", exposure: "direct", description: workerServerConfig({ command: "c" })!.description });
});

test("a config Pi rejects leaves the worker session without CodeGraph instead of failing it", (t) => {
  const s = setup(t);
  const answer = s.ask() as WorkerCapabilityAnswer;
  assert.doesNotThrow(() => answer.extensionFactories[1]!({ registerMcpServer: () => { throw new Error("invalid"); } } as never));
});
