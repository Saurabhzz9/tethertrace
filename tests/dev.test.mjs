import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  classifyChange, isIgnored, parseGitignore, ProjectWatcher, CoalescingQueue, planUpdate, cycleVerdict, DevSession, readSnapshot, readHistory,
  requestStop, sessionDir, FlutterRunSession, parseFlutterDevices, matchFlutterDevice, parseDaemonLine, Policy,
} from "../dist/index.js";

const run = promisify(execFile);
const tmp = (p = "tt-dev-") => mkdtemp(join(tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
}
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(25);
  }
  return false;
};

test("changes are classified so adapters can pick reload vs rebuild", () => {
  assert.equal(classifyChange("lib/main.dart"), "source");
  assert.equal(classifyChange("src/App.tsx"), "source");
  assert.equal(classifyChange("pubspec.yaml"), "dependency");
  assert.equal(classifyChange("app/build.gradle.kts"), "dependency");
  assert.equal(classifyChange("gradle/libs.versions.toml"), "dependency");
  assert.equal(classifyChange("package.json"), "dependency");
  assert.equal(classifyChange("app/src/main/AndroidManifest.xml"), "config");
  assert.equal(classifyChange("android/app/src/main/java/com/x/MainActivity.kt"), "native");
  assert.equal(classifyChange("app/src/main/java/com/x/Main.kt"), "source");
});

test("generated folders, editor temp files and .gitignore patterns are ignored", () => {
  for (const p of [".git/index", "node_modules/a/b.js", "app/build/x.class", "build/app.apk", ".dart_tool/x", "android/.gradle/f", "reports/r.json", "lib/.main.dart.swp", "lib/main.dart~", ".DS_Store", "x.tmp"]) assert.ok(isIgnored(p), p);
  for (const p of ["lib/main.dart", "app/src/main/java/A.kt", "src/build.ts", "builder/x.ts"]) assert.ok(!isIgnored(p), p);
  const gi = parseGitignore("# c\n/secret.txt\n*.gen.dart\ngenerated/\n!keep.gen.dart\n");
  assert.ok(isIgnored("secret.txt", gi));
  assert.ok(!isIgnored("a/secret.txt", gi));
  assert.ok(isIgnored("lib/x.gen.dart", gi));
  assert.ok(isIgnored("lib/generated/a.dart", gi));
});

test("watcher: a burst of saves is one batch; unchanged rewrites and ignored folders are dropped; deletes and renames are seen", async () => {
  const dir = await tmp();
  await tree(dir, { "lib/a.dart": "a", "lib/b.dart": "b", ".gitignore": "*.gen.dart\n" });
  const batches = [];
  const w = new ProjectWatcher(dir, { debounceMs: 150, onBatch: (c) => batches.push(c) });
  await w.start();
  try {
    await sleep(100);
    for (let i = 0; i < 10; i++) await writeFile(join(dir, "lib/a.dart"), `a${i}`);
    await writeFile(join(dir, "lib/b.dart"), "b2");
    await mkdir(join(dir, "build"), { recursive: true });
    await writeFile(join(dir, "build/out.txt"), "x");
    await writeFile(join(dir, "lib/x.gen.dart"), "x");
    assert.ok(await until(() => batches.length >= 1));
    await sleep(400);
    assert.equal(batches.length, 1, JSON.stringify(batches));
    assert.deepEqual(batches[0].map((c) => c.path).sort(), ["lib/a.dart", "lib/b.dart"]);
    assert.ok(batches[0].every((c) => c.event === "modified"), "files that existed before the watch are modified, not added");

    await writeFile(join(dir, "lib/a.dart"), "a9"); // same bytes as last time
    await sleep(500);
    assert.equal(batches.length, 1, "unchanged content must not trigger an update");

    await rm(join(dir, "lib/b.dart"));
    assert.ok(await until(() => batches.length === 2));
    assert.deepEqual(batches[1], [{ path: "lib/b.dart", event: "deleted", kind: "source" }]);

    // An editor's temp file that comes and goes within one debounce is not reported.
    await writeFile(join(dir, "lib/sedAB12"), "x");
    await rm(join(dir, "lib/sedAB12"));
    await sleep(500);
    assert.equal(batches.length, 2, JSON.stringify(batches.slice(2)));

    await rename(join(dir, "lib/a.dart"), join(dir, "lib/c.dart"));
    assert.ok(await until(() => batches.length === 3));
    const ev = Object.fromEntries(batches[2].map((c) => [c.path, c.event]));
    assert.equal(ev["lib/a.dart"], "deleted");
    assert.ok(ev["lib/c.dart"], "renamed-to file is reported");
  } finally {
    w.close();
  }
});

