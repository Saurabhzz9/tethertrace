import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AdbKey, Device, TappError, analyzeApk, checkCompatibility, contentSecurityPolicy, describeCompatibility, generateSigningKey, injectRuntime, isSafePackagePath,
  listZipEntries, pack, parseDex, readZipEntryData, runOnAndroid, startDesktopRuntime, verifyTapp, IOS_COMPONENT_MATRIX, ANDROID_HOST_VERSION,
} from "../dist/index.js";
import { axml, zip } from "./helpers/apk.mjs";
import { startAdbd } from "./helpers/mock-device.mjs";

const tmp = (p = "tt-uni-") => mkdtemp(join(tmpdir(), p));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cli = (...args) => new Promise((res) => execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })));

/** A DEX file with a valid header and the given type descriptors; enough for dependency detection. */
function dex(types, classes = types.length, methods = 10) {
  const strings = types.map((t) => Buffer.concat([Buffer.from([t.length]), Buffer.from(t, "latin1"), Buffer.from([0])]));
  const idsOff = 0x70;
  const typeOff = idsOff + types.length * 4;
  let dataOff = typeOff + types.length * 4;
  const b = Buffer.alloc(dataOff + strings.reduce((n, s) => n + s.length, 0));
  b.write("dex\n035\0", 0, "latin1");
  b.writeUInt32LE(types.length, 0x38); b.writeUInt32LE(idsOff, 0x3c);
  b.writeUInt32LE(types.length, 0x40); b.writeUInt32LE(typeOff, 0x44);
  b.writeUInt32LE(methods, 0x58); b.writeUInt32LE(classes, 0x60);
  strings.forEach((s, i) => {
    b.writeUInt32LE(dataOff, idsOff + i * 4);
    b.writeUInt32LE(i, typeOff + i * 4);
    s.copy(b, dataOff);
    dataOff += s.length;
  });
  return b;
}

const manifestXml = (pkg, extra = []) =>
  axml(
    ["manifest", "package", pkg, "versionName", "2.1.0", "uses-sdk", "minSdkVersion", "targetSdkVersion", "application", "activity", "service", "uses-permission", "name", "android.permission.CAMERA", "android.permission.INTERNET", ".Main", ...extra],
    [
      { name: "manifest", attrs: [["package", pkg], ["versionName", "2.1.0"]] },
      { name: "uses-sdk", attrs: [["minSdkVersion", 24], ["targetSdkVersion", 36]] },
      { name: "uses-permission", attrs: [["name", "android.permission.INTERNET"]] },
      { name: "uses-permission", attrs: [["name", "android.permission.CAMERA"]] },
      { name: "application", attrs: [] },
      { name: "activity", attrs: [["name", ".Main"]] },
      { name: "service", attrs: [["name", ".Main"]] },
    ],
  );

async function apk(name, pkg, entries) {
  const file = join(await tmp(), name);
  await writeFile(file, zip([{ name: "AndroidManifest.xml", data: manifestXml(pkg), deflate: true }, ...entries.map(([n, d]) => ({ name: n, data: Buffer.isBuffer(d) ? d : Buffer.from(d), deflate: true }))]));
  return file;
}

