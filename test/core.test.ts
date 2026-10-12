import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  cleanOutput, completeArguments, decide, EXPLORE_TOOL, fileConfiguredServer, findProjectIndex, parseMode,
  resolveCodegraphBinary, SERVER_NAME, serverConfig,
} from "../src/core.ts";

function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi codegraph core "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function script(path: string, mode = 0o755): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho 1.0.0\n");
  chmodSync(path, mode);
  return path;
}

test("binary: PI_CODEGRAPH_BIN wins, then PATH, then the installer locations", (t) => {
  const dir = temp(t);
  const home = join(dir, "home");
  const explicit = script(join(dir, "custom", "cg"));
  const onPath = script(join(dir, "bin", "codegraph"));
  const local = script(join(home, ".local", "bin", "codegraph"));
  const env = { PATH: "" };
  assert.deepEqual(resolveCodegraphBinary({ env: { PI_CODEGRAPH_BIN: explicit }, home, pathDirs: [join(dir, "bin")] }), { ok: true, path: explicit, source: "PI_CODEGRAPH_BIN" });
  assert.deepEqual(resolveCodegraphBinary({ env, home, pathDirs: ["relative", join(dir, "bin")] }), { ok: true, path: onPath, source: "PATH" });
  assert.deepEqual(resolveCodegraphBinary({ env, home, pathDirs: [] }), { ok: true, path: local, source: "installer location" });
  rmSync(local);
  const current = script(join(home, ".codegraph", "current", "bin", "codegraph"));
  assert.deepEqual(resolveCodegraphBinary({ env, home, pathDirs: [] }), { ok: true, path: current, source: "installer location" });
});

test("binary: a missing or non-executable binary is reported, never guessed", { skip: process.platform === "win32" }, (t) => {
  const dir = temp(t);
  const plain = script(join(dir, "bin", "codegraph"), 0o644);
  const bad = resolveCodegraphBinary({ env: { PI_CODEGRAPH_BIN: plain }, home: dir, pathDirs: [] });
  assert.equal(bad.ok, false);
  assert.match((bad as { message: string }).message, /PI_CODEGRAPH_BIN=.* is not an executable file/);
  const missing = resolveCodegraphBinary({ env: {}, home: dir, pathDirs: [join(dir, "bin")] });
  assert.equal(missing.ok, false);
  assert.match((missing as { message: string }).message, /codegraph CLI not found.*install\.sh/);
});

test("index: nearest .codegraph/codegraph.db at or above cwd; the CLI's own ~/.codegraph is not an index", (t) => {
  const dir = temp(t);
  const project = join(dir, "my project");
  mkdirSync(join(dir, ".codegraph", "versions"), { recursive: true }); // like the install dir in $HOME
  mkdirSync(join(project, "src", "deep"), { recursive: true });
  assert.equal(findProjectIndex(join(project, "src"), {}), undefined);
  mkdirSync(join(project, ".codegraph"));
  writeFileSync(join(project, ".codegraph", "codegraph.db"), "");
  assert.deepEqual(findProjectIndex(join(project, "src", "deep"), {}), { root: project, dir: join(project, ".codegraph") });
  mkdirSync(join(project, "src", ".codegraph-wsl"));
  writeFileSync(join(project, "src", ".codegraph-wsl", "codegraph.db"), "");
  assert.deepEqual(findProjectIndex(join(project, "src", "deep"), {}), { root: join(project, "src"), dir: join(project, "src", ".codegraph-wsl") });
  assert.deepEqual(findProjectIndex(join(project, "src", "deep"), { CODEGRAPH_DIR: ".codegraph" }), { root: project, dir: join(project, ".codegraph") });
});

test("mcp.json: entries named codegraph are found; others, invalid and missing files are not", (t) => {
  const dir = temp(t);
  const write = (name: string, value: unknown) => { writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value)); return join(dir, name); };
  const user = write("user.json", { mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"] } } });
  const disabled = write("project.json", { mcpServers: { codegraph: { enabled: false } } });
  const other = write("other.json", { mcpServers: { "code-graph-x": { command: "x" } } });
  const broken = write("broken.json", "{ nope");
  assert.deepEqual(fileConfiguredServer([user, disabled, other, broken, join(dir, "missing.json")]), [user, disabled]);
});

test("mode, decision and server config", () => {
  assert.deepEqual(parseMode(undefined), { mode: "auto" });
  assert.deepEqual(parseMode(" ALWAYS "), { mode: "always" });
  assert.equal(parseMode("sometimes").mode, "auto");
  assert.match(parseMode("sometimes").warning!, /PI_CODEGRAPH_MCP=sometimes/);
  const binary = { ok: true as const, path: "/x/codegraph", source: "PATH" };
  const index = { root: "/p", dir: "/p/.codegraph" };
  assert.equal(decide({ mode: "auto", binary, index }).register, true);
  assert.equal(decide({ mode: "auto", binary, index: undefined }).register, false);
  assert.equal(decide({ mode: "always", binary, index: undefined }).register, true);
  assert.equal(decide({ mode: "off", binary, index }).register, false);
  assert.deepEqual(decide({ mode: "always", binary: { ok: false, message: "missing" }, index }), { register: false, reason: "missing" });
  assert.deepEqual(serverConfig("/x/codegraph"), { command: "/x/codegraph", args: ["serve", "--mcp"], exposure: "direct", description: serverConfig("/x/codegraph").description });
  assert.equal(SERVER_NAME, "codegraph");
  assert.equal(EXPLORE_TOOL, "mcp__codegraph__codegraph_explore");
});

test("output cleanup and argument completions", () => {
  assert.equal(cleanOutput("\x1b[32m┌  Syncing\x1b[0m\n│\n●  Already up to date\n└  Done\n"), "┌  Syncing\n●  Already up to date\n└  Done");
  assert.equal(cleanOutput("a\nb\nc", 2), "a\nb\n… 1 more lines");
  assert.deepEqual(completeArguments("")?.map(item => item.value), ["status", "init", "sync", "help"]);
  assert.deepEqual(completeArguments("s")?.map(item => item.value), ["status", "sync"]);
  assert.equal(completeArguments("sync"), null);
  assert.equal(completeArguments("x"), null);
});
