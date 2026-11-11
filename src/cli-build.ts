import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { discover, SERVICE_CONNECT } from "./adb/mdns.js";
import { build, pickArtifact, type BuildResult } from "./build.js";
import type { Device } from "./device.js";
import { explore } from "./explore.js";
import { describeProject, detectProjects } from "./project/detect.js";
import { cleanManaged, findJdks, findSdk, listManaged, resolveAndroidToolchain, toolchainsDir, type Consent } from "./toolchain/android.js";

/** Commands that find, build and check projects: doctor, devices, build, toolchain. */

export interface CliHelpers {
  withDevice<T>(target: string | undefined, fn: (d: Device) => Promise<T>): Promise<T>;
  stamp(): string;
  deviceOpt(): import("commander").Option;
}

/** Ask on the terminal; with --yes say yes; with no terminal and no --yes, say no (and explain). */
export function terminalConsent(yes: boolean | undefined): Consent {
  return async (q) => {
    const line = `${q.what}: ${q.detail}${q.downloadMb ? ` (${q.downloadMb} MB download)` : ""}${q.license ? `. License: ${q.license}` : ""}`;
    if (yes) {
      console.error(`Approved by --yes: ${line}`);
      return true;
    }
    if (!process.stdin.isTTY) {
      console.error(`Needs your approval, but this is not an interactive terminal: ${line}\nRe-run with --yes to approve.`);
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(es)?$/i.test((await rl.question(`${line}\nAllow? [y/N] `)).trim());
    } finally {
      rl.close();
    }
  };
}

export function printBuildResult(r: BuildResult) {
  if (r.ok) {
    console.log(`\n✔ Built ${r.project?.name} (${r.variant}) in ${(r.durationMs / 1000).toFixed(0)} s`);
    for (const a of r.artifacts) console.log(`  ${a.path}\n    ${a.packageName ?? "?"} ${a.versionName ?? ""}  ${a.sizeBytes < 1e6 ? `${Math.max(1, Math.round(a.sizeBytes / 1e3))} KB` : `${(a.sizeBytes / 1e6).toFixed(1)} MB`}  signed: ${a.signature.v2plus ? "v2+" : a.signature.v1 ? "v1" : "no"}`);
  } else {
    console.log(`\n✖ ${r.error!.category}: ${r.error!.message}`);
    for (const l of r.error!.excerpt) console.log(`  ${l}`);
    for (const h of r.error!.hints) console.log(`→ ${h}`);
  }
  for (const n of r.notes ?? []) console.log(`note: ${n}`);
  if (r.logFile) console.log(`Build log: ${r.logFile}`);
}

