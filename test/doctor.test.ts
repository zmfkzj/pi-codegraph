// `/codegraph doctor` and `/codegraph install-deps` (src/doctor.ts) with a fake process runner, fake executables and a
// temporary HOME: nothing is downloaded or installed for real.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createCodegraphExtension } from "../src/index.ts";
import {
  createCodegraphDependencyProvider, INSTALL_COMMAND, INSTALL_SCRIPT_URL, WINDOWS_INSTALL_COMMAND, type DoctorOptions,
} from "../src/doctor.ts";
import { DEPENDENCY_CHANNEL, dependencyOutcome, formatDependencyReport, type DependencyProvider, type DependencyReport, type RunResult } from "../src/dependencies.ts";
import { completeArguments } from "../src/core.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

interface Call { command: string; args: string[]; env?: NodeJS.ProcessEnv }
interface Behaviour {
  /** What `codegraph --version` does. */
  version?: "ok" | "fail";
  curl?: "ok" | "fail";
  /** What running install.sh does. */
  installer?: "ok" | "eacces" | "fail" | "noop";
}

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

function setup(t: TestContext, options: { binary?: boolean; index?: boolean; tools?: string[]; env?: Record<string, string>; behaviour?: Behaviour; overrides?: Partial<DoctorOptions> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi codegraph doctor "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "my project");
  const bin = join(dir, "bin");
  const tools = join(dir, "tools");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const tool of options.tools ?? ["curl", "sh", "tar"]) executable(join(tools, tool));
  const binary = join(bin, "codegraph");
  if (options.binary) executable(binary);
  if (options.index) { mkdirSync(join(cwd, ".codegraph")); writeFileSync(join(cwd, ".codegraph", "codegraph.db"), ""); }
  const behaviour: Behaviour = { version: "ok", curl: "ok", installer: "ok", ...options.behaviour };
  const calls: Call[] = [];
  const result = (code: number, stdout = "", stderr = ""): RunResult => ({ code, stdout, stderr });
  const run = async (command: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> => {
    calls.push({ command, args, env: opts.env });
    if (args[0] === "--version") return behaviour.version === "ok" ? result(0, "1.6.2\n") : result(127, "", "error while loading shared libraries: libnode.so");
    if (command.endsWith("curl")) {
      if (behaviour.curl === "fail") return result(6, "", "curl: (6) Could not resolve host: raw.githubusercontent.com");
      writeFileSync(args.at(-1)!, "#!/bin/sh\n# fake install.sh\n");
      return result(0);
    }
    if (command.endsWith("sh")) {
      assert.ok(existsSync(args[0]!), "install.sh was downloaded before it runs");
      if (behaviour.installer === "eacces") return result(1, "", `mkdir: cannot create directory '${home}/.codegraph/versions': Permission denied`);
      if (behaviour.installer === "fail") return result(1, "Installing CodeGraph v1.6.2 (linux-x64)...", "codegraph: download failed: https://github.com/...");
      if (behaviour.installer === "ok") executable(join(home, ".local", "bin", "codegraph"));
      return result(0, "Done. Run: codegraph --help");
    }
    return result(1, "", `unexpected ${command}`);
  };
  const doctorOptions: DoctorOptions = {
    agentDir, env: { PATH: tools, ...options.env }, home, pathDirs: [bin], platform: "linux", arch: "x64", run, packageDir, tmpDir: dir,
    ...options.overrides,
  };
  const provider = createCodegraphDependencyProvider(doctorOptions);
  const ctx = { cwd, isProjectTrusted: () => true };
  const item = (report: DependencyReport, name: string) => report.items.find(entry => entry.name === name);
  return { dir, home, agentDir, cwd, bin, binary, calls, provider, ctx, item, behaviour };
}

const installerCalls = (calls: Call[]) => calls.filter(call => call.args[0] !== "--version");

test("doctor: a working CLI and an indexed project are healthy; only --version runs", async (t) => {
  const s = setup(t, { binary: true, index: true });
  const report = await s.provider.check(s.ctx);
  assert.equal(dependencyOutcome(report, "check"), "healthy");
  assert.deepEqual(s.item(report, "codegraph CLI"), { name: "codegraph CLI", status: "ok", detail: `${s.binary} (PATH), v1.6.2` });
  assert.deepEqual(s.item(report, "project index"), { name: "project index", status: "ok", detail: join(s.cwd, ".codegraph") });
  assert.deepEqual(s.calls.map(call => [call.command, ...call.args]), [[s.binary, "--version"]]);
  assert.equal(formatDependencyReport("pi-codegraph", report, "check").level, "info");
  assert.equal(report.items.some(entry => entry.name.startsWith("npm")), false, "the package has no runtime npm dependencies");
});

test("doctor: a missing CLI is an error with the install action; a missing index is an optional warning; nothing is installed", async (t) => {
  const s = setup(t);
  const report = await s.provider.check(s.ctx);
  assert.equal(dependencyOutcome(report, "check"), "abnormal");
  const cli = s.item(report, "codegraph CLI")!;
  assert.equal(cli.status, "error");
  assert.match(cli.action!, /\/codegraph install-deps .*install\.sh into ~\/\.codegraph and ~\/\.local\/bin, no sudo/);
  assert.ok(cli.action!.includes(INSTALL_COMMAND));
  const index = s.item(report, "project index")!;
  assert.equal(index.status, "warn");
  assert.equal(index.optional, true);
  assert.match(index.action!, /^Run \/codegraph init in this project after installing the CLI/);
  assert.deepEqual(s.calls, [], "check runs no installer (and no CLI that is not there)");
  assert.equal(existsSync(join(s.cwd, ".codegraph")), false, "check never creates an index");
  const text = formatDependencyReport("pi-codegraph", report, "check");
  assert.equal(text.level, "error");
  assert.match(text.text, /^pi-codegraph doctor: abnormal\n {2}\[error\] codegraph CLI: not found/);
});

test("doctor: a CLI whose --version fails, or a wrong PI_CODEGRAPH_BIN, is an error with a fix", async (t) => {
  const broken = setup(t, { binary: true, index: true, behaviour: { version: "fail" } });
  const report = await broken.provider.check(broken.ctx);
  const cli = broken.item(report, "codegraph CLI")!;
  assert.equal(cli.status, "error");
  assert.match(cli.detail!, /--version` exited 127: .*libnode/);
  assert.match(cli.action!, /PI_CODEGRAPH_BIN/);
  const wrong = setup(t, { env: { PI_CODEGRAPH_BIN: "/nowhere/codegraph" } });
  const wrongCli = wrong.item(await wrong.provider.check(wrong.ctx), "codegraph CLI")!;
  assert.equal(wrongCli.status, "error");
  assert.match(wrongCli.detail!, /PI_CODEGRAPH_BIN=\/nowhere\/codegraph is not an executable file/);
  assert.match(wrongCli.action!, /unset it/);
  const install = await wrong.provider.install(wrong.ctx);
  assert.equal(wrong.item(install, "codegraph CLI")!.status, "manual");
  assert.deepEqual(installerCalls(wrong.calls), [], "an explicit PI_CODEGRAPH_BIN is never overridden by an install");
});

test("doctor: an mcp.json entry takes precedence, so the local CLI is not required; secrets in it are not shown", async (t) => {
  const remote = setup(t);
  writeFileSync(join(remote.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { codegraph: { url: "https://user:s3cret@cg.example/mcp", headers: { Authorization: "Bearer s3cret" } } } }));
  const report = await remote.provider.check(remote.ctx);
  assert.equal(dependencyOutcome(report, "check"), "healthy");
  assert.match(remote.item(report, 'mcp.json "codegraph" entry')!.detail!, /remote server .*agent\/mcp\.json takes precedence/);
  assert.match(remote.item(report, "codegraph CLI")!.detail!, /not installed; not needed for MCP: .*remote server/);
  assert.equal(remote.item(report, "project index")!.status, "ok");
  assert.ok(!JSON.stringify(report).includes("s3cret"));
  const installed = await remote.provider.install(remote.ctx);
  assert.equal(remote.item(installed, "codegraph CLI")!.status, "ok");
  assert.deepEqual(installerCalls(remote.calls), [], "install-deps does not download a CLI the configuration does not need");

  const custom = setup(t);
  mkdirSync(join(custom.cwd, ".pi"));
  writeFileSync(join(custom.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { codegraph: { command: "/opt/missing/codegraph", args: ["serve", "--mcp"] } } }));
  const customReport = await custom.provider.check(custom.ctx);
  const entry = custom.item(customReport, 'mcp.json "codegraph" entry')!;
  assert.equal(entry.status, "error");
  assert.match(entry.action!, /Fix the "codegraph" entry's command in .*\.pi\/mcp\.json/);
  assert.equal(custom.item(customReport, "codegraph CLI")!.status, "ok");
  assert.equal(custom.item(await custom.provider.install(custom.ctx), 'mcp.json "codegraph" entry')!.status, "manual", "install-deps never edits mcp.json");
  const untrusted = await custom.provider.check({ ...custom.ctx, isProjectTrusted: () => false });
  assert.equal(untrusted.items.some(item => item.name.startsWith("mcp.json")), false, "an untrusted project's mcp.json is ignored, as Pi does");
  assert.equal(custom.item(untrusted, "codegraph CLI")!.status, "error");

  const disabled = setup(t);
  writeFileSync(join(disabled.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { codegraph: { enabled: false } } }));
  const disabledReport = await disabled.provider.check(disabled.ctx);
  assert.match(disabled.item(disabledReport, 'mcp.json "codegraph" entry')!.detail!, /enabled: false/);
  assert.equal(disabled.item(disabledReport, "codegraph CLI")!.status, "ok");
});

test("install-deps installs a missing CLI with upstream's install.sh into the user's HOME, re-checks it, and is idempotent", async (t) => {
  const s = setup(t, { env: { CODEGRAPH_BIN_DIR: "/usr/local/bin", CODEGRAPH_INSTALL_DIR: "/opt/codegraph" } });
  const report = await s.provider.install(s.ctx);
  const cli = s.item(report, "codegraph CLI")!;
  const local = join(s.home, ".local", "bin", "codegraph");
  assert.equal(cli.status, "installed", JSON.stringify(report));
  assert.match(cli.detail!, new RegExp(`^${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(installer location\\), v1\\.6\\.2; .*not on PATH`));
  assert.match(cli.action!, /\/codegraph init/);
  const [curl, sh] = installerCalls(s.calls);
  assert.deepEqual(curl!.args.slice(0, 2), ["-fsSL", INSTALL_SCRIPT_URL]);
  assert.match(sh!.command, /sh$/);
  assert.equal(sh!.env!.HOME, s.home);
  assert.equal(sh!.env!.CODEGRAPH_BIN_DIR, undefined, "installs where the CLI resolution looks");
  assert.equal(sh!.env!.CODEGRAPH_INSTALL_DIR, undefined);
  assert.equal(s.item(report, "project index")!.status, "warn");
  assert.equal(existsSync(join(s.cwd, ".codegraph")), false, "install-deps never creates an index");
  assert.equal(existsSync(join(s.agentDir, "mcp.json")), false, "install-deps never writes mcp.json");
  assert.equal(existsSync(sh!.args[0]!), false, "the downloaded install.sh is removed");

  const before = s.calls.length;
  const again = await s.provider.install(s.ctx);
  assert.equal(s.item(again, "codegraph CLI")!.status, "ok");
  assert.match(s.item(again, "codegraph CLI")!.detail!, /^already installed: .*v1\.6\.2; upgrades stay with you: codegraph upgrade/);
  assert.deepEqual(installerCalls(s.calls.slice(before)), [], "an existing CLI is never reinstalled or upgraded");
});

test("install-deps: an existing working CLI is ok; a broken one is manual and never replaced", async (t) => {
  const ok = setup(t, { binary: true, index: true });
  const report = await ok.provider.install(ok.ctx);
  assert.equal(dependencyOutcome(report, "install"), "already available");
  assert.deepEqual(installerCalls(ok.calls), []);
  const broken = setup(t, { binary: true, behaviour: { version: "fail" } });
  const brokenCli = broken.item(await broken.provider.install(broken.ctx), "codegraph CLI")!;
  assert.equal(brokenCli.status, "manual");
  assert.match(brokenCli.detail!, /does not replace an existing CLI/);
  assert.deepEqual(installerCalls(broken.calls), []);
});

test("install-deps failures: download, installer error, permissions, nothing found afterwards", async (t) => {
  const network = setup(t, { behaviour: { curl: "fail" } });
  const networkCli = network.item(await network.provider.install(network.ctx), "codegraph CLI")!;
  assert.equal(networkCli.status, "failed");
  assert.match(networkCli.detail!, /downloading install\.sh failed \(curl exited 6\): .*Could not resolve host/);
  assert.equal(networkCli.action, `Run it by hand and read the error: ${INSTALL_COMMAND}`);
  assert.equal(installerCalls(network.calls).length, 1, "install.sh does not run when the download failed");

  const failing = setup(t, { behaviour: { installer: "fail" } });
  const failingReport = await failing.provider.install(failing.ctx);
  assert.equal(dependencyOutcome(failingReport, "install"), "failed");
  assert.match(failing.item(failingReport, "codegraph CLI")!.detail!, /install\.sh exited 1: .*download failed/);

  const denied = setup(t, { behaviour: { installer: "eacces" } });
  const deniedCli = denied.item(await denied.provider.install(denied.ctx), "codegraph CLI")!;
  assert.equal(deniedCli.status, "manual");
  assert.match(deniedCli.detail!, /Permission denied/);
  assert.match(deniedCli.action!, /writable by your user .*chown .*then run \/codegraph install-deps again/);

  const silent = setup(t, { behaviour: { installer: "noop" } });
  const silentCli = silent.item(await silent.provider.install(silent.ctx), "codegraph CLI")!;
  assert.equal(silentCli.status, "failed");
  assert.match(silentCli.detail!, /still not found/);
});

test("install-deps: Windows, unsupported platforms and missing curl/tar are manual with the exact command", async (t) => {
  const windows = setup(t, { overrides: { platform: "win32" } });
  const windowsCli = windows.item(await windows.provider.install(windows.ctx), "codegraph CLI")!;
  assert.equal(windowsCli.status, "manual");
  assert.ok(windowsCli.action!.includes(WINDOWS_INSTALL_COMMAND));
  assert.ok(windows.item(await windows.provider.check(windows.ctx), "codegraph CLI")!.action!.includes(WINDOWS_INSTALL_COMMAND));
  const riscv = setup(t, { overrides: { arch: "riscv64" } });
  const riscvCli = riscv.item(await riscv.provider.install(riscv.ctx), "codegraph CLI")!;
  assert.equal(riscvCli.status, "manual");
  assert.match(riscvCli.detail!, /not linux-riscv64/);
  const noCurl = setup(t, { tools: ["sh"] });
  const noCurlCli = noCurl.item(await noCurl.provider.install(noCurl.ctx), "codegraph CLI")!;
  assert.equal(noCurlCli.status, "manual");
  assert.match(noCurlCli.detail!, /needs curl, tar/);
  for (const s of [windows, riscv, noCurl]) assert.deepEqual(installerCalls(s.calls), []);
});

test("install-deps: overlapping installs share one run", async (t) => {
  const s = setup(t);
  const [first, second] = await Promise.all([s.provider.install(s.ctx), s.provider.install(s.ctx)]);
  assert.equal(first, second);
  assert.equal(installerCalls(s.calls).filter(call => call.command.endsWith("sh")).length, 1);
});

test("PI_CODEGRAPH_MCP: an invalid value is an optional warning, off is reported", async (t) => {
  const invalid = setup(t, { binary: true, index: true, env: { PI_CODEGRAPH_MCP: "maybe" } });
  const item = invalid.item(await invalid.provider.check(invalid.ctx), "PI_CODEGRAPH_MCP")!;
  assert.equal(item.status, "warn");
  assert.match(item.action!, /auto, always or off/);
  const off = setup(t, { binary: true, index: true, env: { PI_CODEGRAPH_MCP: "off" } });
  assert.match(off.item(await off.provider.check(off.ctx), "PI_CODEGRAPH_MCP")!.detail!, /^off: /);
});

function extension(t: TestContext, options: { binary?: boolean } = {}) {
  const s = setup(t, options);
  const channels = new Map<string, ((data: unknown) => void)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; description?: string }>();
  const notes: { text: string; level: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const registered: string[] = [];
  const pi = {
    on: () => undefined,
    events: {
      on: (channel: string, handler: (data: unknown) => void) => { channels.set(channel, [...(channels.get(channel) ?? []), handler]); return () => undefined; },
      emit: (channel: string, data: unknown) => { for (const handler of channels.get(channel) ?? []) handler(data); },
    },
    registerCommand: (name: string, command: never) => { commands.set(name, command); },
    registerMcpServer: (name: string) => { registered.push(name); },
    unregisterMcpServer: () => undefined,
    getAllTools: () => [],
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  };
  createCodegraphExtension({
    agentDir: s.agentDir, env: { PATH: join(s.dir, "tools") }, home: s.home, pathDirs: [s.bin], platform: "linux", arch: "x64",
    dependencyRunner: (command, args, opts) => setupRun(s, command, args, opts),
    tmpDir: s.dir,
  })(pi as never);
  const ctx = {
    cwd: s.cwd, hasUI: true, isProjectTrusted: () => true,
    ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  return { ...s, pi, commands, notes, statuses, registered, command: (args: string) => commands.get("codegraph")!.handler(args, ctx) };
}

/** The same fake runner as `setup`'s, for the extension (which builds its own provider). */
function setupRun(s: ReturnType<typeof setup>, command: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  s.calls.push({ command, args, env: opts.env });
  if (args[0] === "--version") return Promise.resolve({ code: 0, stdout: "1.6.2\n", stderr: "" });
  if (command.endsWith("curl")) { writeFileSync(args.at(-1)!, "#!/bin/sh\n"); return Promise.resolve({ code: 0, stdout: "", stderr: "" }); }
  if (command.endsWith("sh")) { executable(join(s.home, ".local", "bin", "codegraph")); return Promise.resolve({ code: 0, stdout: "Done.", stderr: "" }); }
  return Promise.resolve({ code: 1, stdout: "", stderr: "unexpected" });
}

test("the provider answers the umbrella's synchronous request on the dependencies channel", (t) => {
  const h = extension(t);
  const answers: DependencyProvider[] = [];
  h.pi.events.emit(DEPENDENCY_CHANNEL, { version: 1, provide: (provider: DependencyProvider) => answers.push(provider) });
  assert.equal(answers.length, 1, "answered synchronously, inside the handler");
  assert.deepEqual([answers[0]!.id, answers[0]!.label, answers[0]!.command], ["codegraph", "pi-codegraph", "/codegraph"]);
  h.pi.events.emit(DEPENDENCY_CHANNEL, { version: 1 });
  assert.equal(answers.length, 1, "malformed requests are ignored");
});

test("/codegraph doctor and install-deps notify the formatted report; other words keep their meaning", async (t) => {
  const h = extension(t);
  await h.command("doctor");
  assert.match(h.notes.at(-1)!.text, /^pi-codegraph doctor: abnormal\n/);
  assert.equal(h.notes.at(-1)!.level, "error");
  assert.deepEqual(installerCalls(h.calls), []);
  await h.command("install-deps");
  assert.match(h.notes.at(-1)!.text, /^pi-codegraph install-deps: warning\n.*\[installed\] codegraph CLI: /s);
  assert.match(h.notes.at(-1)!.text, /\[warn\] project index \(optional\): .*\n {6}-> Run \/codegraph init in this project/);
  assert.equal(h.notes.at(-1)!.level, "warning");
  assert.deepEqual(h.statuses, ["codegraph: installing dependencies…", undefined]);
  await h.command("install-deps");
  assert.match(h.notes.at(-1)!.text, /\[ok\] codegraph CLI: already installed/);
  await h.command("doctor now");
  assert.match(h.notes.at(-1)!.text, /^Usage: \/codegraph \[status\] \| init \| sync \| doctor \| install-deps \| help$/);
  await h.command("help");
  assert.match(h.notes.at(-1)!.text, /doctor: check .*\n install-deps: install a missing CLI/);
  assert.match(h.commands.get("codegraph")!.description!, /doctor \| install-deps/);
  assert.deepEqual(completeArguments("i")?.map(item => item.value), ["init", "install-deps"]);
  assert.deepEqual(completeArguments("d")?.map(item => item.value), ["doctor"]);
});
