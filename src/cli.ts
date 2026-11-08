#!/usr/bin/env node
import { Command, Option } from "commander";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { AdbError } from "./adb/connection.js";
import { homeDir, loadOrCreateKey } from "./adb/keys.js";
import { discover, SERVICE_CONNECT, SERVICE_PAIRING } from "./adb/mdns.js";
import { pair, PairingError } from "./adb/pairing.js";
import { readApkInfo } from "./apk.js";
import { Device, SelectorError, type Selector } from "./device.js";
import { explainLocally, explainWithModel, loadReport } from "./explain.js";
import { explore } from "./explore.js";
import { startMcpServer } from "./mcp.js";
import { loadFlow, runFlow } from "./runner.js";
import { formatNodes, smoke } from "./smoke.js";
import { Recording, attachRecording, recordWhile } from "./record.js";
import { VERSION } from "./version.js";

const program = new Command()
  .name("tethertrace")
  .description("Test any Android app on a real phone over Wi-Fi — no adb, no Android SDK. Works with Claude, Codex and local models via MCP.")
  .version(VERSION)
  .showHelpAfterError();

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function parseTarget(t: string) {
  const m = /^(.+):(\d{1,5})$/.exec(t);
  if (!m) throw new Error(`Expected host:port, got "${t}"`);
  return { host: m[1]!.replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

async function resolveConnectTarget(target?: string) {
  if (target ??= process.env.TETHERTRACE_DEVICE) return parseTarget(target);
  const found = (await discover({ services: [SERVICE_CONNECT] })).filter((s) => s.service === SERVICE_CONNECT);
  if (found.length === 1) return found[0]!;
  if (!found.length) throw new Error("No phone found on this network. Turn on Wireless debugging (same Wi-Fi, not a guest network) or pass --device host:port.");
  throw new Error(`Several phones found; pick one with --device:\n${found.map((f) => `  ${f.host}:${f.port}  (${f.name})`).join("\n")}`);
}

async function withDevice<T>(target: string | undefined, fn: (d: Device) => Promise<T>) {
  const key = await loadOrCreateKey();
  const { host, port } = await resolveConnectTarget(target);
  const d = await Device.connect({ host, port, key, onAuthPrompt: () => console.error("Check your phone and tap Allow to trust this computer…") });
  try {
    return await fn(d);
  } finally {
    d.close();
  }
}

const maybeRecord = <T>(d: Device, on: boolean | undefined, outDir: string, fn: () => Promise<T>) => recordWhile(d, on, outDir, fn, (m) => console.error(m));

const recordOpt = () => new Option("--record", "record the phone screen into the report");

const deviceOpt = () => new Option("-d, --device <host:port>", "phone's Wireless debugging address (default: auto-discover, or $TETHERTRACE_DEVICE)");

/** Build a selector from a positional label and/or --id/--desc/--contains/--index. */
function selectorFrom(label: string | undefined, o: { id?: string; desc?: string; contains?: string; index?: string }): Selector {
  const sel: Record<string, unknown> = {};
  if (o.id) sel.id = o.id;
  if (o.desc) sel.desc = o.desc;
  if (o.contains) sel.contains = o.contains;
  if (o.index !== undefined) sel.index = Number(o.index);
  const hasMatcher = Boolean(o.id || o.desc || o.contains);
  if (label && !hasMatcher) return o.index !== undefined ? { text: label, index: Number(o.index) } : label;
  if (label) sel.text = label;
  if (!hasMatcher && !label) throw new Error("Give a label, or --id / --desc / --contains");
  return sel as Selector;
}

// ---------------------------------------------------------------- connection

program
  .command("discover")
  .description("Find phones with Wireless debugging on this network (mDNS)")
  .option("--timeout <ms>", "how long to listen", "3000")
  .action(async (o: { timeout: string }) => {
    const found = await discover({ timeoutMs: Number(o.timeout) });
    if (!found.length) {
      console.log("Nothing found. Is Wireless debugging on, and is the phone on the same Wi-Fi (not a guest network)?");
      process.exitCode = 1;
      return;
    }
    for (const s of found) console.log(`${s.service === SERVICE_PAIRING ? "pairing" : "connect"}\t${s.host}:${s.port}\t${s.name}`);
  });

program
  .command("pair")
  .description("Pair once using the 6-digit code from Wireless debugging → Pair device with pairing code")
  .argument("[host:port]", "pairing address shown next to the code (auto-discovered if omitted)")
  .argument("[code]", "6-digit code (or $TETHERTRACE_PAIR_CODE; prompted if missing)")
  .addHelpText("after", "\nExamples:\n  tethertrace pair 123456\n  tethertrace pair 192.168.1.20:37099 123456")
  .action(async (target: string | undefined, code: string | undefined) => {
    if (target && !code && /^\d{6}$/.test(target)) [target, code] = [undefined, target];
    const key = await loadOrCreateKey();
    let addr = target ? parseTarget(target) : undefined;
    if (!addr) {
      const found = (await discover({ services: [SERVICE_PAIRING] })).filter((s) => s.service === SERVICE_PAIRING);
      if (found.length !== 1) throw new Error(found.length ? "Several pairing dialogs found; pass host:port." : "No pairing dialog found. Open 'Pair device with pairing code' on the phone, or pass host:port.");
      addr = found[0]!;
    }
    code ??= process.env.TETHERTRACE_PAIR_CODE;
    if (!code) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      code = (await rl.question("Pairing code: ")).trim();
      rl.close();
    }
    if (!/^\d{6}$/.test(code)) throw new Error("The pairing code is 6 digits");
    const r = await pair({ host: addr.host, port: addr.port, code, key });
    console.log(`Paired with ${r.deviceGuid}. This computer's key is in ${homeDir()}.`);
    console.log("Next: tethertrace info");
  });

program
  .command("info")
  .description("Connect and print device information")
  .addOption(deviceOpt())
  .option("--json", "machine-readable output")
  .action(async (o: { device?: string; json?: boolean }) => {
    await withDevice(o.device, async (d) => {
      const info = await d.info();
      if (o.json) console.log(JSON.stringify(info, null, 2));
      else console.log(`${info.manufacturer} ${info.model} · Android ${info.androidVersion} (SDK ${info.sdk}) · ${info.abi} · ${info.tls ? "TLS" : "plain"}`);
    });
  });

// ---------------------------------------------------------------- apps

program
  .command("apps")
  .description("List installed apps (third-party by default)")
  .addOption(deviceOpt())
  .option("--system", "include system apps")
  .option("--filter <text>", "only packages containing this text")
  .action(async (o: { device?: string; system?: boolean; filter?: string }) => {
    await withDevice(o.device, async (d) => console.log((await d.listPackages({ system: o.system, filter: o.filter })).join("\n")));
  });

program
  .command("apk-info")
  .description("Read package name, version and SDK levels from an APK (no Android SDK needed)")
  .argument("<apk>")
  .action(async (apk: string) => console.log(JSON.stringify(await readApkInfo(apk), null, 2)));

program
  .command("install")
  .description("Install or update an APK over Wi-Fi")
  .argument("<apk>")
  .addOption(deviceOpt())
  .action(async (apk: string, o: { device?: string }) => {
    const info = await readApkInfo(apk);
    await withDevice(o.device, async (d) => {
      await d.install(apk);
      console.log(`Installed ${info.packageName} ${info.versionName ?? ""}`.trim());
    });
  });

program
  .command("launch")
  .description("Cold-start an app and print Android's launch time")
  .argument("<package>")
  .addOption(deviceOpt())
  .action(async (pkg: string, o: { device?: string }) => {
    await withDevice(o.device, async (d) => {
      await d.forceStop(pkg);
      const r = await d.launch(pkg);
      console.log(`Launched ${r.activity}${r.totalTimeMs !== undefined ? ` in ${r.totalTimeMs} ms` : ""}`);
    });
  });

program
  .command("stop")
  .description("Force-stop an app")
  .argument("<package>")
  .addOption(deviceOpt())
  .action(async (pkg: string, o: { device?: string }) => withDevice(o.device, (d) => d.forceStop(pkg)));

// ---------------------------------------------------------------- look

program
  .command("screenshot")
  .description("Save the phone screen as PNG")
  .addOption(deviceOpt())
  .option("-o, --out <file>", "output file", "screenshot.png")
  .option("--scale <n>", "downscale factor 0.1–1", "1")
  .action(async (o: { device?: string; out: string; scale: string }) => {
    await withDevice(o.device, async (d) => {
      await writeFile(o.out, await d.screenshotScaled(Number(o.scale)));
      console.log(`Saved ${o.out} (may contain personal information)`);
    });
  });

program
  .command("ui")
  .description("List what's on screen: text, buttons ([tap]), ids and bounds")
  .addOption(deviceOpt())
  .action(async (o: { device?: string }) => withDevice(o.device, async (d) => console.log(formatNodes(await d.uiNodes()))));

program
  .command("logs")
  .description("Recent logcat for one app's process")
  .argument("<package>")
  .addOption(deviceOpt())
  .option("-n, --lines <n>", "how many lines", "300")
  .action(async (pkg: string, o: { device?: string; lines: string }) => {
    await withDevice(o.device, async (d) => {
      const pid = await d.pidOf(pkg);
      if (!pid) console.error(`${pkg} is not running; showing lines that mention it`);
      const log = await d.logcat({ pid, lines: Number(o.lines) });
      console.log(pid ? log : log.split("\n").filter((l) => l.includes(pkg)).join("\n"));
    });
  });

program
  .command("shell")
  .description("Run a shell command on the phone")
  .argument("<command...>")
  .addOption(deviceOpt())
  .action(async (command: string[], o: { device?: string }) => {
    await withDevice(o.device, async (d) => {
      const r = await d.shell(command.join(" "));
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      process.exitCode = r.exitCode ?? 0;
    });
  });

// ---------------------------------------------------------------- act

const withSelectorOptions = (c: Command) =>
  c
    .option("--id <id>", "match resource id")
    .option("--desc <text>", "match content description")
    .option("--contains <text>", "match part of the text (case-insensitive)")
    .option("--index <n>", "pick the n-th match (0-based) when several match")
    .addOption(deviceOpt());

withSelectorOptions(program.command("tap").description("Tap an element by its visible text (waits for it to appear)").argument("[label]"))
  .option("--timeout <ms>", "how long to wait for the element", "10000")
  .action(async (label: string | undefined, o: { id?: string; desc?: string; contains?: string; index?: string; device?: string; timeout: string }) => {
    await withDevice(o.device, async (d) => {
      const r = await d.tap(selectorFrom(label, o), Number(o.timeout));
      console.log(`Tapped ${r.node.text || r.node.desc || r.node.id || "element"} at ${Math.round(r.x)},${Math.round(r.y)}`);
    });
  });

program
  .command("type")
  .description("Type ASCII text into the focused field")
  .argument("<text>")
  .addOption(deviceOpt())
  .action(async (t: string, o: { device?: string }) => withDevice(o.device, (d) => d.type(t)));

program
  .command("key")
  .description("Press a key: back, home, enter, tab, delete, menu, recents")
  .argument("<name>")
  .addOption(deviceOpt())
  .action(async (name: string, o: { device?: string }) => withDevice(o.device, (d) => d.key(name)));

program
  .command("scroll")
  .description("Scroll: up, down, left or right")
  .argument("<direction>")
  .addOption(deviceOpt())
  .action(async (dir: string, o: { device?: string }) => {
    if (!["up", "down", "left", "right"].includes(dir)) throw new Error("direction must be up, down, left or right");
    await withDevice(o.device, (d) => d.scroll(dir as "up"));
  });

// ---------------------------------------------------------------- test

program
  .command("smoke")
  .description("Cold-start any app (installing an APK first if given), watch it, save evidence + an honest verdict")
  .option("-p, --package <name>", "application id (read from --apk if omitted)")
  .option("--apk <file>", "install this APK first")
  .option("--wait <seconds>", "how long to watch the app after launch", "8")
  .option("--out <dir>", "evidence folder (default reports/smoke-<package>-<time>)")
  .option("--no-screenshot", "do not capture the screen")
  .addOption(recordOpt())
  .addOption(deviceOpt())
  .action(async (o: { package?: string; apk?: string; wait: string; out?: string; screenshot: boolean; device?: string; record?: boolean }) => {
    const pkg = o.package ?? (o.apk ? (await readApkInfo(o.apk)).packageName : undefined);
    if (!pkg) throw new Error("Give --package or --apk");
    const outDir = o.out ?? `reports/smoke-${pkg}-${stamp()}`;
    await withDevice(o.device, async (d) => {
      const s = await maybeRecord(d, o.record, outDir, () => smoke(d, { pkg, apk: o.apk, waitMs: Number(o.wait) * 1000, outDir, screenshot: o.screenshot, log: (m) => console.error(m) }));
      console.log(`\n${s.verdict}: ${s.reason}`);
      if (s.launch?.totalTimeMs !== undefined) console.log(`Cold start: ${s.launch.totalTimeMs} ms`);
      if (s.memoryPssKb) console.log(`Memory: ${(s.memoryPssKb / 1024).toFixed(1)} MB`);
      for (const e of s.evidence.slice(0, 5)) console.log(`  ${e}`);
      console.log(`Report: ${outDir}/report.html`);
      if (s.verdict !== "no_crash_observed") process.exitCode = 2;
    });
  });

program
  .command("run")
  .description("Run a YAML flow on the phone and save a report with evidence")
  .argument("<flow.yaml>")
  .addOption(deviceOpt())
  .option("--out <dir>", "report folder (default reports/<flow>-<time>)")
  .addOption(recordOpt())
  .action(async (file: string, o: { device?: string; out?: string; record?: boolean }) => {
    const flow = await loadFlow(file);
    const outDir = o.out ?? `reports/${flow.name}-${stamp()}`;
    await withDevice(o.device, async (d) => {
      const s = await maybeRecord(d, o.record, outDir, () => runFlow(d, flow, { outDir, log: (m) => console.error(m) }));
      if (s.status === "passed") console.log(`\n✔ ${flow.name} passed (${s.steps.length} steps)${s.launchTimeMs !== undefined ? `, cold start ${s.launchTimeMs} ms` : ""}`);
      else {
        console.log(`\n✖ ${flow.name} failed at step ${s.failure!.step}: ${s.failure!.category}`);
        console.log(`  ${s.failure!.message}`);
        for (const e of s.failure!.evidence.slice(0, 5)) console.log(`  ${e}`);
        if (s.failure!.visibleOnScreen?.length) console.log(`  On screen instead: ${s.failure!.visibleOnScreen.slice(0, 8).join(" | ")}`);
        process.exitCode = 2;
      }
      console.log(`Report: ${outDir}/report.html`);
    });
  });

program
  .command("explain")
  .description("Explain a report folder; add --model to have Claude, OpenAI, Ollama or LM Studio read the evidence too")
  .argument("<report-dir>")
  .option("-m, --model <provider[:model]>", "anthropic[:model] | openai:<model> | ollama:<model> | lmstudio:<model> | openai-compatible:<model>")
  .option("--base-url <url>", "override the API base URL (OpenAI-compatible providers)")
  .option("--api-key <key>", "API key (default: ANTHROPIC_API_KEY / OPENAI_API_KEY)")
  .addHelpText("after", "\nExamples:\n  tethertrace explain reports/login-2026-11-07\n  tethertrace explain reports/login-2026-11-07 -m anthropic\n  tethertrace explain reports/login-2026-11-07 -m ollama:qwen3:8b")
  .action(async (dir: string, o: { model?: string; baseUrl?: string; apiKey?: string }) => {
    const b = await loadReport(dir);
    console.log(explainLocally(b));
    if (o.model) {
      console.log(`\n--- ${o.model} ---`);
      console.log(await explainWithModel(b, o));
    }
  });

program
  .command("test")
  .description("Zero-config: install an APK (or use an installed package), explore its screens, catch crashes, write a report and ready-to-run flows")
  .argument("<apk-or-package>", "path to an .apk, or an installed package name")
  .addOption(deviceOpt())
  .option("--actions <n>", "maximum taps/backs", "40")
  .option("--minutes <n>", "time budget", "4")
  .option("--deny <regex>", "extra labels never to tap (case-insensitive regex)")
  .option("--no-install", "don't install the APK, just read its package")
  .option("--out <dir>", "report folder (default reports/test-<package>-<time>)")
  .addOption(recordOpt())
  .addHelpText("after", "\nExamples:\n  tethertrace test app-release.apk\n  tethertrace test com.example.app --actions 80\n\nNever taps things that look destructive or outward-facing (delete, pay, send, share, log out…), never types, declines permission prompts.")
  .action(async (target: string, o: { device?: string; actions: string; minutes: string; deny?: string; install: boolean; out?: string; record?: boolean }) => {
    const isApk = /\.apk$/i.test(target);
    const pkg = isApk ? (await readApkInfo(target)).packageName : target;
    const outDir = o.out ?? `reports/test-${pkg}-${stamp()}`;
    await withDevice(o.device, async (d) => {
      if (isApk && o.install) {
        console.error(`Installing ${target}…`);
        await d.install(target);
      } else if (!(await d.isInstalled(pkg))) throw new Error(`${pkg} is not installed${isApk ? " (drop --no-install)" : "; pass the .apk instead"}`);
      console.error(`Exploring ${pkg}…`);
      const s = await maybeRecord(d, o.record, outDir, () => explore(d, {
        pkg,
        outDir,
        maxActions: Number(o.actions),
        timeBudgetMs: Number(o.minutes) * 60_000,
        deny: o.deny ? new RegExp(o.deny, "i") : undefined,
        log: (m) => console.error(m),
      }));
      console.log(`\n${s.verdict === "no_crash_observed" ? "✔" : "✖"} ${s.verdict}: ${s.reason}`);
      if (s.launchTimeMs !== undefined) console.log(`Cold start: ${s.launchTimeMs} ms`);
      if (s.crashAfter) console.log(`Crashed after tapping "${s.crashAfter.label}" on screen ${s.crashAfter.screen}. Re-run: tethertrace run ${outDir}/repro.yaml`);
      for (const e of s.evidence.slice(0, 5)) console.log(`  ${e}`);
      if (s.skippedAsRisky.length) console.log(`Skipped as risky: ${s.skippedAsRisky.slice(0, 8).join(", ")}`);
      console.log(`Report: ${outDir}/report.html`);
      console.log(`Flow to keep: ${outDir}/explored-flow.yaml`);
      if (s.verdict !== "no_crash_observed") process.exitCode = 2;
    });
  });

program
  .command("record")
  .description("Record the phone screen (stops after --seconds, or press Ctrl+C)")
  .addOption(deviceOpt())
  .option("-o, --out <dir>", "folder for the recording (default reports/recording-<time>)")
  .option("--seconds <n>", "stop after this many seconds")
  .addHelpText("after", "\nUses the phone's built-in recorder when it works, otherwise continuous screenshots (an MP4 is made too if ffmpeg is installed).")
  .action(async (o: { device?: string; out?: string; seconds?: string }) => {
    const outDir = o.out ?? `reports/recording-${stamp()}`;
    await withDevice(o.device, async (d) => {
      const rec = await Recording.start(d, { maxSeconds: o.seconds ? Number(o.seconds) : undefined });
      console.error(`Recording (${rec.mode === "video" ? "built-in recorder" : "screenshot frames"})… ${o.seconds ? `${o.seconds} s` : "press Ctrl+C to stop"}`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        if (o.seconds) void rec.finished().then(() => resolve());
      });
      const names = await attachRecording(outDir, await rec.stop());
      console.log(`Saved: ${names.map((n) => `${outDir}/${n}`).join(", ")}`);
    });
  });

