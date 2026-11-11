import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AdbKey, Device, MemoryError, coveredChange, describeVerify, emptyMemory, findFlows, forgetMemory, globToRegExp, listMemories, loadMemory, memoryFile,
  parseBuildIdentity, rememberExploration, saveMemory, selectFlows, sourceChanges, verify,
} from "../dist/index.js";
import { startAdbd, TINY_PNG } from "./helpers/mock-device.mjs";

const PKG = "com.example.notes";
const key = AdbKey.generate("test@host");
const tmp = (name) => mkdtemp(join(tmpdir(), `tt-${name}-`));

test("build identity: version and install time from dumpsys; same version rebuilt is a different build", () => {
  const a = parseBuildIdentity("    versionCode=7 minSdk=24 targetSdk=36\n    versionName=1.2.0\n    lastUpdateTime=2026-11-10 09:00:00\n");
  assert.deepEqual(a, { id: "7@2026-11-10 09:00:00", versionName: "1.2.0", versionCode: 7, installedAt: "2026-11-10 09:00:00" });
  const b = parseBuildIdentity("    versionCode=7 minSdk=24\n    versionName=1.2.0\n    lastUpdateTime=2026-11-11 18:30:00\n");
  assert.notEqual(a.id, b.id);
  assert.equal(parseBuildIdentity("").id, "unknown");
});

test("covers globs: ** crosses folders, * stays in one name, a folder covers what is inside it", () => {
  assert.ok(globToRegExp("app/src/**/login/**").test("app/src/main/java/com/x/login/LoginActivity.kt"));
  assert.ok(globToRegExp("lib/screens/*.dart").test("lib/screens/home.dart"));
  assert.ok(!globToRegExp("lib/screens/*.dart").test("lib/screens/auth/login.dart"));
  assert.ok(globToRegExp("lib/auth").test("lib/auth/login.dart"));
  assert.ok(!globToRegExp("lib/auth").test("lib/authors.dart"));
  assert.ok(globToRegExp("**/*.kt").test("Main.kt"));
  assert.equal(coveredChange(["lib/auth/**"], ["README.md", "lib\\auth\\login.dart"]), "lib\\auth\\login.dart");
  assert.equal(coveredChange(["lib/auth/**"], ["README.md"]), undefined);
});

const flowFile = (name, hash = "h1", covers) => ({ file: `/p/flows/${name}.yaml`, flow: { app: PKG, name, steps: ["launch"] }, sha256: hash, covers });
const withRuns = (...flows) => ({ ...emptyMemory(PKG), flows: flows.map(([name, runs]) => ({ file: `/p/flows/${name}.yaml`, name, runs })) });
const run = (build, status = "passed", sha256 = "h1") => ({ build, at: "2026-11-10T00:00:00Z", status, sha256 });

test("changed mode: a flow is skipped only for a recorded reason; anything unknown runs", () => {
  const pick = (o) => Object.fromEntries(selectFlows({ mode: "changed", build: "2@b", ...o }).map((d) => [d.name, `${d.run ? "run" : "skip"}: ${d.reason}`]));

  const memory = withRuns(["same", [run("2@b")]], ["edited", [run("2@b", "passed", "old")]], ["failed", [run("2@b", "failed")]], ["old", [run("1@a")]], ["login", [run("1@a")]], ["cart", [run("1@a")]]);
  const flows = [flowFile("new"), flowFile("same"), flowFile("edited"), flowFile("failed"), flowFile("old"), flowFile("login", "h1", ["lib/auth/**"]), flowFile("cart", "h1", ["lib/cart/**"])];

  const r = pick({ memory, flows, changedFiles: ["lib/auth/login.dart"] });
  assert.match(r.new, /^run: never run/);
  assert.match(r.same, /^skip: already passed on this build/);
  assert.match(r.edited, /^run: the flow file changed/);
  assert.match(r.failed, /^run: failed last time/);
  assert.match(r.old, /^run: new build, and the flow does not say/);
  assert.match(r.login, /^run: lib\/auth\/login.dart changed/);
  assert.match(r.cart, /^skip: new build, but nothing this flow covers changed/);

  // Without knowing what changed, "covers" cannot rule anything out.
  assert.match(pick({ memory, flows }).cart, /^run: new build, and what changed in the source is not known/);
  // A build that cannot be identified is never treated as "the same build".
  assert.match(pick({ memory: withRuns(["same", [run("unknown")]]), flows: [flowFile("same")], build: "unknown" }).same, /^run: the installed build could not be identified/);

  assert.ok(selectFlows({ mode: "full", build: "2@b", memory, flows }).every((d) => d.run));
  assert.ok(selectFlows({ mode: "discover", build: "2@b", memory, flows }).every((d) => !d.run));
});

