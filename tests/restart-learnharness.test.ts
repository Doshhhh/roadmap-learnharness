/** Restart script tests: every command goes through an injected runner, so nothing quits or launches a real app. */
import { test } from "node:test";
import assert from "node:assert/strict";

type Result = { status: number; stdout: string; stderr: string };
type Runner = (command: string, args: string[], options?: { detach?: boolean }) => Result;
interface RestartModule {
  restartLearnHarness(options: Record<string, unknown>): Promise<{ outcome: string }>;
  commandsFor(platform: string, appPath: string): Record<string, { command: string; args: string[]; detach?: boolean }>;
  resolveAppPath(platform: string, env: Record<string, string | undefined>): string | null;
}

const script: RestartModule = await import(new URL("../scripts/restart-learnharness.mjs", import.meta.url).href);
const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" });
const fail = (status: number): Result => ({ status, stdout: "", stderr: "" });
const FORCE = /\/F\b|-9\b|SIGKILL|-KILL/;

/** A fake machine: `running` says whether the app is up; a quit or launch can be made to fail. */
function fakeMachine({ running = true, quitStops = true, launchStatus = 0, stopsAfterMs = 0 } = {}) {
  const calls: { command: string; args: string[]; detach?: boolean }[] = [];
  let isUp = running;
  let clock = 0;
  const runner: Runner = (command, args, options) => {
    calls.push({ command, args, detach: options?.detach });
    const key = [command, ...args].join(" ");
    if (key.startsWith("pgrep") || key.startsWith("tasklist")) {
      return isUp ? (key.startsWith("tasklist") ? ok("LearnHarness.exe  1234") : ok("1234")) : (key.startsWith("tasklist") ? ok("INFO: No tasks") : fail(1));
    }
    if (command === "osascript" || command === "taskkill" || command === "pkill") {
      if (quitStops) isUp = false;
      return ok();
    }
    return fail(launchStatus);
  };
  const sleep = async (ms: number) => { clock += ms; if (clock >= stopsAfterMs && quitStops) isUp = false; };
  return { calls, runner, sleep, now: () => clock };
}

const base = (extra: Record<string, unknown>) => ({ exists: () => true, log: () => {}, ...extra });
const logged = () => { const lines: string[] = []; return { lines, log: (m: string) => lines.push(m) }; };

test("macOS quits gracefully with osascript and relaunches with open -a", async () => {
  const machine = fakeMachine();
  const out = logged();
  const result = await script.restartLearnHarness(base({ platform: "darwin", env: {}, runner: machine.runner, sleep: machine.sleep, now: machine.now, log: out.log }));
  assert.equal(result.outcome, "restarted");
  assert.deepEqual(machine.calls.map(c => [c.command, ...c.args]), [
    ["pgrep", "-x", "LearnHarness"],
    ["osascript", "-e", 'tell application "LearnHarness" to quit'],
    ["pgrep", "-x", "LearnHarness"],
    ["open", "-a", "/Applications/LearnHarness.app"],
  ]);
});

test("Windows uses taskkill without /F, then starts the executable with the start command", async () => {
  const machine = fakeMachine();
  const result = await script.restartLearnHarness(base({ platform: "win32", env: { LEARNHARNESS_APP: "C:\\Apps\\LearnHarness\\LearnHarness.exe" }, runner: machine.runner, sleep: machine.sleep, now: machine.now }));
  assert.equal(result.outcome, "restarted");
  const commands = machine.calls.map(c => [c.command, ...c.args]);
  assert.deepEqual(commands[1], ["taskkill", "/IM", "LearnHarness.exe"]);
  assert.deepEqual(commands.at(-1), ["cmd", "/c", "start", "", "C:\\Apps\\LearnHarness\\LearnHarness.exe"]);
});

test("Linux sends SIGTERM by name, then launches the executable detached", async () => {
  const machine = fakeMachine();
  const result = await script.restartLearnHarness(base({ platform: "linux", env: { LEARNHARNESS_APP: "/opt/learnharness/LearnHarness" }, runner: machine.runner, sleep: machine.sleep, now: machine.now }));
  assert.equal(result.outcome, "restarted");
  const quit = machine.calls[1];
  assert.deepEqual([quit?.command, ...(quit?.args ?? [])], ["pkill", "-TERM", "-x", "LearnHarness"]);
  const launch = machine.calls.at(-1);
  assert.deepEqual(launch, { command: "/opt/learnharness/LearnHarness", args: [], detach: true });
});

