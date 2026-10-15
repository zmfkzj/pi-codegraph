/**
 * Pure helpers of the CodeGraph integration: locate the upstream `codegraph` CLI, find a project's index, read
 * Pi's file MCP configuration, and build the `pi.registerMcpServer()` config. No process is started here.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Same name as upstream's own installer and a hand-written `mcp.json` entry, so a file entry overrides this one. */
export const SERVER_NAME = "codegraph";
/** The one tool upstream lists by default (`CODEGRAPH_MCP_TOOLS` re-enables the others). */
export const EXPLORE_TOOL = `mcp__${SERVER_NAME}__codegraph_explore`;
export const SERVER_DESCRIPTION = "CodeGraph: local semantic code graph of the current project. Use codegraph_explore for symbols, call paths, callers/callees and change impact instead of crawling files with grep/read.";

export type Mode = "auto" | "always" | "off";
export const MODES: readonly Mode[] = ["auto", "always", "off"];

export interface Environment {
  env?: NodeJS.ProcessEnv;
  /** Home directory (default: os.homedir()). */
  home?: string;
  /** Directories searched for `codegraph` (default: PATH). */
  pathDirs?: string[];
  platform?: NodeJS.Platform;
}

export type BinaryResolution =
  | { ok: true; path: string; source: string }
  | { ok: false; message: string };

function executable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** `PI_CODEGRAPH_BIN`, then `codegraph` on PATH, then the locations upstream's install.sh uses. */
export function resolveCodegraphBinary(environment: Environment = {}): BinaryResolution {
  const env = environment.env ?? process.env;
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();
  const explicit = env.PI_CODEGRAPH_BIN?.trim();
  if (explicit) {
    const path = resolve(explicit.startsWith("~/") ? join(home, explicit.slice(2)) : explicit);
    return executable(path, platform)
      ? { ok: true, path, source: "PI_CODEGRAPH_BIN" }
      : { ok: false, message: `PI_CODEGRAPH_BIN=${explicit} is not an executable file.` };
  }
  const names = platform === "win32" ? ["codegraph.exe", "codegraph.cmd", "codegraph"] : ["codegraph"];
  const dirs = environment.pathDirs ?? (env.PATH ?? "").split(delimiter);
  for (const dir of dirs.filter(dir => dir && isAbsolute(dir))) {
    for (const name of names) {
      const path = join(dir, name);
      if (executable(path, platform)) return { ok: true, path, source: "PATH" };
    }
  }
  for (const path of [join(home, ".local", "bin", "codegraph"), join(home, ".codegraph", "current", "bin", "codegraph")]) {
    if (executable(path, platform)) return { ok: true, path, source: "installer location" };
  }
  return {
    ok: false,
    message: "codegraph CLI not found (PI_CODEGRAPH_BIN, PATH, ~/.local/bin, ~/.codegraph/current/bin). Install it: "
      + "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh  (or npm i -g @colbymchenry/codegraph)",
  };
}

export interface ProjectIndex { root: string; dir: string }

/**
 * The nearest index at or above `cwd`, as upstream resolves it: a `.codegraph/` (or `CODEGRAPH_DIR`, or WSL's
 * `.codegraph-wsl/`) directory holding `codegraph.db`. The database check skips the CLI's own `~/.codegraph/` install.
 */
export function findProjectIndex(cwd: string, env: NodeJS.ProcessEnv = process.env): ProjectIndex | undefined {
  const names = env.CODEGRAPH_DIR?.trim() ? [env.CODEGRAPH_DIR.trim()] : [".codegraph", ".codegraph-wsl"];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of names) {
      const index = join(dir, name);
      if (existsSync(join(index, "codegraph.db"))) return { root: dir, dir: index };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Pi treats server names that differ only in `-` and `_` as the same server. */
const sameServer = (name: string) => name.replace(/-/g, "_") === SERVER_NAME.replace(/-/g, "_");

/**
 * The Pi `mcp.json` files that define a `codegraph` server. Pi gives such an entry precedence over the server this
 * extension registers, so the user's configuration (command, exposure, `enabled: false`) stays in force.
 */
export function fileConfiguredServer(paths: string[]): string[] {
  return paths.filter(path => {
    try {
      const servers = (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> })?.mcpServers;
      return !!servers && typeof servers === "object" && Object.keys(servers).some(sameServer);
    } catch { return false; }
  });
}

export function parseMode(value: string | undefined): { mode: Mode; warning?: string } {
  const text = value?.trim().toLowerCase();
  if (!text) return { mode: "auto" };
  if ((MODES as readonly string[]).includes(text)) return { mode: text as Mode };
  return { mode: "auto", warning: `Ignoring PI_CODEGRAPH_MCP=${value}; expected ${MODES.join(", ")}.` };
}

export interface ServerConfig {
  command: string;
  args: string[];
  exposure: "direct";
  description: string;
}

/**
 * Upstream's own MCP setup (`codegraph serve --mcp`) with the tool declared directly, as upstream's `alwaysLoad`
 * recommends. The working directory and MCP roots are the session's, so the server answers for its project;
 * the inherited environment carries `CODEGRAPH_*` settings such as `CODEGRAPH_MCP_TOOLS`.
 */
export function serverConfig(binary: string): ServerConfig {
  return { command: binary, args: ["serve", "--mcp"], exposure: "direct", description: SERVER_DESCRIPTION };
}

export interface Decision { register: boolean; reason: string }

export function decide(input: { mode: Mode; binary: BinaryResolution; index: ProjectIndex | undefined }): Decision {
  if (input.mode === "off") return { register: false, reason: "PI_CODEGRAPH_MCP=off" };
  if (!input.binary.ok) return { register: false, reason: input.binary.message };
  if (input.mode === "auto" && !input.index) return { register: false, reason: "no CodeGraph index at or above this directory; run /codegraph init (or set PI_CODEGRAPH_MCP=always)" };
  return { register: true, reason: input.mode === "always" ? "PI_CODEGRAPH_MCP=always" : `index at ${input.index!.dir}` };
}

/** Strip ANSI escapes and spinner noise from CLI output shown in a notification. */
export function cleanOutput(text: string, maxLines = 40): string {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map(line => line.trimEnd())
    .filter(line => line.trim() && !/^[│┌└]\s*$/.test(line));
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n") : lines.join("\n");
}

export interface CommandCompletion { value: string; label: string; description: string }

export const COMMAND_COMPLETIONS: readonly CommandCompletion[] = [
  { value: "status", label: "status", description: "CLI, MCP registration and index status for this project" },
  { value: "init", label: "init", description: "Index this project (codegraph init) and connect the MCP server" },
  { value: "sync", label: "sync", description: "Update this project's index (codegraph sync)" },
  { value: "doctor", label: "doctor", description: "Check the CLI, mcp.json entry and project index, with fixes" },
  { value: "install-deps", label: "install-deps", description: "Install a missing codegraph CLI (upstream install.sh, no sudo)" },
  { value: "help", label: "help", description: "Show /codegraph usage" },
];

/** Candidates starting with the typed text; a lone exact match is dropped so Enter submits the command. */
export function completeArguments(prefix: string): CommandCompletion[] | null {
  const typed = prefix.trimStart();
  const items = COMMAND_COMPLETIONS.filter(item => item.value.startsWith(typed));
  if (items.length === 0 || (items.length === 1 && items[0]!.value === typed)) return null;
  return items.map(item => ({ ...item }));
}
