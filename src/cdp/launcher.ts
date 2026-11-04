/**
 * Chrome discovery and debug-instance launching for the CDP bridge.
 *
 * Goal: talk to the user's REAL Chrome (with their login state) at
 * 127.0.0.1:<port>. We never kill a running browser: if Chrome is already
 * running without a debug port we surface a clear LaunchError instead of
 * spawning a second instance that would just hand off to the first one
 * (profile lock) and never open the debug port.
 *
 * All diagnostics go to stderr — never stdout (MCP stdio protocol channel).
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Thrown when Chrome cannot be launched or located for debugging. */
export class LaunchError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "LaunchError";
  }
}

/** Default debug port for the bridge. */
export const DEFAULT_DEBUG_PORT = 9222;

/**
 * Env override for the debug port (README-documented). Returns undefined
 * when unset or unparseable so callers can fall back to their own default.
 */
export function envPort(): number | undefined {
  const v = process.env["DSH_BROWSER_PORT"]
  if (!v || !v.trim()) return undefined
  const n = parseInt(v, 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

/**
 * Env override for a separate Chrome profile dir (README-documented).
 * A custom profile does NOT conflict with the default profile lock, so
 * callers use its presence to skip the "browser already running" guard.
 */
export function envUserDataDir(): string | undefined {
  const v = process.env["DSH_BROWSER_USER_DATA_DIR"]
  return v && v.trim() ? v.trim() : undefined
}

/**
 * Environment overrides for the browser executable, checked in order.
 */
const BROWSER_PATH_ENV_VARS = ["CHROME_PATH", "DSH_BROWSER_PATH"];

interface BrowserCandidate {
  /** Absolute path to probe. */
  path: string;
  /** Human-readable label used in messages. */
  name: string;
}

/**
 * Build the ordered list of candidate browser executables for this platform.
 *
 * Order: env overrides first (CHROME_PATH, DSH_BROWSER_PATH), then
 * platform-specific well-known install locations.
 *
 * When a browser-path env var IS set, it is authoritative: only the env
 * value(s) are probed (a set-but-bogus override must NOT silently fall
 * through to a platform default — the user explicitly told us where the
 * browser is). When no env var is set, the platform defaults are probed.
 */
function browserCandidates(): BrowserCandidate[] {
  const envCandidates: BrowserCandidate[] = [];
  for (const envName of BROWSER_PATH_ENV_VARS) {
    const v = process.env[envName];
    if (v && v.trim().length > 0) {
      envCandidates.push({ path: v.trim(), name: `env ${envName}` });
    }
  }
  if (envCandidates.length > 0) {
    return envCandidates;
  }

  const candidates: BrowserCandidate[] = [];

  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData =
      process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      {
        path: path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        name: "Google Chrome",
      },
      {
        path: path.join(
          programFilesX86,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        ),
        name: "Google Chrome (x86)",
      },
      {
        path: path.join(
          localAppData,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        ),
        name: "Google Chrome (user install)",
      },
      {
        path: path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        name: "Microsoft Edge",
      },
      {
        path: path.join(
          programFilesX86,
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        ),
        name: "Microsoft Edge (x86)",
      },
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      {
        path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        name: "Google Chrome",
      },
      {
        path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        name: "Chromium",
      },
      {
        path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        name: "Microsoft Edge",
      },
    );
  } else {
    candidates.push(
      { path: "/usr/bin/google-chrome", name: "google-chrome" },
      { path: "/usr/bin/google-chrome-stable", name: "google-chrome-stable" },
      { path: "/usr/bin/chromium", name: "chromium" },
      { path: "/usr/bin/chromium-browser", name: "chromium-browser" },
      { path: "/snap/bin/chromium", name: "chromium (snap)" },
      {
        path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        name: "Microsoft Edge",
      },
    );
  }

  return candidates;
}

/**
 * Find a usable Chrome/Chromium/Edge executable on this machine.
 *
 * Probes, in order: env CHROME_PATH / DSH_BROWSER_PATH overrides, then the
 * platform's well-known install locations (Windows Chrome + Edge, macOS
 * Chrome/Chromium/Edge, Linux binaries incl. google-chrome-stable and the
 * snap path).
 *
 * @returns `{ path, name }` for the first candidate that exists on disk, or
 *   `null` when nothing was found.
 */