test("analyze: reads the manifest, DEX and native code of an APK without running it", async () => {
  const f = await apk("native.apk", "com.example.shop", [
    ["classes.dex", dex(["Lcom/example/shop/Main;", "Lcom/google/android/gms/maps/GoogleMap;", "Lcom/google/firebase/FirebaseApp;", "Ldalvik/system/DexClassLoader;"], 120, 900)],
    ["classes2.dex", dex(["Lcom/android/billingclient/api/BillingClient;"], 30, 100)],
    ["lib/arm64-v8a/libcrypto_helper.so", "\x7fELF"],
    ["lib/armeabi-v7a/libcrypto_helper.so", "\x7fELF"],
    ["res/layout/main.xml", "x"],
    ["assets/data.bin", "12345"],
  ]);
  const a = await analyzeApk(f);
  assert.equal(a.packageName, "com.example.shop");
  assert.equal(a.versionName, "2.1.0");
  assert.equal(a.minSdk, 24);
  assert.deepEqual(a.dex, { files: 2, bytes: a.dex.bytes, classes: 150, methods: 1000 });
  assert.equal(a.framework.kind, "native-android");
  assert.deepEqual(Object.keys(a.native.abis).sort(), ["arm64-v8a", "armeabi-v7a"]);
  assert.deepEqual(a.manifest.permissions, ["android.permission.CAMERA", "android.permission.INTERNET"]);
  assert.equal(a.manifest.activities, 1);
  assert.equal(a.manifest.services, 1);
  assert.deepEqual(a.dependencies.map((d) => d.id).sort(), ["firebase", "google-play-services", "play-billing"]);
  assert.equal(a.loadsCodeAtRuntime, true);
  assert.equal(a.webLayer, undefined);
  assert.equal(parseDex(dex(["Lx/Y;"], 1, 2)).types[0], "Lx/Y;");
  await assert.rejects(analyzeApk(fileURLToPath(new URL("./universal.test.mjs", import.meta.url))), /not an APK/);
});

test("compatibility --target ios: never says an APK runs, names the route and every blocker", async () => {
  const native = await analyzeApk(await apk("n.apk", "com.example.shop", [["classes.dex", dex(["Lcom/example/A;", "Lcom/google/android/gms/common/api/Api;"])], ["lib/arm64-v8a/libfoo.so", "\x7fELF"]]));
  const rn = checkCompatibility(native, "ios");
  assert.equal(rn.runsUnmodified, false);
  assert.equal(rn.route, "none");
  assert.deepEqual(rn.blockers.map((b) => b.id), ["no-android-runtime", "native-code", "google-play-services"]);
  assert.equal(rn.portable.length, 0);
  assert.match(describeCompatibility(rn), /Runs unmodified: no/);
  assert.match(rn.disclaimer, /Nothing was executed.*not.*tested on an iOS device|nothing here has been tested on an iOS device/s);

  const flutter = checkCompatibility(await analyzeApk(await apk("f.apk", "com.example.fl", [["classes.dex", dex(["Lio/flutter/embedding/Main;"])], ["lib/arm64-v8a/libflutter.so", "\x7fELF"], ["lib/arm64-v8a/libapp.so", "\x7fELF"]])), "ios");
  assert.equal(flutter.route, "rebuild_from_source");
  assert.match(flutter.routeSummary, /rebuild, not a conversion/);

  const hybrid = await analyzeApk(await apk("c.apk", "com.example.hybrid", [["classes.dex", dex(["Lcom/getcapacitor/Bridge;"])], ["assets/public/index.html", "<h1>hi</h1>"], ["assets/public/app.js", "1"]]));
  assert.equal(hybrid.framework.kind, "capacitor");
  assert.deepEqual(hybrid.webLayer, { root: "assets/public", entry: "index.html", files: 2, bytes: 12 });
  const rc = checkCompatibility(hybrid, "ios");
  assert.equal(rc.route, "repackage_web_layer");
  assert.equal(rc.runsUnmodified, false);
  assert.match(rc.routeSummary, /This is not running the Android app/);

  assert.throws(() => checkCompatibility(native, "windows"), /Only "ios"/);
  // The matrix used in docs: native code and Android services are never called portable.
  assert.equal(IOS_COMPONENT_MATRIX.find((r) => r.part.startsWith("Native libraries")).portable, "no");
  assert.equal(IOS_COMPONENT_MATRIX.find((r) => r.part.startsWith("DEX")).portable, "with a runtime");
});

async function project(files = {}, config = { id: "com.example.notes", name: "Notes", version: "1.2.3", permissions: ["storage"] }) {
  const dir = await tmp();
  const all = { "index.html": "<!doctype html><html><head><title>n</title></head><body><script src=\"app.js\"></script></body></html>", "app.js": "console.log(1)", "img/logo.svg": "<svg/>", ...files };
  for (const [n, d] of Object.entries(all)) {
    await mkdir(join(dir, n, ".."), { recursive: true });
    await writeFile(join(dir, n), d);
  }
  if (config) await writeFile(join(dir, "tapp.config.json"), JSON.stringify(config));
  return dir;
}

