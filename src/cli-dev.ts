import { Option, type Command } from "commander";
import { resolve } from "node:path";
import type { CliHelpers } from "./cli-build.js";
import type { Device } from "./device.js";
import { DevSession, describeCycle, readHistory, readSnapshot, requestStop, pidAlive, type CycleRecord, type VerifyLevel } from "./dev/session.js";

/** `tethertrace dev`: live development on the phone. */
export function registerDevCommands(program: Command, h: CliHelpers & { openDevice(target: string | undefined): Promise<Device & { address: string }> }) {
  program
    .command("dev")
    .description("Live development: watch the project, apply each change to the phone (hot reload, Metro, or rebuild + reinstall), then check the app")
    .argument("[action]", "start (default), status, or stop", "start")
    .addOption(h.deviceOpt())
    .option("--project <dir>", "project folder", ".")
    .addOption(new Option("--verify <level>", "after each update: off, smoke (app alive, no crash/ANR), changed (+ affected flows), full (+ every flow)").choices(["off", "smoke", "changed", "full"]).default("smoke"))
    .option("-p, --package <name>", "application id (default: from the project or the built APK)")
    .option("--module <path>", "Gradle module when the project has several apps, e.g. :app")
    .option("--variant <name>", "build variant for rebuilds", "debug")
    .option("--flows <dir...>", "flow files or folders for --verify changed/full (default ./flows)")
    .option("--screenshot", "save a screenshot after every update (always saved on failure)")
    .option("--no-hot-reload", "Flutter: always rebuild and reinstall instead of flutter run")
    .option("--no-initial", "do not build and install at start; wait for the first change")
    .option("--debounce <ms>", "wait this long after the last save before updating", "300")
    .option("--json", "print one JSON line per update (start/stop events too)")
    .addHelpText(
      "after",
      `
Examples:
  tethertrace dev                         watch ., update the phone on every save
  tethertrace dev --verify changed        also re-run flows that cover the changed code
  tethertrace dev status                  what the session for this project is doing
  tethertrace dev stop                    stop it (from another terminal)

How a change reaches the phone (always printed):
  Flutter       hot reload / hot restart through 'flutter run --machine' when Flutter sees the phone,
                otherwise rebuild + reinstall. pubspec and android/ changes always rebuild.
  React Native  Metro Fast Refresh when Metro is running (tethertrace cannot confirm the app applied it,
                so the update is reported as not confirmed); native and dependency changes rebuild.
  Android       incremental Gradle build of the debug variant, reinstall, restart.

Exit codes: 0 stopped cleanly, 1 could not start.`,
    )
    .action(async (action: string, o: { device?: string; project: string; verify: VerifyLevel; package?: string; module?: string; variant: string; flows?: string[]; screenshot?: boolean; hotReload: boolean; initial: boolean; debounce: string; json?: boolean }) => {
      const root = resolve(o.project);
      if (action === "status") {
        const s = await readSnapshot(root);
        const history = await readHistory(root, 10);
        if (o.json) return console.log(JSON.stringify({ session: s ?? null, history }, null, 2));
        if (!s) return console.log(`No dev session has run for ${root}.`);
        const state = s.stale ? "not running (interrupted)" : s.state === "stopped" ? "stopped" : `${s.state}, pid ${s.pid}`;
        console.log(`Dev session for ${root}: ${state}\n  Project: ${s.project?.name ?? "?"} (${s.project?.kind ?? "?"})  Mode: ${s.mode ?? "?"}  App: ${s.pkg ?? "?"}  Verify: ${s.verify}\n  Updates: ${s.cycles}${s.queued ? `, ${s.queued} change(s) queued` : ""}`);
        for (const n of s.notes) console.log(`  note: ${n}`);
        if (s.last) console.log(`\nLast update:\n${describeCycle(s.last)}`);
        return;
      }
      if (action === "stop") {
        const s = await requestStop(root);
        if (!s || s.stale || s.state === "stopped") return console.log(`No dev session is running for ${root}.`);
        for (let i = 0; i < 20 && pidAlive(s.pid); i++) {
          const now = await readSnapshot(root);
          if (now?.state === "stopped") break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const after = await readSnapshot(root);
        console.log(after?.state === "stopped" ? `Stopped the dev session (pid ${s.pid}).` : `Asked pid ${s.pid} to stop; it has not confirmed yet.`);
        return;
      }
      if (action !== "start") throw new Error(`Unknown dev action "${action}". Use start, status or stop.`);

      const emit = (ev: Record<string, unknown>) => console.log(JSON.stringify(ev));
      let address: string | undefined;
      const session = new DevSession({
        dir: root,
        connect: async () => {
          const d = await h.openDevice(o.device);
          address = d.address;
          return d;
        },
        deviceAddress: o.device ?? process.env.TETHERTRACE_DEVICE,
        pkg: o.package,
        module: o.module,
        variant: o.variant,
        verify: o.verify,
        flows: o.flows,
        screenshot: o.screenshot,
        flutterDaemon: o.hotReload,
        initialDeploy: o.initial,
        debounceMs: Number(o.debounce),
        log: (m) => (o.json ? process.stderr.write(`${m}\n`) : console.log(m)),
        onCycle: (c: CycleRecord) => (o.json ? emit({ event: "update", ...c }) : console.log(describeCycle(c))),
      });
      let stopping = false;
      const onSignal = () => {
        if (stopping) process.exit(130);
        stopping = true;
        void session.stop("Ctrl+C");
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        await session.start();
      } catch (e) {
        await session.stop("could not start");
        throw e;
      }
      const s = session.snap;
      if (o.json) emit({ event: "started", project: s.project, mode: s.mode, pkg: s.pkg, device: address, verify: s.verify, notes: s.notes });
      else console.log(`\nWatching ${root}\n  ${s.project?.name} (${s.project?.kind}) → ${s.pkg ?? "app id from first build"} on ${address ?? o.device ?? "phone"}\n  Mode: ${s.mode}  Verify: ${s.verify}\n  Save a file to update the phone. Ctrl+C to stop.`);
      await session.wait();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (o.json) emit({ event: "stopped", updates: s.cycles });
      else console.log(`Dev session stopped after ${s.cycles} update(s).`);
    });
}
