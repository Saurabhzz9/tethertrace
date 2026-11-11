import type { Command } from "commander";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readApkInfo } from "./apk.js";
import type { CliHelpers } from "./cli-build.js";
import { describeBuild, forgetMemory, listMemories, loadMemory, memoryFile } from "./memory.js";
import { describeVerify, findFlows, verify, type VerifyMode } from "./verify.js";

/** Commands around what tethertrace remembers about an app: verify, memory. */
export function registerVerifyCommands(program: Command, h: CliHelpers) {
  program
    .command("verify")
    .description("Check the installed build against what is remembered: re-run the flows that could be affected, explore a new build, report regressions")
    .argument("[flows...]", "flow files or folders (default: ./flows)")
    .addOption(h.deviceOpt())
    .option("-p, --package <name>", "application id (default: the app the flows name, or the one in --apk)")
    .option("--apk <file>", "install this APK first")
    .option("--changed", "run only the flows that could be affected (default)")
    .option("--full", "run every flow and explore again")
    .option("--discover", "explore only, to record the app's screens")
    .option("--project <dir>", "git checkout the build was made from, to see which source changed", ".")
    .option("--no-explore", "never explore, only run flows")
    .option("--actions <n>", "maximum taps/backs while exploring")
    .option("--minutes <n>", "time budget for exploring", "4")
    .option("--out <dir>", "report folder (default reports/verify-<package>-<time>)")
    .option("--json", "print the result as JSON")
    .addHelpText(
      "after",
      "\nExamples:\n  tethertrace verify --discover -p com.example.app     first time: record the screens\n  tethertrace verify --changed                          after a new build: what could be affected\n  tethertrace verify --full                             everything\n\nA flow can say which source it covers, so a new build only re-runs it when that source changed:\n  covers: [app/src/main/java/com/example/login/**]\n\nFlows that are not run are reported as not run, never as passed.",
    )
    .action(async (inputs: string[], o: { device?: string; package?: string; apk?: string; full?: boolean; discover?: boolean; changed?: boolean; project: string; explore: boolean; actions?: string; minutes: string; out?: string; json?: boolean }) => {
      if ([o.full, o.discover, o.changed].filter(Boolean).length > 1) throw new Error("Choose one of --changed, --full, --discover");
      const mode: VerifyMode = o.full ? "full" : o.discover ? "discover" : "changed";
      let where = inputs;
      if (!where.length && mode !== "discover") {
        const dflt = await stat("flows").then((s) => s.isDirectory(), () => false);
        if (dflt) where = ["flows"];
      }
      const { flows, problems } = await findFlows(where);
      for (const p of problems) console.error(`! ${p}`);
      if (problems.length) throw new Error("Some flow files could not be read; fix them or leave them out.");
      let pkg = o.package ?? (o.apk ? (await readApkInfo(o.apk)).packageName : undefined);
      if (!pkg) {
        const apps = [...new Set(flows.map((f) => f.flow.app))];
        if (apps.length === 1) pkg = apps[0];
        else throw new Error(apps.length ? `The flows are for several apps (${apps.join(", ")}); pick one with --package` : "Give --package (or --apk, or flows that name the app)");
      }
      if (mode !== "discover" && !flows.some((f) => f.flow.app === pkg)) console.error(`No flows for ${pkg}${where.length ? ` in ${where.join(", ")}` : ""}; only exploring.`);
      const outDir = o.out ?? `reports/verify-${pkg}-${h.stamp()}`;
      await h.withDevice(o.device, async (d) => {
        if (o.apk) {
          console.error(`Installing ${o.apk}…`);
          await d.install(o.apk);
        }
        const s = await verify(d, {
          pkg: pkg!,
          mode,
          flows,
          outDir,
          projectDir: resolve(o.project),
          explore: o.explore ? undefined : false,
          maxActions: o.actions ? Number(o.actions) : undefined,
          timeBudgetMs: Number(o.minutes) * 60_000,
          log: (m) => console.error(m),
        });
        console.log(o.json ? JSON.stringify(s, null, 2) : `\n${describeVerify(s)}\nReport: ${outDir}/verify.json`);
        if (s.status === "failed") process.exitCode = 2;
      });
    });

  program
    .command("memory")
    .description("Show what is remembered about an app (builds, screens, how each flow went). It is a plain JSON file you can edit")
    .argument("[package]")
    .option("--json", "print the stored file")
    .option("--forget", "delete what is remembered about this app")
    .action(async (pkg: string | undefined, o: { json?: boolean; forget?: boolean }) => {
      if (!pkg) {
        const all = await listMemories();
        if (!all.length) return console.log("Nothing is remembered yet. `tethertrace verify` records what it sees.");
        for (const p of all) console.log(p);
        return;
      }
      if (o.forget) return console.log((await forgetMemory(pkg)) ? `Forgot ${pkg}.` : `Nothing was remembered about ${pkg}.`);
      const m = await loadMemory(pkg);
      if (o.json) return console.log(JSON.stringify(m, null, 2));
      console.log(`${m.package}\nFile: ${memoryFile(pkg)}`);
      if (m.notes) console.log(`Notes: ${m.notes}`);
      console.log(`\nBuilds seen: ${m.builds.length}`);
      for (const b of m.builds.slice(-5)) console.log(`  ${describeBuild(b)}${b.commit ? `, commit ${b.commit.slice(0, 7)}` : ""}`);
      console.log(`\nScreens reached by the explorer: ${m.screens.length}`);
      for (const sc of m.screens.slice(0, 30)) console.log(`  ${sc.title}${sc.ignore ? " (ignored)" : ""}`);
      if (m.screens.length > 30) console.log(`  … ${m.screens.length - 30} more`);
      console.log(`\nFlows: ${m.flows.length}`);
      for (const f of m.flows) {
        const last = f.runs.at(-1);
        console.log(`  ${f.name}: ${last ? `${last.status} on ${last.at.slice(0, 10)}${last.failure ? ` (step ${last.failure.step}: ${last.failure.category})` : ""}` : "no runs"}, ${f.runs.length} run${f.runs.length === 1 ? "" : "s"}${f.covers ? `, covers ${f.covers.join(", ")}` : ""}`);
      }
      const e = m.explorations.at(-1);
      if (e) console.log(`\nLast exploration: ${e.verdict}, coverage ${e.coverage}, ${e.screens} screens (${e.at.slice(0, 10)})`);
    });
}