test("coalescing queue never overlaps jobs and merges changes that arrive during a job", async () => {
  let active = 0,
    maxActive = 0;
  const runs = [];
  const q = new CoalescingQueue(async (items) => {
    active++;
    maxActive = Math.max(maxActive, active);
    runs.push(items.map((i) => i.path).sort());
    await sleep(60);
    active--;
  }, (i) => i.path);
  q.push([{ path: "a" }]);
  await sleep(10);
  q.push([{ path: "b" }]);
  q.push([{ path: "c" }, { path: "b" }]);
  await q.idle();
  assert.equal(maxActive, 1);
  assert.deepEqual(runs, [["a"], ["b", "c"]]);
  q.stop();
  q.push([{ path: "d" }]);
  await q.idle();
  assert.equal(runs.length, 2, "nothing runs after stop");
});

test("update plan: hot reload only for Dart edits; Metro only for JS; native and dependency changes rebuild", () => {
  const ch = (path, event = "modified") => ({ path, event, kind: classifyChange(path) });
  assert.equal(planUpdate("flutter-daemon", [ch("lib/main.dart")]).mechanism, "hot-reload");
  assert.equal(planUpdate("flutter-daemon", [ch("lib/new.dart", "added")]).mechanism, "hot-reload", "atomic saves look like adds");
  assert.equal(planUpdate("flutter-daemon", [ch("lib/old.dart", "deleted")]).mechanism, "hot-restart");
  assert.equal(planUpdate("flutter-daemon", [ch("lib/main.dart"), ch("pubspec.yaml")]).mechanism, "reinstall");
  assert.equal(planUpdate("flutter-daemon", [ch("android/app/src/main/AndroidManifest.xml")]).mechanism, "reinstall");
  assert.equal(planUpdate("metro", [ch("src/App.tsx")]).mechanism, "metro");
  assert.equal(planUpdate("metro", [ch("android/app/src/main/java/x/Main.kt")]).mechanism, "reinstall");
  assert.equal(planUpdate("metro", [ch("package.json")]).mechanism, "reinstall");
  assert.equal(planUpdate("rebuild", [ch("app/src/main/java/A.kt")]).mechanism, "reinstall");
});

test("cycle verdict never says passed without a check on the phone, and Metro updates are inconclusive", () => {
  const ok = { ok: true, confirmed: true, message: "" };
  const healthy = { verdict: "no_crash_observed", reason: "", evidence: [] };
  assert.equal(cycleVerdict({ update: ok, health: healthy }), "passed");
  assert.equal(cycleVerdict({ update: ok }), "not_run");
  assert.equal(cycleVerdict({ update: { ...ok, confirmed: false }, health: healthy }), "inconclusive");
  assert.equal(cycleVerdict({ update: { ok: false, confirmed: false, message: "x" } }), "failed");
  assert.equal(cycleVerdict({ update: ok, health: { ...healthy, verdict: "app_crash" } }), "failed");
  assert.equal(cycleVerdict({ update: ok, health: { ...healthy, verdict: "anr" } }), "failed");
  assert.equal(cycleVerdict({ update: ok, health: { ...healthy, verdict: "app_exited" } }), "inconclusive");
  assert.equal(cycleVerdict({ update: ok, health: { ...healthy, verdict: "device_disconnected" } }), "blocked");
  assert.equal(cycleVerdict({ update: ok, health: healthy, verification: { failed: 1 } }), "failed");
});

// ---- dev session against a stub phone and a stub build (no hardware, no Gradle) ----