test("pack: a manifest with a checksum for every file, the same bytes every time, and nothing secret inside", async () => {
  const dir = await project({ ".env": "SECRET=1", "node_modules/x/index.js": "x", "app.js.map": "{}", ".git/HEAD": "ref" });
  const out = join(await tmp(), "notes.tapp");
  const r = await pack(dir, { out });
  assert.deepEqual(Object.keys(r.manifest.files), ["app.js", "img/logo.svg", "index.html"]);
  assert.equal(r.manifest.id, "com.example.notes");
  assert.deepEqual(r.manifest.permissions, ["storage"]);
  assert.deepEqual(r.manifest.targets, {});
  assert.equal(r.manifest.files["app.js"].size, 14);
  const again = await pack(dir, { out: join(await tmp(), "again.tapp") });
  assert.equal(again.sha256, r.sha256, "packing the same input twice gives the same file");

  const v = await verifyTapp(out);
  assert.equal(v.signedBy, undefined);
  assert.equal((await v.read("app.js")).toString(), "console.log(1)");
  await assert.rejects(v.read("../secret"), (e) => e.code === "NOT_FOUND");
});

test("pack: finds the built folder, and explains instead of guessing when there is nothing to pack", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/Web App", version: "3.0.0", scripts: { build: "vite build" }, dependencies: { express: "5" } }));
  await assert.rejects(pack(dir), (e) => e instanceof TappError && e.code === "NOT_FOUND" && /Run the project's build first.*does not run package scripts/.test(e.message));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "index.html"), '<script src="https://cdn.example.com/x.js"></script>');
  const r = await pack(dir, { out: join(dir, "o.tapp") });
  assert.equal(r.manifest.id, "app.tapp.acme_web_app");
  assert.equal(r.manifest.version, "3.0.0");
  assert.match(r.notes.join("\n"), /depends on express\. Server code is not part of a package/);
  assert.match(r.notes.join("\n"), /loads a script from the network/);

  const next = await tmp();
  await writeFile(join(next, "package.json"), JSON.stringify({ name: "site", dependencies: { next: "15" } }));
  await assert.rejects(pack(next), /Next\.js.*output: "export".*cannot be packed/s);
});

test("verify: a changed file, an extra file, a bad path or a bad manifest is refused", async () => {
  const out = join(await tmp(), "p.tapp");
  await pack(await project(), { out });
  const entries = await listZipEntries(out);
  const parts = Object.fromEntries(await Promise.all(entries.map(async (e) => [e.name, await readZipEntryData(out, e)])));
  const rebuilt = async (change) => {
    const p = { ...parts };
    change(p);
    const f = join(await tmp(), "x.tapp");
    await writeFile(f, zip(Object.entries(p).map(([name, data]) => ({ name, data, deflate: true }))));
    return f;
  };
  const code = (c) => (e) => e instanceof TappError && e.code === c;

  await assert.rejects(verifyTapp(await rebuilt((p) => (p["app.js"] = Buffer.from("console.log(2)")))), code("INTEGRITY"));
  await assert.rejects(verifyTapp(await rebuilt((p) => (p["evil.js"] = Buffer.from("x")))), (e) => e.code === "INTEGRITY" && /not in the manifest/.test(e.message));
  await assert.rejects(verifyTapp(await rebuilt((p) => delete p["img/logo.svg"])), (e) => e.code === "INTEGRITY" && /missing/.test(e.message));
  await assert.rejects(verifyTapp(await rebuilt((p) => delete p["tapp.json"])), code("INVALID"));
  const edit = (fn) => (p) => {
    const m = JSON.parse(p["tapp.json"].toString());
    fn(m);
    p["tapp.json"] = Buffer.from(JSON.stringify(m));
  };
  await assert.rejects(verifyTapp(await rebuilt(edit((m) => (m.files["../../outside.js"] = m.files["app.js"])))), (e) => e.code === "INVALID" && /not an allowed file path/.test(e.message));
  await assert.rejects(verifyTapp(await rebuilt(edit((m) => (m.tapp = 2)))), code("UNSUPPORTED"));
  await assert.rejects(verifyTapp(await rebuilt(edit((m) => m.permissions.push("root")))), /permissions/);
  await assert.rejects(verifyTapp(await rebuilt(edit((m) => (m.network = ["https://api.example.com"])))), /"network" permission is not requested/);
  await assert.rejects(verifyTapp(await rebuilt(edit((m) => (m.network = ["http://insecure.example.com"]) && m.permissions.push("network")))), /https origins/);
  await assert.rejects(verifyTapp(await rebuilt(edit((m) => (m.targets = { ios: "app.ipa" })))), /targets/);
  await assert.rejects(verifyTapp(join(await tmp(), "nope.tapp")), code("NOT_FOUND"));

  for (const bad of ["/abs", "a/../b", "a\\b", "C:/x", "a//b", "", "./a"]) assert.equal(isSafePackagePath(bad), false, bad);
  for (const good of ["index.html", "assets/img/a b.png", "ünï.js"]) assert.equal(isSafePackagePath(good), true, good);
});