test("memory file: missing is empty, saved is readable, a broken file is an error and is left alone", async () => {
  const home = await tmp("mem");
  assert.deepEqual(await loadMemory(PKG, home), emptyMemory(PKG));
  const m = emptyMemory(PKG);
  m.notes = "checked by hand";
  await saveMemory(m, home);
  assert.equal((await loadMemory(PKG, home)).notes, "checked by hand");
  assert.deepEqual(await listMemories(home), [PKG]);

  await writeFile(memoryFile(PKG, home), "{ not json");
  await assert.rejects(loadMemory(PKG, home), (e) => e instanceof MemoryError && /not valid JSON/.test(e.message));
  assert.equal(await readFile(memoryFile(PKG, home), "utf8"), "{ not json");

  await writeFile(memoryFile(PKG, home), JSON.stringify({ ...emptyMemory("com.other.app") }));
  await assert.rejects(loadMemory(PKG, home), /is about "com.other.app"/);
  await writeFile(memoryFile(PKG, home), JSON.stringify({ ...emptyMemory(PKG), schemaVersion: "memory.0" }));
  await assert.rejects(loadMemory(PKG, home), /schemaVersion/);

  assert.throws(() => memoryFile("../../etc/passwd", home));
  assert.equal(await forgetMemory(PKG, home), true);
  assert.equal(await forgetMemory(PKG, home), false);
});

const explored = (...titles) => ({
  startedAt: "2026-11-11T00:00:00Z",
  verdict: "no_crash_observed",
  coverage: { level: "ok", tapped: 5 },
  screens: titles.map((t, i) => ({ id: i + 1, signature: `sig-${t}`, title: t, elements: 10 })),
});

test("screens: the first exploration records, later ones report new and not-reached screens", () => {
  const m = emptyMemory(PKG);
  const first = rememberExploration(m, "1@a", explored("Home", "Settings", "Feed"));
  assert.deepEqual(first, { first: true, added: [], notReached: [] });
  assert.equal(m.screens.length, 3);

  m.screens.find((s) => s.title === "Feed").ignore = true; // a person marked it as always different
  const second = rememberExploration(m, "2@b", explored("Home", "Profile"));
  assert.equal(second.first, false);
  assert.deepEqual(second.added.map((s) => s.title), ["Profile"]);
  assert.deepEqual(second.notReached.map((s) => s.title), ["Settings"]);
  assert.equal(m.screens.find((s) => s.title === "Home").lastSeenBuild, "2@b");
  assert.equal(m.screens.find((s) => s.title === "Settings").lastSeenBuild, "1@a");
  assert.equal(m.screens.find((s) => s.title === "Feed").ignore, true);
  assert.equal(m.explorations.length, 2);
});

test("findFlows: reads covers, and reports a file it cannot use instead of dropping it", async () => {
  const dir = await tmp("flows");
  await mkdir(join(dir, "auth"));
  await writeFile(join(dir, "auth", "login.yaml"), `app: ${PKG}\ncovers:\n  - lib/auth/**\nsteps:\n  - launch\n`);
  await writeFile(join(dir, "home.yml"), `app: ${PKG}\ncovers: lib/home\nsteps:\n  - launch\n`);
  await writeFile(join(dir, "broken.yaml"), "steps: []\n");
  const { flows, problems } = await findFlows([dir, join(dir, "missing.yaml")]);
  assert.deepEqual(flows.map((f) => [f.flow.name, f.covers]), [["login", ["lib/auth/**"]], ["home", ["lib/home"]]]);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /missing "app/);
  assert.match(problems.join("\n"), /not found/);
});

test("sourceChanges: committed and uncommitted files since the last verified commit", async () => {
  const dir = await tmp("git");
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe" }).toString().trim();
  assert.match((await sourceChanges(dir)).note, /not a git checkout/);
  git("init", "-q");
  await writeFile(join(dir, "a.txt"), "1");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  const first = git("rev-parse", "HEAD");
  assert.match((await sourceChanges(dir)).note, /no earlier verified commit/);
  await mkdir(join(dir, "lib"));
  await writeFile(join(dir, "lib", "b.txt"), "2");
  git("add", ".");
  git("commit", "-q", "-m", "two");
  await writeFile(join(dir, "c.txt"), "3"); // not committed
  const s = await sourceChanges(dir, first);
  assert.deepEqual(s.changedFiles.sort(), ["c.txt", "lib/b.txt"]);
  assert.match((await sourceChanges(dir, "0".repeat(40))).note, /not in this checkout/);
});