const APP = "com.example.devfix";
async function nativeProject() {
  const dir = await tmp("tt-devproj-");
  await tree(dir, {
    "settings.gradle.kts": 'include(":app")\n',
    "build.gradle.kts": "",
    gradlew: "#!/bin/sh\n",
    "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip\n",
    "app/build.gradle.kts": `plugins { id("com.android.application") }\nandroid {\n  namespace = "${APP}"\n  compileSdk = 35\n  defaultConfig { applicationId = "${APP}"; minSdk = 24 }\n}\n`,
    "app/src/main/java/com/example/Main.kt": "fun main() {}\n",
  });
  return dir;
}

function stubPhone(state) {
  return {
    calls: state.calls,
    async logMark() {
      if (state.offline) throw new Error("connection closed");
      return "01-01 00:00:00.000";
    },
    async logsSince(_m, buf) {
      return buf === "crash" && state.crash ? `01-01 00:00:01.000  123  123 E AndroidRuntime: FATAL EXCEPTION: main\n01-01 00:00:01.000  123  123 E AndroidRuntime: Process: ${APP}, PID: 123` : "";
    },
    async pidOf() {
      return state.crash ? undefined : 123;
    },
    async install(p) {
      state.calls.push(["install", p]);
    },
    async forceStop(p) {
      state.calls.push(["forceStop", p]);
    },
    async launch(p) {
      state.calls.push(["launch", p]);
    },
    async screenshotPng() {
      return Buffer.from("png");
    },
    async shell() {
      return { text: "SERIAL" };
    },
    close() {
      state.calls.push(["close"]);
    },
  };
}

function stubBuild(state, apk) {
  return async () => {
    state.builds++;
    if (state.buildFails) return { tool: "tethertrace", schemaVersion: "0.1", kind: "build", ok: false, durationMs: 5, artifacts: [], error: { category: "compile_error", message: "Kotlin compilation failed", hints: ["Fix Main.kt:1"], excerpt: ["e: Main.kt:1:1 Unresolved reference: foo"] } };
    return { tool: "tethertrace", schemaVersion: "0.1", kind: "build", ok: true, durationMs: 5, artifacts: [{ path: apk, sizeBytes: 3, packageName: APP, versionName: "1.0", signature: { v1: false, v2plus: true } }] };
  };
}

