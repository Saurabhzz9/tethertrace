import type { Command } from "commander";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { analyzeApk, checkCompatibility, describeAnalysis, describeCompatibility, listZipEntries, readZipEntryData } from "./analyze.js";
import { terminalConsent, type CliHelpers } from "./cli-build.js";
import { convertToApk, IOS_NOT_IMPLEMENTED, runOnAndroid, startDesktopRuntime } from "./runtime.js";
import { describeTapp, generateSigningKey, pack, verifyTapp } from "./tapp.js";

/** Experimental commands: analyze, compatibility, pack, tapp, convert, and running a .tapp. */

const APK_ON_IOS = (file: string) =>
  [
    `${file} cannot be run on iOS, and tethertrace does not pretend to.`,
    "An APK is DEX code for the Android runtime, Android resources, and often native Android libraries. iOS has no Android runtime, loads only signed Mach-O code, and has none of the Android system services the app talks to.",
    `See what could be carried over and why the rest cannot:  tethertrace compatibility ${file} --target ios`,
    "Background: docs/universal-runtime/apk-on-ios.md",
  ].join("\n");

/** Run a .tapp, or explain why a file cannot run on a platform. Returns false when `file` is not ours to handle. */
export async function runUniversal(file: string, o: { platform?: string; device?: string; port?: string; yes?: boolean }, h: CliHelpers): Promise<boolean> {
  const isApk = /\.apk$/i.test(file);
  const isTapp = /\.tapp$/i.test(file);
  if (!isApk && !isTapp) {
    if (o.platform) throw new Error("--platform is for .tapp packages. A YAML flow runs on the phone it names.");
    return false;
  }
  const platform = o.platform ?? (isTapp ? "android" : undefined);
  if (isApk) {
    if (platform === "ios") {
      console.log(APK_ON_IOS(file));
      process.exitCode = 2;
      return true;
    }
    throw new Error(`To run an APK on your phone use: tethertrace test ${file}  (or: tethertrace smoke --apk ${file})`);
  }
  const pkg = await verifyTapp(file);
  if (platform === "ios") {
    console.log(`${pkg.manifest.name} ${pkg.manifest.version} is a valid package, but:\n${IOS_NOT_IMPLEMENTED}`);
    process.exitCode = 2;
    return true;
  }
  if (platform === "desktop") {
    const rt = await startDesktopRuntime(pkg, { port: o.port ? Number(o.port) : undefined });
    console.log(`${pkg.manifest.name} ${pkg.manifest.version} is running at ${rt.url}\nThis is a preview in your browser with the same content rules as the phone runtime. Press Ctrl+C to stop.`);
    await new Promise<void>((r) => process.once("SIGINT", () => r()));
    await rt.close();
    return true;
  }
  if (platform !== "android") throw new Error(`Unknown platform "${platform}". Use android, desktop or ios.`);
  await h.withDevice(o.device, async (d) => {
    const r = await runOnAndroid(d, pkg, { install: true, consent: terminalConsent(o.yes), log: (m) => console.error(m) });
    console.log(`✔ ${pkg.manifest.name} ${pkg.manifest.version} is running on the phone inside the tapp runtime${r.launchTimeMs !== undefined ? ` (started in ${r.launchTimeMs} ms)` : ""}.`);
    console.log(`Test it like any app:  tethertrace ui   ·   tethertrace test ${r.package} --no-install`);
  });
  return true;
}