test("commands per platform never contain a force-kill", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const commands = script.commandsFor(platform, "/x/LearnHarness");
    for (const entry of Object.values(commands)) {
      assert.doesNotMatch([entry.command, ...entry.args].join(" "), FORCE, `${platform} ${entry.command}`);
    }
  }
});

test("LEARNHARNESS_APP overrides the default macOS location", async () => {
  assert.equal(script.resolveAppPath("darwin", { LEARNHARNESS_APP: "/Volumes/Test/LearnHarness.app" }), "/Volumes/Test/LearnHarness.app");
  assert.equal(script.resolveAppPath("darwin", {}), "/Applications/LearnHarness.app");
  const machine = fakeMachine({ running: false });
  await script.restartLearnHarness(base({ platform: "darwin", env: { LEARNHARNESS_APP: "/Volumes/Test/LearnHarness.app" }, runner: machine.runner, sleep: machine.sleep, now: machine.now }));
  assert.deepEqual(machine.calls.at(-1)?.args, ["-a", "/Volumes/Test/LearnHarness.app"]);
});

test("Windows and Linux report not found without an override, and launch nothing", async () => {
  for (const platform of ["win32", "linux"]) {
    const machine = fakeMachine();
    const out = logged();
    const result = await script.restartLearnHarness(base({ platform, env: {}, runner: machine.runner, sleep: machine.sleep, now: machine.now, log: out.log }));
    assert.equal(result.outcome, "not-found");
    assert.equal(machine.calls.length, 0, `${platform} must not run any command`);
    assert.match(out.lines[0] ?? "", /not found/);
  }
});

test("a missing app is reported and nothing is quit or launched", async () => {
  const machine = fakeMachine();
  const out = logged();
  const result = await script.restartLearnHarness(base({ platform: "darwin", env: {}, exists: () => false, runner: machine.runner, sleep: machine.sleep, now: machine.now, log: out.log }));
  assert.equal(result.outcome, "not-found");
  assert.equal(machine.calls.length, 0);
  assert.match(out.lines[0] ?? "", /LearnHarness was not found at \/Applications\/LearnHarness\.app/);
});

test("an app that is not running is started without any quit", async () => {
  const machine = fakeMachine({ running: false });
  const result = await script.restartLearnHarness(base({ platform: "darwin", env: {}, runner: machine.runner, sleep: machine.sleep, now: machine.now }));
  assert.equal(result.outcome, "started");
  assert.deepEqual(machine.calls.map(c => c.command), ["pgrep", "open"]);
});

test("the bounded wait stops and reports when the app never exits, without force-killing or relaunching", async () => {
  const machine = fakeMachine({ quitStops: false });
  const out = logged();
  const timeoutMs = 3_000;
  const result = await script.restartLearnHarness(base({ platform: "darwin", env: {}, runner: machine.runner, sleep: machine.sleep, now: machine.now, timeoutMs, pollIntervalMs: 500, log: out.log }));
  assert.equal(result.outcome, "timeout");
  assert.equal(machine.calls.filter(c => c.command === "open").length, 0);
  assert.equal(machine.calls.filter(c => FORCE.test([c.command, ...c.args].join(" "))).length, 0);
  // Bounded: at most one running-check per poll interval, plus the first check and the quit.
  assert.ok(machine.calls.length <= timeoutMs / 500 + 3, `too many calls: ${machine.calls.length}`);
  assert.match(out.lines.at(-1) ?? "", /did not quit within 3 seconds\. Nothing was force-closed/);
});

test("a failed launch is reported as failed", async () => {
  const machine = fakeMachine({ running: false, launchStatus: 1 });
  const out = logged();
  const result = await script.restartLearnHarness(base({ platform: "darwin", env: {}, runner: machine.runner, sleep: machine.sleep, now: machine.now, log: out.log }));
  assert.equal(result.outcome, "failed");
  assert.match(out.lines[0] ?? "", /could not be started/);
});

test("an unsupported platform throws instead of guessing", async () => {
  await assert.rejects(script.restartLearnHarness(base({ platform: "freebsd", env: { LEARNHARNESS_APP: "/x/LearnHarness" }, runner: fakeMachine().runner })), /not supported/);
});