test("dev session: deploys, applies an edit with rebuild+reinstall, reports build failures, crashes and disconnects truthfully, then stops cleanly", async () => {
  const dir = await nativeProject();
  const home = await tmp("tt-devhome-");
  const apk = join(home, "app-debug.apk");
  await writeFile(apk, "apk");
  const state = { calls: [], builds: 0, connects: 0 };
  const cycles = [];
  const s = new DevSession({
    dir,
    home,
    connect: async () => {
      state.connects++;
      if (state.connectFails) throw new Error("connect ECONNREFUSED");
      return stubPhone(state);
    },
    buildFn: stubBuild(state, apk),
    healthWaitMs: 0,
    debounceMs: 100,
    onCycle: (c) => cycles.push(c),
  });
  await s.start();
  try {
    assert.equal(s.snap.mode, "rebuild");
    assert.equal(s.snap.pkg, APP);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].verdict, "passed");
    assert.equal(cycles[0].mechanism, "reinstall");
    assert.deepEqual(state.calls.slice(0, 3), [["install", apk], ["forceStop", APP], ["launch", APP]]);
    assert.ok(cycles[0].build.sha256?.length === 64);

    // A second session for the same project is refused while this one runs.
    await assert.rejects(new DevSession({ dir, home, connect: async () => stubPhone(state) }).start(), /already running/);

    // Several quick saves → one rebuild.
    await sleep(150);
    for (let i = 0; i < 5; i++) await writeFile(join(dir, "app/src/main/java/com/example/Main.kt"), `fun main() { println(${i}) }\n`);
    assert.ok(await until(() => cycles.length === 2));
    await sleep(400);
    assert.equal(cycles.length, 2);
    assert.equal(state.builds, 2);
    assert.equal(cycles[1].changes.files[0], "app/src/main/java/com/example/Main.kt");
    assert.equal(cycles[1].verdict, "passed");

    // Build error: failed, with the compiler line and a next action; nothing installed.
    state.buildFails = true;
    const installs = state.calls.filter((c) => c[0] === "install").length;
    await writeFile(join(dir, "app/src/main/java/com/example/Main.kt"), "fun main() { foo() }\n");
    assert.ok(await until(() => cycles.length === 3));
    assert.equal(cycles[2].verdict, "failed");
    assert.equal(cycles[2].build.error.category, "compile_error");
    assert.equal(cycles[2].nextAction, "Fix Main.kt:1");
    assert.equal(state.calls.filter((c) => c[0] === "install").length, installs);

    // Crash after update: failed, crash lines as evidence, screenshot saved.
    state.buildFails = false;
    state.crash = true;
    await writeFile(join(dir, "app/src/main/java/com/example/Main.kt"), "fun main() { crash() }\n");
    assert.ok(await until(() => cycles.length === 4));
    assert.equal(cycles[3].verdict, "failed");
    assert.equal(cycles[3].health.verdict, "app_crash");
    assert.ok(cycles[3].evidence.some((e) => e.endsWith("app.log")));
    assert.ok(cycles[3].evidence.some((e) => e.endsWith("screen.png")));

    // Phone gone: blocked (not failed), then a reconnect on the next change.
    state.crash = false;
    state.offline = true;
    await writeFile(join(dir, "app/src/main/java/com/example/Main.kt"), "fun main() { 1 }\n");
    assert.ok(await until(() => cycles.length === 5));
    assert.equal(cycles[4].verdict, "blocked");
    state.offline = false;
    const before = state.connects;
    await writeFile(join(dir, "app/src/main/java/com/example/Main.kt"), "fun main() { 2 }\n");
    assert.ok(await until(() => cycles.length === 6));
    assert.equal(state.connects, before + 1, "reconnects after a disconnect");
    assert.equal(cycles[5].verdict, "passed");

    const snap = await readSnapshot(dir, home);
    assert.equal(snap.cycles, 6);
    assert.equal(snap.stale, false);
    assert.equal((await readHistory(dir, 50, home)).length, 6);
  } finally {
    // Stop through the request file, as `tethertrace dev stop` does from another process.
    await requestStop(dir, home);
    assert.ok(await until(() => s.snap.state === "stopped", 4000));
    await s.wait();
  }
  assert.equal((await readSnapshot(dir, home)).state, "stopped");
  const n = cycles.length;
  await writeFile(join(dir, "app/src/main/java/com/example/Main.kt"), "fun main() { 3 }\n");
  await sleep(400);
  assert.equal(cycles.length, n, "no updates after stop");
});

test("dev session: verify off reports not_run; an interrupted session is recovered", async () => {
  const dir = await nativeProject();
  const home = await tmp("tt-devhome-");
  const apk = join(home, "a.apk");
  await writeFile(apk, "apk");
  // A state file left by a process that no longer exists.
  await mkdir(sessionDir(dir, home), { recursive: true });
  await writeFile(join(sessionDir(dir, home), "state.json"), JSON.stringify({ pid: 999999, state: "idle", root: dir, cycles: 3, notes: [] }));
  assert.equal((await readSnapshot(dir, home)).stale, true);
  const state = { calls: [], builds: 0 };
  const logs = [];
  const s = new DevSession({ dir, home, verify: "off", connect: async () => stubPhone(state), buildFn: stubBuild(state, apk), log: (m) => logs.push(m) });
  await s.start();
  assert.ok(logs.some((l) => /Recovered/.test(l)));
  assert.equal(s.snap.last.verdict, "not_run");
  await s.stop();
});

test("dev session: a build for a different app id than the one named is not installed", async () => {
  const dir = await nativeProject();
  const home = await tmp("tt-devhome-");
  const apk = join(home, "a.apk");
  await writeFile(apk, "apk");
  const state = { calls: [], builds: 0 };
  const s = new DevSession({ dir, home, pkg: "com.other.app", connect: async () => stubPhone(state), buildFn: stubBuild(state, apk), healthWaitMs: 0 });
  await s.start();
  assert.equal(s.snap.last.verdict, "failed");
  assert.match(s.snap.last.update.message, /refusing to install a different app/);
  assert.equal(state.calls.filter((c) => c[0] === "install").length, 0);
  await s.stop();
});

// ---- Flutter daemon protocol, against a fake `flutter` that speaks it ----