// ---------------------------------------------------------------- AI agents

program
  .command("mcp")
  .description("Start the MCP server (stdio) so Claude Code, Codex, Gemini CLI, Cursor or any MCP client can drive the phone")
  .addOption(deviceOpt())
  .option("--read-only", "only expose tools that look (no tap/type/install/launch)")
  .option("--allow-shell", "also expose a raw shell tool")
  .option("--package <name...>", "restrict app tools to these packages")
  .option("--reports <dir>", "where reports are written", "reports")
  .addHelpText("after", "\nClaude Code:  claude mcp add tethertrace -- tethertrace mcp\nCodex:        add [mcp_servers.tethertrace] with command = \"tethertrace\", args = [\"mcp\"] to ~/.codex/config.toml\nOther clients (Gemini CLI, Cursor, VS Code, Claude Desktop, local models): docs/mcp.md")
  .action(async (o: { device?: string; readOnly?: boolean; allowShell?: boolean; package?: string[]; reports: string }) => {
    await startMcpServer({ device: o.device, readOnly: o.readOnly, allowShell: o.allowShell, packages: o.package, reportsDir: o.reports });
  });

program.parseAsync().catch((e: unknown) => {
  const err = e as Error;
  const code = e instanceof AdbError || e instanceof PairingError || e instanceof SelectorError ? `${e.code}: ` : "";
  console.error(`tethertrace: ${code}${err.message}`);
  if (e instanceof SelectorError && e.visible.length) console.error(`On screen: ${e.visible.slice(0, 12).join(" | ")}`);
  process.exitCode = 1;
});