export function registerBuildCommands(program: Command, h: CliHelpers) {
  program
    .command("doctor")
    .description("Check this computer and project: what can be built here, which tools are present, what is missing")
    .argument("[dir]", "project folder", ".")
    .option("--json", "machine-readable output")
    .action(async (dir: string, o: { json?: boolean }) => {
      const projects = await detectProjects(resolve(dir));
      const jdks = await findJdks();
      const report: Record<string, unknown> = { node: process.version, platform: `${process.platform}/${process.arch}`, managedToolchains: toolchainsDir(), jdks, projects: [] as unknown[] };
      const lines: string[] = [`Node ${process.version} on ${process.platform}/${process.arch}`];
      lines.push(jdks.length ? `JDKs: ${jdks.map((j) => `${j.version} (${j.source})`).join(", ")}` : "JDKs: none found");
      const sdk = await findSdk(undefined);
      lines.push(sdk ? `Android SDK: ${sdk.root} (${sdk.source}); platforms ${sdk.platforms.join(", ") || "none"}; licenses ${sdk.licensesAccepted ? "accepted" : "not accepted"}` : "Android SDK: none set for this computer (a project can still point at its own in local.properties)");
      report.androidSdk = sdk;
      let problems = 0;
      if (!projects.length) lines.push(`\nNo app project found in ${resolve(dir)}.`);
      for (const p of projects) {
        lines.push("", describeProject(p));
        const entry: Record<string, unknown> = { ...p };
        if (p.android && p.build.supported === "local") {
          const tc = await resolveAndroidToolchain(p.android);
          entry.toolchain = { jdk: tc.jdk, sdk: tc.sdk, missing: tc.missing };
          if (tc.jdk) lines.push(`  will use JDK ${tc.jdk.version} from ${tc.jdk.home}`);
          if (tc.sdk) lines.push(`  will use Android SDK ${tc.sdk.root}`);
          for (const m of tc.missing) {
            problems++;
            lines.push(`  missing: ${m.detail}${m.downloadMb ? ` (about ${m.downloadMb} MB)` : ""}`);
          }
          lines.push(tc.missing.length ? "  → `tethertrace build --yes` downloads what is missing into tethertrace's own folder." : "  ready: `tethertrace build`");
        } else if (p.build.supported !== "local" && p.kind !== "apk" && p.kind !== "ipa") problems++;
        (report.projects as unknown[]).push(entry);
      }
      const phones = (await discover({ services: [SERVICE_CONNECT], timeoutMs: 2000 }).catch(() => [])).filter((s) => s.service === SERVICE_CONNECT);
      report.androidDevices = phones.map((f) => `${f.host}:${f.port}`);
      lines.push("", phones.length ? `Android phones on this Wi-Fi: ${phones.map((f) => `${f.host}:${f.port}`).join(", ")}` : "Android phones on this Wi-Fi: none (turn on Wireless debugging to test on one)");
      lines.push("iPhones: not supported yet");
      console.log(o.json ? JSON.stringify(report, null, 2) : lines.join("\n"));
      if (problems) process.exitCode = 1;
    });

  program
    .command("devices")
    .description("List the phones tethertrace can reach, with what each one supports")
    .option("--json", "machine-readable output")
    .option("--timeout <ms>", "how long to listen", "3000")
    .action(async (o: { json?: boolean; timeout: string }) => {
      const found = (await discover({ services: [SERVICE_CONNECT], timeoutMs: Number(o.timeout) })).filter((s) => s.service === SERVICE_CONNECT);
      const out: Record<string, unknown>[] = [];
      for (const f of found) {
        const id = `${f.host}:${f.port}`;
        try {
          const info = await h.withDevice(id, (d) => d.info());
          out.push({ id, platform: "android", transport: "wifi", paired: true, ...info, capabilities: ["install", "launch", "screenshot", "ui-tree", "tap", "type", "logs", "record"] });
        } catch (e) {
          out.push({ id, platform: "android", transport: "wifi", paired: false, error: (e as Error).message, capabilities: [] });
        }
      }
      if (o.json) return console.log(JSON.stringify(out, null, 2));
      if (!out.length) {
        console.log("No Android phone found. Turn on Wireless debugging (same Wi-Fi, not a guest network).\niPhones are not supported yet.");
        process.exitCode = 1;
        return;
      }
      for (const d of out) console.log(d.paired ? `${d.id}  android  ${d.manufacturer} ${d.model}  Android ${d.androidVersion}  ${d.abi}` : `${d.id}  android  not paired (run \`tethertrace pair <code>\`)`);
    });

  program
    .command("build")
    .description("Build the app in this folder with its own build system, finding (or fetching) the JDK and Android SDK it needs")
    .argument("[dir]", "project folder", ".")
    .option("--platform <name>", "android or ios, when a project has both")
    .option("--module <path>", "Gradle app module, e.g. :app, when there are several")
    .option("--variant <name>", "build variant: debug, release, or flavorDebug", "debug")
    .option("-y, --yes", "approve downloading missing tools and accepting the Android SDK licenses")
    .option("--offline", "do not use the network for dependencies")
    .option("--timeout <minutes>", "stop the build after this long", "30")
    .option("--install", "install the built app on the phone")
    .option("--test", "install it and explore it for crashes (same as `tethertrace test <apk>`)")
    .option("--json", "print the build result as JSON")
    .addOption(h.deviceOpt())
    .addHelpText("after", "\nExamples:\n  tethertrace build                 # debug APK of the app in this folder\n  tethertrace build --yes           # also fetch a missing JDK / Android SDK (asks nothing)\n  tethertrace build --test          # build, install on the phone, explore for crashes\n\nNothing is downloaded without your approval, and nothing is installed outside ~/.tethertrace.")
    .action(async (dir: string, o: { platform?: string; module?: string; variant: string; yes?: boolean; offline?: boolean; timeout: string; install?: boolean; test?: boolean; json?: boolean; device?: string }) => {
      if (o.platform && o.platform !== "android" && o.platform !== "ios") throw new Error("--platform must be android or ios");
      const ac = new AbortController();
      process.once("SIGINT", () => {
        console.error("\nStopping the build…");
        ac.abort();
      });
      const r = await build({
        dir,
        platform: o.platform as "android" | "ios" | undefined,
        module: o.module,
        variant: o.variant,
        install: true, // every download still goes through consent below
        consent: terminalConsent(o.yes),
        offline: o.offline,
        timeoutMs: Number(o.timeout) * 60_000,
        signal: ac.signal,
        log: (m) => console.error(m),
      });
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else printBuildResult(r);
      if (!r.ok) {
        process.exitCode = 2;
        return;
      }
      if (!o.install && !o.test) return;
      await h.withDevice(o.device, async (d) => {
        const info = await d.info();
        const apk = pickArtifact(r.artifacts, info.abi);
        if (!apk?.packageName) throw new Error("The build produced no installable APK for this phone");
        console.error(`Installing ${apk.path} on ${info.manufacturer} ${info.model}…`);
        await d.install(apk.path);
        console.log(`Installed ${apk.packageName}`);
        if (!o.test) return;
        const outDir = `reports/test-${apk.packageName}-${h.stamp()}`;
        console.error(`Exploring ${apk.packageName}…`);
        const s = await explore(d, { pkg: apk.packageName, outDir, log: (m) => console.error(m) });
        console.log(`\n${s.verdict === "no_crash_observed" ? "✔" : "✖"} ${s.verdict}: ${s.reason}`);
        console.log(`Coverage: ${s.coverage.level} (${s.coverage.tapped} controls tapped)`);
        for (const w of s.coverage.warnings) console.log(`  ! ${w}`);
        console.log(`Report: ${outDir}/report.html`);
        if (s.verdict !== "no_crash_observed") process.exitCode = 2;
      });
    });

  const toolchain = program.command("toolchain").description("See or remove the build tools tethertrace downloaded");
  toolchain
    .command("list")
    .description("What tethertrace downloaded, and how much space it takes")
    .action(async () => {
      const items = await listManaged();
      if (!items.length) return console.log(`Nothing downloaded yet (${toolchainsDir()}).`);
      for (const i of items) console.log(`${i.name}\t${(i.bytes / 1e6).toFixed(0)} MB\t${i.path}`);
    });
  toolchain
    .command("clean")
    .description("Delete downloaded toolchains (all of them, or the ones you name)")
    .argument("[names...]", "names from `toolchain list`")
    .action(async (names: string[]) => {
      const gone = await cleanManaged(names);
      console.log(gone.length ? `Removed ${gone.map((g) => g.name).join(", ")} (${(gone.reduce((n, g) => n + g.bytes, 0) / 1e6).toFixed(0)} MB)` : "Nothing to remove.");
    });
}