export function registerUniversalCommands(program: Command, h: CliHelpers) {
  program
    .command("analyze")
    .description("Experimental: look inside an APK without running it: framework, code, native libraries, web layer, what it depends on")
    .argument("<apk>")
    .option("--json", "machine-readable output")
    .action(async (apk: string, o: { json?: boolean }) => {
      const a = await analyzeApk(apk);
      console.log(o.json ? JSON.stringify(a, null, 2) : describeAnalysis(a));
    });

  program
    .command("compatibility")
    .description("Experimental: say which parts of an APK could be carried to another platform, which cannot, and why. A static report, never a claim that it runs")
    .argument("<apk>")
    .requiredOption("--target <platform>", "ios")
    .option("--json", "machine-readable output")
    .action(async (apk: string, o: { target: string; json?: boolean }) => {
      if (o.target !== "ios") throw new Error(`Only --target ios is analysed. An APK already runs on Android.`);
      const a = await analyzeApk(apk);
      const r = checkCompatibility(a, "ios");
      console.log(o.json ? JSON.stringify({ analysis: a, compatibility: r }, null, 2) : `${describeAnalysis(a)}\n\n${describeCompatibility(r)}`);
    });

  program
    .command("pack")
    .description("Experimental: pack a built web app (HTML, JS, CSS, WebAssembly) into a .tapp package with a checksum for every file")
    .argument("[dir]", "project folder", ".")
    .option("-o, --out <file>", "where to write the package")
    .option("--key <pem>", "sign the package with this Ed25519 private key (make one with `tethertrace tapp keygen`)")
    .option("--json", "machine-readable output")
    .addHelpText("after", '\nSettings come from tapp.config.json in the project, all optional:\n  { "id": "com.example.notes", "name": "Notes", "version": "1.0.0", "dir": "dist",\n    "permissions": ["storage"], "network": ["https://api.example.com"] }\n\nIt packs what is already built. It does not run your build or any package script.')
    .action(async (dir: string, o: { out?: string; key?: string; json?: boolean }) => {
      const r = await pack(dir, { out: o.out, keyFile: o.key });
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`✔ Packed ${r.manifest.name} ${r.manifest.version} (${r.manifest.id})`);
      console.log(`  ${r.file}\n  ${Object.keys(r.manifest.files).length} files, ${(r.sizeBytes / 1024).toFixed(1)} KB, sha256 ${r.sha256.slice(0, 16)}…${r.signedBy ? `\n  signed with key ${r.signedBy}` : "\n  not signed"}`);
      for (const n of r.notes) console.log(`note: ${n}`);
      console.log(`Run it:  tethertrace run ${r.file} --platform desktop   (or android)`);
    });

  const tapp = program.command("tapp").description("Experimental: inspect and verify .tapp packages");
  tapp
    .command("verify")
    .description("Check a package: manifest, every file's SHA-256, nothing unlisted inside, and its signature")
    .argument("<file.tapp>")
    .option("--json", "machine-readable output")
    .action(async (file: string, o: { json?: boolean }) => {
      const v = await verifyTapp(file);
      console.log(o.json ? JSON.stringify({ ok: true, manifest: v.manifest, signedBy: v.signedBy ?? null }, null, 2) : `✔ ${describeTapp(v)}`);
    });
  tapp
    .command("keygen")
    .description("Make an Ed25519 key for signing packages")
    .argument("[file]", "where to write the private key", "tapp-signing-key.pem")
    .action(async (file: string) => {
      const k = generateSigningKey();
      await writeFile(file, k.privateKeyPem, { flag: "wx", mode: 0o600 });
      console.log(`Wrote ${file} (keep it private and out of git). Key fingerprint: ${k.fingerprint}`);
    });

  program
    .command("convert")
    .description("Experimental: turn a .tapp into a standalone Android app, or pull the web layer out of a Cordova/Capacitor APK. Explains what cannot be converted")
    .argument("<file>", "a .tapp package or an .apk")
    .requiredOption("--to <target>", "apk | tapp | ios")
    .option("-o, --out <file>", "output file")
    .option("-y, --yes", "approve downloading a missing JDK or SDK platform for the build")
    .action(async (file: string, o: { to: string; out?: string; yes?: boolean }) => {
      const isApk = /\.apk$/i.test(file);
      if (isApk && o.to === "ios") {
        console.log(APK_ON_IOS(file));
        process.exitCode = 2;
        return;
      }
      if (isApk && o.to === "tapp") {
        const a = await analyzeApk(file);
        const c = checkCompatibility(a, "ios");
        if (c.route !== "repackage_web_layer" || !a.webLayer) {
          console.log(`${file} has no self-contained web layer to pack (built with: ${a.framework.kind}).\n${c.routeSummary}`);
          process.exitCode = 2;
          return;
        }
        const work = await mkdtemp(join(tmpdir(), "tapp-web-"));
        try {
          const prefix = `${a.webLayer.root}/`;
          for (const e of (await listZipEntries(file)).filter((x) => x.name.startsWith(prefix) && !x.name.endsWith("/"))) {
            const dest = resolve(work, e.name.slice(prefix.length));
            if (!dest.startsWith(resolve(work))) continue; // a name that tries to leave the folder
            await mkdir(dirname(dest), { recursive: true });
            await writeFile(dest, await readZipEntryData(file, e));
          }
          await writeFile(join(work, "tapp.config.json"), JSON.stringify({ id: a.packageName, name: a.packageName?.split(".").pop(), version: /^\d+\.\d+\.\d+/.exec(a.versionName ?? "")?.[0] ?? "0.1.0" }));
          const r = await pack(work, { out: o.out ?? `${a.packageName ?? "app"}.tapp` });
          console.log(`✔ Packed the web layer of ${a.packageName} into ${r.file} (${Object.keys(r.manifest.files).length} files).`);
          console.log("This is the app's web content only. It is not the Android app: calls it makes to native plugins have nothing to answer them, so screens that depend on them will not work.");
        } finally {
          await rm(work, { recursive: true, force: true });
        }
        return;
      }
      if (isApk) throw new Error(`An APK can be converted --to tapp (web layer only) or checked --to ios. Got --to ${o.to}.`);
      const pkg = await verifyTapp(file);
      if (o.to === "ios") {
        console.log(`${pkg.manifest.name} ${pkg.manifest.version} is a valid package, but:\n${IOS_NOT_IMPLEMENTED}`);
        process.exitCode = 2;
        return;
      }
      if (o.to !== "apk") throw new Error(`A .tapp can be converted --to apk. Got --to ${o.to}.`);
      const out = resolve(o.out ?? `${pkg.manifest.id}-${pkg.manifest.version}.apk`);
      const r = await convertToApk(pkg, out, { install: true, consent: terminalConsent(o.yes), log: (m) => console.error(m) });
      console.log(`✔ ${r.file}\n  A standalone debug build of ${pkg.manifest.name} (${r.applicationId}): the tapp runtime with the package inside.\n  Install and test it:  tethertrace test ${r.file}`);
    });
}
