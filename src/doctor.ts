/**
 * `/codegraph doctor` and `/codegraph install-deps`, and the umbrella's dependency provider (src/dependencies.ts).
 *
 * The check follows the extension's own resolution: a `codegraph` entry in Pi's mcp.json (user file, or the trusted
 * project's `.pi/mcp.json`) takes precedence over this extension's registration, so with such an entry the local CLI is
 * not needed for MCP; otherwise the CLI is found through PI_CODEGRAPH_BIN, PATH, ~/.local/bin/codegraph and
 * ~/.codegraph/current/bin/codegraph. The per-project index is optional (a warning with `/codegraph init`).
 *
 * install-deps installs a missing CLI with upstream's install.sh (user-level: ~/.codegraph and ~/.local/bin, no sudo,
 * no Node.js or npm prefix needed). It never upgrades an existing CLI (`codegraph upgrade`), never writes mcp.json and
 * never creates an index.
 */
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { arch as osArch, homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileConfiguredServer, findProjectIndex, parseMode, resolveCodegraphBinary, SERVER_NAME, type BinaryResolution, type Environment, type ProjectIndex } from "./core.ts";
import {
  findExecutable, installNpmDependencies, npmDependencyItem, outputTail, runProcess,
  type DependencyItem, type DependencyProvider, type DependencyReport, type RunResult,
} from "./dependencies.ts";
import { effectiveServerEntry, serverProjectDir } from "./worker.ts";

export const DEPENDENCY_PROVIDER_ID = "codegraph";
export const DEPENDENCY_LABEL = "pi-codegraph";
export const DEPENDENCY_COMMAND = "/codegraph";