test("signing: a signed package names its key, and a manifest changed after signing is refused", async () => {
  const dir = await project();
  const key = generateSigningKey();
  const keyFile = join(await tmp(), "k.pem");
  await writeFile(keyFile, key.privateKeyPem);
  const out = join(await tmp(), "s.tapp");
  const r = await pack(dir, { out, keyFile });
  assert.equal(r.signedBy, key.fingerprint);
  assert.equal((await verifyTapp(out)).signedBy, key.fingerprint);

  // Re-pack the same files unsigned (so the hashes are right), then keep the old signature next to a manifest that differs.
  const other = await project({}, { id: "com.example.other", name: "Other", version: "1.2.3", permissions: ["storage"] });
  const o2 = join(await tmp(), "o.tapp");
  await pack(other, { out: o2 });
  const sig = await readZipEntryData(out, (await listZipEntries(out)).find((e) => e.name === "tapp.sig"));
  const parts = await Promise.all((await listZipEntries(o2)).map(async (e) => ({ name: e.name, data: await readZipEntryData(o2, e), deflate: true })));
  const forged = join(await tmp(), "f.tapp");
  await writeFile(forged, zip([...parts, { name: "tapp.sig", data: sig, deflate: true }]));
  await assert.rejects(verifyTapp(forged), (e) => e.code === "SIGNATURE");
});

test("desktop runtime: serves only the package, with the runtime scripts in front and a strict content policy", async () => {
  const out = join(await tmp(), "d.tapp");
  await pack(await project({}, { id: "com.example.notes", name: "Notes", version: "1.2.3", permissions: ["storage", "network"], network: ["https://api.example.com"] }), { out });
  const pkg = await verifyTapp(out);
  const rt = await startDesktopRuntime(pkg);
  try {
    const index = await fetch(rt.url);
    const html = await index.text();
    assert.match(html, /<head><script src="\/__tapp\/boot\.js"><\/script><script src="\/__tapp\/bridge\.js"><\/script><title>/);
    const csp = index.headers.get("content-security-policy");
    assert.equal(csp, contentSecurityPolicy(pkg.manifest));
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self' https:\/\/api\.example\.com;/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");

    const boot = await (await fetch(`${rt.url}__tapp/boot.js`)).text();
    assert.match(boot, /"id":"com\.example\.notes"/);
    assert.match(boot, /"platform":"desktop"/);
    assert.match(await (await fetch(`${rt.url}__tapp/bridge.js`)).text(), /window\.tapp = Object\.freeze/);
    assert.equal((await fetch(`${rt.url}img/logo.svg`)).headers.get("content-type"), "image/svg+xml");

    for (const p of ["tapp.json", "tapp.config.json", "..%2f..%2fpackage.json", "%2e%2e/%2e%2e/etc/passwd", "nope.js"]) assert.equal((await fetch(rt.url + p)).status, 404, p);
    assert.equal((await fetch(rt.url, { method: "POST" })).status, 405);
  } finally {
    await rt.close();
  }
  // No network permission: nothing but the package itself may be contacted.
  assert.match(contentSecurityPolicy({ permissions: [], network: [] }), /connect-src 'self';/);
  assert.equal(injectRuntime("<p>no head</p>").startsWith('<script src="/__tapp/boot.js">'), true);
});