const SCREEN = (button) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node text="" resource-id="" class="android.widget.FrameLayout" package="${PKG}" clickable="false" bounds="[0,0][1080,2400]">
<node text="Notes" resource-id="" class="android.widget.TextView" package="${PKG}" clickable="false" bounds="[72,96][1008,139]" />
<node text="${button}" resource-id="" class="android.widget.Button" package="${PKG}" clickable="true" bounds="[72,1956][1008,2112]" />
</node></hierarchy>`;

function phone() {
  const state = { installedAt: "2026-11-10 09:00:00", button: "New note" };
  const handler = (cmd, kind) => {
    if (kind === "exec") return cmd.startsWith("screencap") ? TINY_PNG : "";
    if (cmd.startsWith("date ")) return "11-07 20:00:00.000\n";
    if (cmd.startsWith("pm path")) return "package:/data/app/base.apk\n";
    if (cmd.startsWith("dumpsys package")) return `    versionCode=3 minSdk=24\n    versionName=1.0\n    lastUpdateTime=${state.installedAt}\n`;
    if (cmd.startsWith("am force-stop")) return "";
    if (cmd.startsWith("cmd package resolve-activity")) return `${PKG}/.MainActivity\n`;
    if (cmd.startsWith("am start -W")) return "Status: ok\nTotalTime: 900\n";
    if (cmd.startsWith("pidof")) return "4321\n";
    if (cmd.startsWith("wm size")) return "Physical size: 1080x2400\n";
    if (cmd.startsWith("uiautomator dump")) return SCREEN(state.button);
    if (cmd.startsWith("input ")) return "";
    return undefined;
  };
  return { state, handler };
}

test("verify --changed: runs what is new, skips what already passed on this build, and calls a regression a regression", async () => {
  const { state, handler } = phone();
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  const home = await tmp("home");
  const work = await tmp("work");
  await writeFile(join(work, "note.yaml"), `app: ${PKG}\nsteps:\n  - launch\n  - tap: { text: "New note", timeoutMs: 600 }\n`);
  const { flows } = await findFlows([work]);
  const go = async (n, mode = "changed") => {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    try {
      return await verify(d, { pkg: PKG, mode, flows, outDir: join(work, `r${n}`), explore: false, home });
    } finally {
      d.close();
    }
  };
  try {
    const first = await go(1);
    assert.equal(first.status, "passed");
    assert.equal(first.build.new, true);
    assert.deepEqual(first.flows.map((f) => [f.status, f.reason]), [["passed", "never run before"]]);

    const again = await go(2);
    assert.equal(again.status, "nothing_checked");
    assert.equal(again.build.new, false);
    assert.deepEqual(again.flows.map((f) => f.status), ["not_run"]);
    assert.match(describeVerify(again), /note: not run \(already passed on this build\)/);
    // A skipped flow adds no run: memory still holds exactly the one real pass.
    assert.equal((await loadMemory(PKG, home)).flows[0].runs.length, 1);

    // A new build where the button is gone.
    state.installedAt = "2026-11-11 18:30:00";
    state.button = "Something else";
    const third = await go(3);
    assert.equal(third.status, "failed");
    assert.equal(third.build.new, true);
    assert.equal(third.build.previous, "3@2026-11-10 09:00:00");
    assert.equal(third.flows[0].regression, true);
    assert.equal(third.flows[0].failure.category, "element_not_found");
    assert.match(describeVerify(third), /REGRESSION: passed on the previous build/);

    const m = await loadMemory(PKG, home);
    assert.deepEqual(m.builds.map((b) => b.id), ["3@2026-11-10 09:00:00", "3@2026-11-11 18:30:00"]);
    assert.deepEqual(m.flows[0].runs.map((r) => r.status), ["passed", "failed"]);
    // The flow file itself is never rewritten.
    assert.match(await readFile(join(work, "note.yaml"), "utf8"), /New note/);

    // Same build again: it failed last time, so it runs again instead of being skipped.
    assert.equal((await go(4)).flows[0].reason, "failed last time");
    assert.equal(JSON.parse(await readFile(join(work, "r4", "verify.json"), "utf8")).kind, "verify");
  } finally {
    await dev.close();
  }
});
