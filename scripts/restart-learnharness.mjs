/** Restart LearnHarness so newly installed plugin code loads. Opt-in: does nothing without --restart.
 * Graceful quit only (never force-kill), a bounded wait, then relaunch. Node built-ins only.
 * Set LEARNHARNESS_APP to the app's location to override the default. */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const APP_NAME = "LearnHarness";
export const WINDOWS_EXE_NAME = "LearnHarness.exe";
export const MACOS_APP_PATH = "/Applications/LearnHarness.app";
/** How long to wait for a graceful quit before stopping and reporting. */
export const QUIT_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 500;

/** Where LearnHarness is installed. Only macOS has a verified default; Windows and Linux
 * return null so the script reports "not found" unless LEARNHARNESS_APP is set. */
export function resolveAppPath(platform, env) {
  const override = env.LEARNHARNESS_APP?.trim();
  if (override) return override;
  if (platform === "darwin") return MACOS_APP_PATH;
  return null;
}

/** The commands for one platform. The quit is always graceful: osascript quit, taskkill without /F, SIGTERM. */
export function commandsFor(platform, appPath) {
  switch (platform) {
    case "darwin":
      return {
        running: { command: "pgrep", args: ["-x", APP_NAME] },
        quit: { command: "osascript", args: ["-e", `tell application "${APP_NAME}" to quit`] },
        launch: { command: "open", args: ["-a", appPath] },
      };
    case "win32":
      return {
        running: { command: "tasklist", args: ["/FI", `IMAGENAME eq ${WINDOWS_EXE_NAME}`, "/NH"] },
        quit: { command: "taskkill", args: ["/IM", WINDOWS_EXE_NAME] },
        launch: { command: "cmd", args: ["/c", "start", "", appPath] },
      };
    case "linux":
      // The process name is assumed to match the app name; not verified against an install.
      return {
        running: { command: "pgrep", args: ["-x", APP_NAME] },
        quit: { command: "pkill", args: ["-TERM", "-x", APP_NAME] },
        launch: { command: appPath, args: [], detach: true },
      };
    default:
      throw new Error(`Restarting LearnHarness is not supported on this platform (${platform}).`);
  }
}

/** Reads a running-check result. Anything unexpected is an error, never "not running". */
export function isRunningFrom(platform, result) {
  if (platform === "win32") {
    if (result.status !== 0) throw new Error("Could not check whether LearnHarness is running.");
    return result.stdout.toLowerCase().includes(WINDOWS_EXE_NAME.toLowerCase());
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Could not check whether LearnHarness is running.");
}

/** Real command runner. Tests inject their own and never reach this. */
export function systemRunner(command, args, { detach = false } = {}) {
  if (detach) {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", error => process.stderr.write(`Could not start ${command}: ${error.message}\n`));
    child.unref();
    return { status: 0, stdout: "", stderr: "" };
  }
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? ""),
  };
}

/** Returns { outcome } where outcome is "started", "restarted", "not-found", "timeout" or "failed". */
export async function restartLearnHarness({
  platform = process.platform,
  env = process.env,
  runner = systemRunner,
  exists = fs.existsSync,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = QUIT_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  log = message => console.log(message),
} = {}) {
  const appPath = resolveAppPath(platform, env);
  if (!appPath || !exists(appPath)) {
    const where = appPath ? ` at ${appPath}` : "";
    log(`LearnHarness was not found${where}. Set LEARNHARNESS_APP to the app's location and run again. Nothing was stopped or started.`);
    return { outcome: "not-found" };
  }

  const commands = commandsFor(platform, appPath);
  const isRunning = () => isRunningFrom(platform, runner(commands.running.command, commands.running.args));
  const launch = () => {
    const { command, args, detach } = commands.launch;
    return runner(command, args, detach ? { detach: true } : undefined);
  };

  if (!isRunning()) {
    if (launch().status !== 0) {
      log(`LearnHarness is not running and could not be started from ${appPath}.`);
      return { outcome: "failed" };
    }
    log("LearnHarness was not running, so it was started.");
    return { outcome: "started" };
  }

  const quit = runner(commands.quit.command, commands.quit.args);
  if (quit.status !== 0) log("The quit request did not report success. Waiting to see whether LearnHarness closes anyway.");

  const deadline = now() + timeoutMs;
  while (isRunning()) {
    if (now() >= deadline) {
      log(`LearnHarness did not quit within ${Math.round(timeoutMs / 1000)} seconds. Nothing was force-closed and it was not started again. Close LearnHarness yourself, then run the restart again.`);
      return { outcome: "timeout" };
    }
    await sleep(pollIntervalMs);
  }

  if (launch().status !== 0) {
    log(`LearnHarness quit, but could not be started again from ${appPath}. Start it by hand.`);
    return { outcome: "failed" };
  }
  log("LearnHarness quit and was started again, so the new plugin code is loaded.");
  return { outcome: "restarted" };
}

const usage = "Usage: node scripts/restart-learnharness.mjs --restart\nQuits LearnHarness gracefully, then starts it again. Set LEARNHARNESS_APP to override the app location.";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(usage);
  } else if (args.length !== 1 || args[0] !== "--restart") {
    console.error(usage);
    process.exitCode = 1;
  } else {
    try {
      const { outcome } = await restartLearnHarness();
      if (outcome === "timeout" || outcome === "failed" || outcome === "not-found") process.exitCode = 1;
    } catch (error) {
      console.error(`[restart-learnharness] ${error.message}`);
      process.exitCode = 1;
    }
  }
}