test("android runtime: installs the host when missing, hands the package over as the host, then starts it", async () => {
  const out = join(await tmp(), "a.tapp");
  await pack(await project(), { out });
  const pkg = await verifyTapp(out);
  const hostApk = join(await tmp(), "host.apk");
  await writeFile(hostApk, Buffer.alloc(2048, 1));
  const state = { hostVersion: "" };
  const handler = (cmd) => {
    if (cmd.startsWith("dumpsys package dev.tethertrace.host")) return state.hostVersion ? `    versionName=${state.hostVersion}\n` : "";
    if (cmd.startsWith("am force-stop")) return "";
    if (cmd.startsWith("am start -W -n dev.tethertrace.host/.MainActivity")) return "Status: ok\nTotalTime: 321\n";
    return undefined;
  };
  const key = AdbKey.generate("test@host");
  const dev = await startAdbd({ mode: "tls", trusted: [key.publicKeyString], handler });
  try {
    const d = await Device.connect({ host: "127.0.0.1", port: dev.port, key });
    const r = await runOnAndroid(d, pkg, { hostApk });
    assert.deepEqual(r, { package: "dev.tethertrace.host", hostInstalled: true, launchTimeMs: 321 });
    const opens = dev.log.filter((l) => l.open).map((l) => l.open);
    const size = (await readFile(out)).length;
    assert.ok(opens.some((o) => o === "exec:cmd package install -r -S 2048"), "the runtime was installed");
    assert.ok(opens.some((o) => o === `exec:run-as dev.tethertrace.host sh -c 'mkdir -p files/incoming && head -c ${size} > files/incoming/com.example.notes.tapp && echo TAPP_SENT'`), opens.join("\n"));
    assert.ok(opens.some((o) => o.includes("am start -W -n dev.tethertrace.host/.MainActivity --activity-clear-task --es tapp incoming/com.example.notes.tapp")));

    // Already installed at this version: not installed again.
    state.hostVersion = ANDROID_HOST_VERSION;
    dev.log.length = 0;
    assert.equal((await runOnAndroid(d, pkg, { hostApk })).hostInstalled, false);
    assert.ok(!dev.log.some((l) => l.open?.startsWith("exec:cmd package install")));
    await assert.rejects(d.pushAs("dev.tethertrace.host", "../outside", Buffer.from("x")), /Unsafe path/);
    d.close();
  } finally {
    await dev.close();
  }
});

test("CLI: asking for something that cannot work gets an explanation and a failing exit code, never a false success", async () => {
  const out = join(await tmp(), "c.tapp");
  await pack(await project(), { out });

  const apkIos = await cli("run", "example.apk", "--platform", "ios");
  assert.equal(apkIos.code, 2);
  assert.match(apkIos.stdout, /cannot be run on iOS/);
  assert.match(apkIos.stdout, /tethertrace compatibility example\.apk --target ios/);

  const conv = await cli("convert", "example.apk", "--to", "ios");
  assert.equal(conv.code, 2);
  assert.match(conv.stdout, /cannot be run on iOS/);

  const tappIos = await cli("run", out, "--platform", "ios");
  assert.equal(tappIos.code, 2);
  assert.match(tappIos.stdout, /is a valid package, but:\nRunning on iOS is not implemented, and nothing here has been tested on an iPhone/);

  const toIos = await cli("convert", out, "--to", "ios");
  assert.equal(toIos.code, 2);

  const verify = await cli("tapp", "verify", out);
  assert.equal(verify.code, 0);
  assert.match(verify.stdout, /Integrity: every file matches the manifest/);

  // A YAML flow still goes to the flow runner, and --platform is refused for it.
  const flow = await cli("run", "flows/none.yaml", "--platform", "android");
  assert.equal(flow.code, 1);
  assert.match(flow.stderr, /--platform is for \.tapp packages/);
});