export const INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`;
export const WINDOWS_INSTALL_COMMAND = "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex";
export const NPM_INSTALL_COMMAND = "npm i -g @colbymchenry/codegraph";
/** Bound of `codegraph --version`. */
export const VERSION_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The parts of Pi's command context the provider reads. */
export interface DoctorContext {
  cwd: string;
  isProjectTrusted?(): boolean;
}

export interface DoctorOptions extends Environment {
  agentDir: string;
  /** CPU architecture (default: os.arch()). */
  arch?: string;
  /** Process runner (tests inject a fake). */
  run?: typeof runProcess;
  /** This package's directory (default: the parent of src/). */
  packageDir?: string;
  /** Where install.sh is downloaded to (default: os.tmpdir()). */
  tmpDir?: string;
}

type ServerSource =
  | { kind: "extension" }
  | { kind: "override"; files: string[] }
  | { kind: "disabled"; files: string[] }
  | { kind: "remote"; files: string[] }
  | { kind: "stdio"; files: string[]; command: string; entry: Record<string, unknown> }
  | { kind: "other"; files: string[] };

interface State {
  source: ServerSource;
  /** Whether MCP needs the local CLI (no mcp.json entry supplies the server). */
  cliRequired: boolean;
  binary: BinaryResolution;
  version?: { ok: true; text: string } | { ok: false; detail: string };
}

const defaultPackageDir = () => fileURLToPath(new URL("..", import.meta.url));
const list = (files: string[]) => files.join(", ");

function executableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

export function createCodegraphDependencyProvider(
  options: DoctorOptions,
  hooks: { afterInstall?(ctx: DoctorContext, report: DependencyReport): void } = {},
): DependencyProvider<DoctorContext> {
  const env = () => options.env ?? process.env;
  const platform = () => options.platform ?? process.platform;
  const home = () => options.home ?? homedir();
  const run = options.run ?? runProcess;
  const packageDir = options.packageDir ?? defaultPackageDir();

  const trustedDir = (ctx: DoctorContext) => { try { return ctx.isProjectTrusted?.() ? ctx.cwd : undefined; } catch { return undefined; } };

  const serverSource = (ctx: DoctorContext): ServerSource => {
    const project = trustedDir(ctx);
    const entry = effectiveServerEntry(options.agentDir, project);
    if (!entry) return { kind: "extension" };
    const files = fileConfiguredServer([join(options.agentDir, "mcp.json"), ...(project ? [join(project, ".pi", "mcp.json")] : [])]);
    if (entry.enabled === false) return { kind: "disabled", files };
    if (entry.url !== undefined) return { kind: "remote", files };
    if (typeof entry.command === "string" && entry.command.trim()) return { kind: "stdio", files, command: entry.command.trim(), entry };
    if (entry.type !== undefined || entry.command !== undefined) return { kind: "other", files };
    return { kind: "override", files };
  };

  const probeVersion = async (path: string): Promise<NonNullable<State["version"]>> => {
    const result = await run(path, ["--version"], {
      env: env(), timeoutMs: VERSION_TIMEOUT_MS, shell: platform() === "win32" && /\.(cmd|bat)$/i.test(path),
    });
    const text = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (result.code === 0 && text) return { ok: true, text: text.replace(/^v/i, "") };
    return { ok: false, detail: `\`codegraph --version\` ${result.timedOut ? "timed out" : `exited ${result.code ?? "abnormally"}`}${outputTail(result) ? `: ${outputTail(result)}` : ""}` };
  };

  const inspect = async (ctx: DoctorContext): Promise<State> => {
    const source = serverSource(ctx);
    const binary = resolveCodegraphBinary({ ...options, env: env() });
    return {
      source,
      cliRequired: source.kind === "extension" || source.kind === "override",
      binary,
      ...(binary.ok ? { version: await probeVersion(binary.path) } : {}),
    };
  };

  /** Why the local CLI is not needed for MCP (undefined: it is needed). */
  const notRequiredReason = (source: ServerSource): string | undefined => {
    switch (source.kind) {
      case "disabled": return `the "${SERVER_NAME}" entry in ${list(source.files)} turns the MCP server off`;
      case "remote": return `the "${SERVER_NAME}" entry in ${list(source.files)} connects a remote server`;
      case "stdio": return `the "${SERVER_NAME}" entry in ${list(source.files)} starts its own command`;
      case "other": return `the "${SERVER_NAME}" entry in ${list(source.files)} defines the server`;
      default: return undefined;
    }
  };

  const resolveEntryCommand = (ctx: DoctorContext, source: Extract<ServerSource, { kind: "stdio" }>): string | undefined => {
    const expand = (value: string) => value === "~" ? home() : value.startsWith("~/") ? join(home(), value.slice(2)) : value;
    const command = expand(source.command);
    if (isAbsolute(command) || /[\\/]/.test(command)) {
      const base = typeof source.entry.cwd === "string" ? resolve(ctx.cwd, expand(source.entry.cwd)) : ctx.cwd;
      const path = resolve(base, command);
      return executableFile(path, platform()) ? path : undefined;
    }
    return findExecutable(command, env(), options.pathDirs);
  };

  const entryItem = (ctx: DoctorContext, source: ServerSource): DependencyItem | undefined => {
    const name = `mcp.json "${SERVER_NAME}" entry`;
    switch (source.kind) {
      case "extension": return undefined;
      case "override": return { name, status: "ok", detail: `${list(source.files)} overrides only enabled/exposure; the server is this extension's local CLI` };
      case "disabled": return { name, status: "ok", detail: `${list(source.files)} sets enabled: false, so the CodeGraph MCP server stays off (your choice)` };
      case "remote": return { name, status: "ok", detail: `remote server (URL set, not shown) in ${list(source.files)} takes precedence; no local CLI or index is needed for MCP` };
      case "other": return {
        name, status: "unverified", detail: `${list(source.files)} defines the server without a command or URL`,
        action: `Check the "${SERVER_NAME}" entry in ${list(source.files)}; /codegraph status shows whether mcp__codegraph__codegraph_explore is available`,
      };
      case "stdio": {
        const path = resolveEntryCommand(ctx, source);
        return path
          ? { name, status: "ok", detail: `${list(source.files)} starts ${path}, which takes precedence over this extension's registration` }
          : {
            name, status: "error", detail: `command "${source.command}" from ${list(source.files)} is not an executable file or on PATH`,
            action: `Fix the "${SERVER_NAME}" entry's command in ${list(source.files)} (or remove the entry to use this extension's registration), then /reload`,
          };
      }
    }
  };

  const modeItem = (): DependencyItem | undefined => {
    const value = env().PI_CODEGRAPH_MCP;
    if (value === undefined || !value.trim()) return undefined;
    const { mode, warning } = parseMode(value);
    if (warning) return { name: "PI_CODEGRAPH_MCP", status: "warn", optional: true, detail: warning, action: "Set PI_CODEGRAPH_MCP to auto, always or off (or unset it for auto)" };
    return { name: "PI_CODEGRAPH_MCP", status: "ok", detail: mode === "off" ? "off: this extension registers no MCP server; /codegraph still works" : mode };
  };

  const installHint = () => platform() === "win32"
    ? `Install it by hand in PowerShell: ${WINDOWS_INSTALL_COMMAND} (or ${NPM_INSTALL_COMMAND}), then /reload`
    : `Run /codegraph install-deps (upstream install.sh into ~/.codegraph and ~/.local/bin, no sudo), or by hand: ${INSTALL_COMMAND}`;

  const cliCheckItem = (state: State): DependencyItem => {
    const name = "codegraph CLI";
    const reason = notRequiredReason(state.source);
    const { binary, version } = state;
    if (binary.ok) {
      if (version?.ok) return { name, status: "ok", detail: `${binary.path} (${binary.source}), v${version.text}` };
      return {
        name, status: state.cliRequired ? "error" : "warn", ...(state.cliRequired ? {} : { optional: true }),
        detail: `${binary.path} (${binary.source}): ${version?.ok === false ? version.detail : "not runnable"}`,
        action: `Repair or reinstall the CLI by hand (${platform() === "win32" ? WINDOWS_INSTALL_COMMAND : INSTALL_COMMAND}), or point PI_CODEGRAPH_BIN to a working codegraph`,
      };
    }
    const explicit = env().PI_CODEGRAPH_BIN?.trim();
    if (explicit) {
      return {
        name, status: state.cliRequired ? "error" : "warn", ...(state.cliRequired ? {} : { optional: true }),
        detail: binary.message, action: "Point PI_CODEGRAPH_BIN to the codegraph executable, or unset it to search PATH and the installer locations",
      };
    }
    if (reason) return { name, status: "ok", detail: `not installed; not needed for MCP: ${reason} (/codegraph init, sync and status need it: ${INSTALL_COMMAND})` };
    return { name, status: "error", detail: "not found (PI_CODEGRAPH_BIN, PATH, ~/.local/bin/codegraph, ~/.codegraph/current/bin/codegraph)", action: installHint() };
  };

  const indexItem = (ctx: DoctorContext, state: State, cliAvailable: boolean): DependencyItem => {
    const name = "project index";
    if (state.source.kind === "remote") return { name, status: "ok", detail: "kept by the remote server (not checked locally)" };
    const dir = state.source.kind === "stdio" ? serverProjectDir(state.source.entry, ctx.cwd, home()) : ctx.cwd;
    const index: ProjectIndex | undefined = findProjectIndex(dir, env());
    if (index) return { name, status: "ok", detail: index.root === resolve(ctx.cwd) ? index.dir : `${index.dir} (project ${index.root})` };
    const init = resolve(dir) === resolve(ctx.cwd) ? "/codegraph init" : `codegraph init "${dir}"`;
    return {
      name, status: "warn", optional: true,
      detail: `no CodeGraph index at or above ${dir} (per project; CodeGraph is unavailable here until it is indexed)`,
      action: `Run ${init} in this project${cliAvailable ? "" : " after installing the CLI (/codegraph install-deps)"}`,
    };
  };

  const check = async (ctx: DoctorContext): Promise<DependencyReport> => {
    const state = await inspect(ctx);
    const items: DependencyItem[] = [...npmDependencyItem(packageDir, DEPENDENCY_COMMAND)];
    const entry = entryItem(ctx, state.source);
    if (entry) items.push(entry);
    const mode = modeItem();
    if (mode) items.push(mode);
    items.push(cliCheckItem(state), indexItem(ctx, state, state.binary.ok && !!state.version?.ok));
    return { items };
  };

  /** Install the CLI with upstream's install.sh when it is missing and needed; never upgrade or replace one. */
  const installCli = async (state: State): Promise<{ item: DependencyItem; available: boolean }> => {
    const name = "codegraph CLI";
    const { binary, version } = state;
    if (binary.ok) {
      if (version?.ok) return { available: true, item: { name, status: "ok", detail: `already installed: ${binary.path} (${binary.source}), v${version.text}; upgrades stay with you: codegraph upgrade` } };
      return {
        available: false,
        item: {
          name, status: "manual", detail: `${binary.path} (${binary.source}) exists but does not run: ${version?.ok === false ? version.detail : "unknown error"}; install-deps does not replace an existing CLI`,
          action: `Repair or reinstall it by hand (${platform() === "win32" ? WINDOWS_INSTALL_COMMAND : INSTALL_COMMAND}), or point PI_CODEGRAPH_BIN to a working codegraph`,
        },
      };
    }
    const explicit = env().PI_CODEGRAPH_BIN?.trim();
    if (explicit) {
      return { available: false, item: { name, status: "manual", detail: binary.message, action: "Point PI_CODEGRAPH_BIN to the codegraph executable, or unset it (then /codegraph install-deps can install the CLI)" } };
    }
    const reason = notRequiredReason(state.source);
    if (reason) return { available: false, item: { name, status: "ok", detail: `not installed; not needed for MCP: ${reason} (for /codegraph init, sync and status install it by hand: ${INSTALL_COMMAND})` } };
    const os = platform();
    if (os === "win32") {
      return { available: false, item: { name, status: "manual", detail: "not found; upstream's install.sh does not run on Windows", action: `Install it in PowerShell: ${WINDOWS_INSTALL_COMMAND} (or ${NPM_INSTALL_COMMAND}), then /reload` } };
    }
    const cpu = options.arch ?? osArch();
    if ((os !== "linux" && os !== "darwin") || !["x64", "arm64"].includes(cpu)) {
      return {
        available: false,
        item: {
          name, status: "manual", detail: `not found; upstream's install.sh supports Linux and macOS on x64/arm64, not ${os}-${cpu}`,
          action: `Install it as upstream documents for your platform (https://github.com/colbymchenry/codegraph), e.g. ${NPM_INSTALL_COMMAND} with a user-writable npm prefix`,
        },
      };
    }
    const tools = Object.fromEntries(["curl", "sh", "tar"].map(tool => [tool, findExecutable(tool, env())]));
    const missingTools = Object.keys(tools).filter(tool => !tools[tool]);
    if (missingTools.length) {
      return {
        available: false,
        item: {
          name, status: "manual", detail: `not found; upstream's install.sh needs ${missingTools.join(", ")}, which is not on PATH`,
          action: `Install ${missingTools.join(", ")} with your system package manager, then run /codegraph install-deps again (or ${NPM_INSTALL_COMMAND}, which needs no sudo only when npm's global prefix is user-writable)`,
        },
      };
    }
    const failed = (detail: string, result?: RunResult): { item: DependencyItem; available: boolean } => ({
      available: false,
      item: { name, status: "failed", detail: `${detail}${result && outputTail(result) ? `: ${outputTail(result)}` : ""}`, action: `Run it by hand and read the error: ${INSTALL_COMMAND}` },
    });
    const tmp = mkdtempSync(join(options.tmpDir ?? tmpdir(), "pi-codegraph-install-"));
    try {
      const script = join(tmp, "install.sh");
      const download = await run(tools.curl!, ["-fsSL", INSTALL_SCRIPT_URL, "-o", script], { cwd: tmp, env: env(), timeoutMs: DOWNLOAD_TIMEOUT_MS });
      if (download.code !== 0) return failed(`downloading install.sh failed (curl exited ${download.code ?? "abnormally"})`, download);
      // Install where the resolution looks: $HOME/.codegraph and $HOME/.local/bin.
      const installEnv: NodeJS.ProcessEnv = { ...env(), HOME: home() };
      delete installEnv.CODEGRAPH_INSTALL_DIR;
      delete installEnv.CODEGRAPH_BIN_DIR;
      const result = await run(tools.sh!, [script], { cwd: tmp, env: installEnv, timeoutMs: INSTALL_TIMEOUT_MS });
      const after = resolveCodegraphBinary({ ...options, env: env() });
      const afterVersion = after.ok ? await probeVersion(after.path) : undefined;
      if (result.code === 0 && after.ok && afterVersion?.ok) {
        const pathHint = after.source === "installer location" ? `; ${join(home(), ".local", "bin")} is not on PATH (Pi finds it anyway; for shells: export PATH="$HOME/.local/bin:$PATH")` : "";
        return {
          available: true,
          item: { name, status: "installed", detail: `${after.path} (${after.source}), v${afterVersion.text}${pathHint}`, action: "Index a project with /codegraph init (the MCP server then connects without /reload)" },
        };
      }
      const output = `${result.stderr}\n${result.stdout}\n${result.error ?? ""}`;
      if (result.code !== 0 && /EACCES|permission denied|read-only file system/i.test(output)) {
        return {
          available: false,
          item: {
            name, status: "manual", detail: `install.sh could not write its files: ${outputTail(result)}`,
            action: "Make ~/.codegraph and ~/.local/bin writable by your user (a root-owned copy from an earlier sudo install: sudo chown -R \"$USER\" ~/.codegraph ~/.local/bin), then run /codegraph install-deps again",
          },
        };
      }
      if (result.code !== 0) return failed(`install.sh exited ${result.code ?? "abnormally"}`, result);
      return failed(after.ok ? `install.sh finished, but ${after.path} does not run (${afterVersion?.ok === false ? afterVersion.detail : "no version"})` : "install.sh finished, but codegraph is still not found in ~/.local/bin or ~/.codegraph/current/bin", result);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  const install = async (ctx: DoctorContext): Promise<DependencyReport> => {
    const items: DependencyItem[] = [...await installNpmDependencies(packageDir, { env: env(), run })];
    const state = await inspect(ctx);
    const entry = entryItem(ctx, state.source);
    // install-deps never edits mcp.json: a broken entry is the user's to fix.
    if (entry) items.push(entry.status === "error" ? { ...entry, status: "manual" } : entry);
    const mode = modeItem();
    if (mode) items.push(mode);
    const cli = await installCli(state);
    items.push(cli.item, indexItem(ctx, state, cli.available));
    const report: DependencyReport = { items };
    hooks.afterInstall?.(ctx, report);
    return report;
  };

  let installing: Promise<DependencyReport> | undefined;
  return {
    id: DEPENDENCY_PROVIDER_ID,
    label: DEPENDENCY_LABEL,
    command: DEPENDENCY_COMMAND,
    check,
    /** One install at a time per session: a second call while one runs gets the same result. */
    install: ctx => installing ??= install(ctx).finally(() => { installing = undefined; }),
  };
}