const FAKE_FLUTTER = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write("[" + JSON.stringify(o) + "]\\n");
console.log("Launching lib/main.dart on phone in debug mode...");
send({ event: "app.start", params: { appId: "APP1", deviceId: process.argv[4] } });
setTimeout(() => send({ event: "app.started", params: { appId: "APP1" } }), 50);
let n = 0;
rl.on("line", (l) => {
  const [m] = JSON.parse(l);
  if (m.method === "app.restart") {
    n++;
    if (!m.params.fullRestart && n === 2) send({ id: m.id, result: { code: 1, message: "Hot reload was rejected: Const class cannot become non-const. Try performing a hot restart instead." } });
    else send({ id: m.id, result: { code: 0, message: m.params.fullRestart ? "Restarted application" : "Reloaded 1 of 500 libraries" } });
  }
  if (m.method === "app.stop") { send({ id: m.id, result: true }); process.exit(0); }
});
`;

async function fakeFlutter() {
  const dir = await tmp("tt-flutter-");
  await writeFile(join(dir, "fake.cjs"), FAKE_FLUTTER);
  if (process.platform === "win32") {
    const p = join(dir, "flutter.cmd");
    await writeFile(p, `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
    return p;
  }
  const p = join(dir, "flutter");
  await writeFile(p, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`);
  await chmod(p, 0o755);
  return p;
}

test("flutter daemon: start waits for app.started; reload success, rejection and restart are reported as Flutter answered", async () => {
  const bin = await fakeFlutter();
  const f = new FlutterRunSession(bin, tmpdir(), "192.168.1.5:40000");
  await f.start(20_000);
  assert.equal(f.appId, "APP1");
  assert.deepEqual(await f.restart(false), { ok: true, message: "Reloaded 1 of 500 libraries", restartRecommended: false });
  const rejected = await f.restart(false);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.restartRecommended, true);
  assert.equal((await f.restart(true)).ok, true);
  await f.stop();
  assert.ok(await until(() => !f.running, 5000), "flutter process ends on stop");
});

test("flutter device listing and matching", () => {
  const out = 'Waiting...\n[{"name":"RMX3563","id":"192.168.1.5:40000","targetPlatform":"android-arm64"},{"name":"Chrome","id":"chrome","targetPlatform":"web-javascript"}]';
  const list = parseFlutterDevices(out);
  assert.equal(list.length, 1);
  assert.equal(matchFlutterDevice(list, "192.168.1.5:40000")?.id, "192.168.1.5:40000");
  assert.equal(matchFlutterDevice([...list, { ...list[0], id: "other" }], "10.0.0.1:5555"), undefined, "ambiguous: no guess");
  assert.equal(parseDaemonLine("Launching..."), undefined);
  assert.deepEqual(parseDaemonLine('[{"id":1,"result":{"code":0}}]'), [{ id: 1, result: { code: 0 } }]);
});

test("dev MCP tools: dev_start needs --allow-build and is never available read-only; status tools are read-only", () => {
  assert.match(new Policy({ auditFile: false }).unavailable("dev_start"), /--allow-build/);
  assert.match(new Policy({ allowShell: true, auditFile: false }).unavailable("dev_start"), /--allow-build/);
  assert.match(new Policy({ allowBuild: true, readOnly: true, auditFile: false }).unavailable("dev_start"), /read-only/);
  assert.equal(new Policy({ allowBuild: true, auditFile: false }).unavailable("dev_start"), undefined);
  assert.equal(new Policy({ readOnly: true, auditFile: false }).unavailable("dev_status"), undefined);
  assert.equal(new Policy({ readOnly: true, auditFile: false }).unavailable("dev_wait"), undefined);
});

test("CLI: dev is listed, validates --verify, and status works with no session", async () => {
  const cli = join(process.cwd(), "dist", "cli.js");
  const help = (await run(process.execPath, [cli, "dev", "--help"])).stdout;
  assert.match(help, /--verify <level>/);
  assert.match(help, /hot reload/);
  await assert.rejects(run(process.execPath, [cli, "dev", "--verify", "always"]), /Allowed choices/);
  const dir = await tmp();
  const st = await run(process.execPath, [cli, "dev", "status", "--project", dir, "--json"], { env: { ...process.env, TETHERTRACE_HOME: await tmp("tt-h-") } });
  assert.equal(JSON.parse(st.stdout).session, null);
});