export function findBrowser(): { path: string; name: string } | null {
  for (const candidate of browserCandidates()) {
    try {
      if (existsSync(candidate.path)) {
        return { path: candidate.path, name: candidate.name };
      }
    } catch {
      // Permission errors etc. — treat as "not usable" and keep probing.
    }
  }
  return null;
}

/**
 * Raw TCP connect probe: is something listening on host:port?
 *
 * @param port - TCP port to probe.
 * @param host - TCP host (default "127.0.0.1").
 * @returns Promise resolving to true when a TCP connection was established.
 */
export function isDebugPortOpen(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Platform-specific default Chrome user-data-dir (the real profile dir, so
 * login state is preserved). Used only to REPORT which profile is in play;
 * for the default-profile case we pass NO --user-data-dir on the command
 * line so Chrome itself uses its real profile.
 */
function defaultUserDataDir(): string {
  if (process.platform === "win32") {
    const localAppData =
      process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Google", "Chrome", "User Data");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  // Linux: XDG config dir, Chrome default.
  const xdg = process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "google-chrome");
}

/**
 * Chrome major version from the binary path, or null when it cannot be read.
 *
 * Reads the installed version directory ("...\Chrome\Application\131.0.x\")
 * which every Chrome/Edge install on Windows uses. Chromium on other
 * platforms usually has no versioned dir, so null is normal there.
 */
export function detectChromeMajor(browserPath: string): number | null {
  // Windows/macOS installs live under .../Application/<version>/ — read it.
  const m = /[\\/](\d{2,3})\.\d+\.\d+\.\d+[\\/]/.exec(browserPath);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  // Fall back to a sibling versioned directory.
  try {
    const dir = path.dirname(browserPath);
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    for (const e of entries) {
      const mm = /^(\d{2,3})\.\d+\.\d+\.\d+$/.exec(String(e));
      if (mm) return parseInt(mm[1], 10);
    }
  } catch {
    // Unreadable — treat as unknown.
  }
  return null;
}

/**
 * Chrome 136+ refuses to open a remote-debugging port on the DEFAULT profile:
 * it silently ignores --remote-debugging-port unless a non-default
 * --user-data-dir is also given (no error, no port, no DevToolsActivePort).
 * See https://developer.chrome.com/blog/remote-debugging-port
 */
export const MIN_MAJOR_FOR_DEFAULT_PROFILE_DEBUG = 136;

/**
 * Is a Chrome/Chromium/Edge process currently running?
 *
 * Uses tasklist on Windows, pgrep elsewhere.
 *
 * CONSERVATIVE SEMANTICS: when the probe itself fails (execSync throws,
 * tasklist/pgrep unavailable — e.g. restricted sandboxes), this returns TRUE
 * ("a browser is probably running") rather than false. Rationale: a false
 * "not running" answer would send us down the launch path, where a profile
 * lock makes the new instance hand off to the existing one and no debug port
 * ever opens (plus we leave an orphan Chrome behind). A false "running"
 * answer only costs the user a clear LaunchError telling them to close
 * Chrome or set DSH_BROWSER_USER_DATA_DIR. We never kill anything either
 * way — that is a hard non-goal.
 */
function isBrowserProcessRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.toLowerCase().includes("chrome.exe");
    }
    const out = execSync("pgrep -f 'chrome|chromium' || true", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    // Probe failed (command missing, EPERM, etc.) — conservatively assume a
    // browser is running so we NEVER spawn into a profile-lock conflict.
    return true;
  }
}

/**
 * Human-readable manual launch command for the current platform, used in
 * LaunchError messages when auto-launch fails.
 */
function manualLaunchCommand(
  browserPath: string,
  port: number,
  userDataDir?: string,
): string {
  const args = [`--remote-debugging-port=${port}`];
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  const quoted = process.platform === "win32" ? `"${browserPath}"` : browserPath;
  return `${quoted} ${args.join(" ")}`;
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Result of launching a browser manually (kept for contract compatibility
 * with the original bridge design; ensureDebugChrome's own return type is
 * {@link EnsureDebugChromeResult}).
 */
export interface LaunchResult {
  browserPath: string;
  args: string[];
  port: number;
  userDataDir: string;
  restarted: boolean;
}

export interface EnsureDebugChromeResult {
  alreadyRunning: boolean;
  launched: boolean;
  port: number;
  userDataDir: string;
}

/**
 * Ensure a debuggable Chrome is listening on 127.0.0.1:port.
 *
 * Env fallbacks (README-documented): when `port` is not supplied (or is
 * undefined), DSH_BROWSER_PORT is consulted next; when `userDataDir` is not
 * supplied, DSH_BROWSER_USER_DATA_DIR is consulted next. Explicit arguments
 * always win over the env overrides.
 *
 * Decision table (mirrors br_mcp.py behavior):
 *  1. Port already open  -> reuse it (alreadyRunning=true, launched=false).
 *     We never spawn when a debug port is already listening.
 *  2. Port closed AND a Chrome process is running AND no custom profile is
 *     in play (default-profile reuse) -> the running Chrome holds the
 *     profile lock; a second instance with the same user-data-dir would just
 *     hand off to it and never open the debug port. Throws LaunchError
 *     telling the user to close Chrome or set DSH_BROWSER_USER_DATA_DIR. We
 *     never kill any process.
 *     SKIPPED when a custom profile IS in play: an explicit userDataDir
 *     argument OR a DSH_BROWSER_USER_DATA_DIR env override means we launch
 *     with a SEPARATE user-data-dir, which does not conflict with the
 *     default profile lock - the user's default Chrome may keep running.
 *     Fall through to step 3.
 *  3. Port closed AND (no Chrome running OR custom profile in play) ->
 *     launch Chrome with --remote-debugging-port=<port>
 *     --remote-debugging-address=127.0.0.1, --no-first-run
 *     --no-default-browser-check. For the DEFAULT profile we pass NO
 *     --user-data-dir so the real profile (login state) is used; a custom
 *     userDataDir is passed explicitly. The child is spawned detached with
 *     ignored stdio and unref()'d so plugin exit does not kill it.
 *
 * After spawn we poll isDebugPortOpen for up to 20s, then GET /json/version
 * for up to 10s more. On failure we throw LaunchError whose message includes
 * the exact command the user can run manually.
 *
 * @param port - Debug port (default 9222; DSH_BROWSER_PORT env is the
 *   fallback when omitted/undefined).
 * @param userDataDir - Custom profile dir; when omitted the
 *   DSH_BROWSER_USER_DATA_DIR env override is consulted, then the OS default
 *   profile is reused so login state is preserved.
 * @returns Result describing what happened.
 */
export async function ensureDebugChrome(
  port: number = DEFAULT_DEBUG_PORT,
  userDataDir?: string,
): Promise<EnsureDebugChromeResult> {
  const host = "127.0.0.1";
  const effectivePort = port ?? envPort() ?? DEFAULT_DEBUG_PORT;
  // Custom profile (explicit arg or DSH_BROWSER_USER_DATA_DIR env) does not
  // conflict with the default profile lock — see branch 2 below.
  const argOrEnvUserDataDir = userDataDir ?? envUserDataDir();

  // 1) Already running with a debug port -> reuse, do NOT spawn.
  if (await isDebugPortOpen(effectivePort, host)) {
    return {
      alreadyRunning: true,
      launched: false,
      port: effectivePort,
      userDataDir: argOrEnvUserDataDir ?? defaultUserDataDir(),
    };
  }

  const browser = findBrowser();
  if (!browser) {
    throw new LaunchError(
      "No Chrome/Chromium/Edge executable found. Install Chrome or set " +
        "CHROME_PATH / DSH_BROWSER_PATH to the browser binary path.",
    );
  }

  // 2) Port closed but a browser process is alive: profile lock means a new
  //    instance would hand off to it and never open the debug port. Only a
  //    problem when reusing the DEFAULT profile; a custom profile dir
  //    (explicit arg or DSH_BROWSER_USER_DATA_DIR env) coexists with the
  //    running browser, so the guard is skipped in that case.
  const usingCustomProfile =
    argOrEnvUserDataDir !== undefined && argOrEnvUserDataDir.trim().length > 0;
  if (!usingCustomProfile && isBrowserProcessRunning()) {
    const major = detectChromeMajor(browser.path);
    const modernHint =
      major !== null && major >= MIN_MAJOR_FOR_DEFAULT_PROFILE_DEBUG
        ? ` Note: Chrome ${major} also forbids remote debugging on the default ` +
          `profile, so closing Chrome alone will NOT help — you must use a ` +
          `separate profile via DSH_BROWSER_USER_DATA_DIR.`
        : "";
    throw new LaunchError(
      "Chrome is already running without a debug port. Close all Chrome windows " +
        "and retry (or set DSH_BROWSER_USER_DATA_DIR to a separate profile). " +
        "The plugin will NOT auto-kill your browser." +
        modernHint,
    );
  }

  // 3) Chrome 136+ refuses to open a debugging port on the DEFAULT profile:
  //    --remote-debugging-port is silently ignored (no error, no port, no
  //    DevToolsActivePort) unless a non-default --user-data-dir is supplied.
  //    Spawning anyway would look like a 20s timeout with a misleading
  //    message, so fail fast with the actual cause and the working command.
  const chromeMajor = detectChromeMajor(browser.path);
  if (
    !usingCustomProfile &&
    chromeMajor !== null &&
    chromeMajor >= MIN_MAJOR_FOR_DEFAULT_PROFILE_DEBUG
  ) {
    const suggestedDir = path.join(
      path.dirname(defaultUserDataDir()),
      "Chrome User Data DSH",
    );
    throw new LaunchError(
      `Chrome ${chromeMajor} refuses remote debugging on the DEFAULT profile. ` +
        `Chrome ${MIN_MAJOR_FOR_DEFAULT_PROFILE_DEBUG}+ silently ignores ` +
        `--remote-debugging-port unless a separate --user-data-dir is given ` +
        `(no error, no port). \n` +
        `Fix: set DSH_BROWSER_USER_DATA_DIR to a separate profile directory ` +
        `(the plugin will create/use it), or start Chrome yourself with:\n` +
        `  ${manualLaunchCommand(browser.path, effectivePort, suggestedDir)}\n` +
        `See https://developer.chrome.com/blog/remote-debugging-port`,
    );
  }

  // 4) Launch a fresh debug instance.
  const effectiveUserDataDir = usingCustomProfile
    ? (argOrEnvUserDataDir as string)
    : defaultUserDataDir();

  const args: string[] = [
    `--remote-debugging-port=${effectivePort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (usingCustomProfile) {
    args.push(`--user-data-dir=${effectiveUserDataDir}`);
  }
  // NOTE: for the DEFAULT profile case we deliberately pass NO --user-data-dir
  // so Chrome uses the real profile and preserves login state. Chrome < 136
  // still allows that; 136+ was rejected above.

  const manualCommand = manualLaunchCommand(
    browser.path,
    effectivePort,
    usingCustomProfile ? effectiveUserDataDir : undefined,
  );

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(browser.path, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err: any) {
    throw new LaunchError(
      `Failed to launch Chrome (${browser.path}): ${String(
        (err as Error)?.message ?? err,
      )}\nTo debug manually, run:\n  ${manualCommand}`,
    );
  }

  /**
   * Best-effort cleanup of the child WE spawned (never touches any
   * pre-existing user Chrome process). Only called on the failure paths
   * below; a successfully launched debug Chrome is left running for the
   * user.
   */
  const killSpawnedChild = () => {
    if (!child) {
      return;
    }
    try {
      if (process.platform === "win32") {
        // Kill the process tree so any helper renderers go too.
        execSync(`taskkill /PID ${child.pid} /T /F`, {
          stdio: ["ignore", "pipe", "ignore"],
        });
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // Already gone or not killable — nothing more we can do.
    }
  };

  // Wait for the raw TCP debug port (up to 20s).
  const portDeadline = Date.now() + 20000;
  let portOpen = false;
  while (Date.now() < portDeadline) {
    if (await isDebugPortOpen(effectivePort, host)) {
      portOpen = true;
      break;
    }
    await sleep(250);
  }
  if (!portOpen) {
    killSpawnedChild();
    throw new LaunchError(
      `Chrome was launched but the debug port ${effectivePort} never opened (waited 20s).\n` +
        `To launch manually, run:\n  ${manualCommand}`,
    );
  }

  // Wait for /json/version to answer (up to 10s more) so callers can connect
  // to the browser WS endpoint immediately after this resolves.
  const versionDeadline = Date.now() + 10000;
  for (;;) {
    try {
      const res = await fetch(`http://${host}:${effectivePort}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        return {
          alreadyRunning: false,
          launched: true,
          port: effectivePort,
          userDataDir: effectiveUserDataDir,
        };
      }
    } catch {
      // Not ready yet — keep polling until the deadline.
    }
    if (Date.now() >= versionDeadline) {
      killSpawnedChild();
      throw new LaunchError(
        `Chrome debug port ${effectivePort} is open but /json/version never answered ` +
          `(waited 10s).\nTo launch manually, run:\n  ${manualCommand}`,
      );
    }
    await sleep(250);
  }
}
