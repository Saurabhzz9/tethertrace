import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { quoteForCmd } from "../toolchain/fetch.js";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * Start a tool without a shell. Windows .bat/.cmd files need cmd.exe; there every argument is
 * quoted and characters cmd would still expand (%, !, newlines) are refused.
 */
export function spawnTool(cmd: string, args: string[], o: SpawnOptions = {}): ChildProcess {
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(cmd)) {
    for (const a of [cmd, ...args]) if (/[%!\r\n]/.test(a)) throw new Error(`Refusing to pass ${JSON.stringify(a)} through cmd.exe`);
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[cmd, ...args].map(quoteForCmd).join(" ")}"`], { ...o, windowsVerbatimArguments: true });
  }
  return spawn(cmd, args, o);
}

/** Small process helpers for the dev session. Arguments are always passed as an array, never through a shell string. */

export async function runCapture(cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "";
    const child = spawnTool(cmd, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => void killTree(child), o.timeoutMs ?? 60_000);
    child.stdout!.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Stop a process and its children. Windows has no process groups for this, so it uses taskkill /T. */
export async function killTree(child: ChildProcess, graceMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const gone = new Promise<void>((r) => child.once("exit", () => r()));
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => child.kill());
  } else {
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), graceMs);
    gone.finally(() => clearTimeout(t));
  }
  await Promise.race([gone, new Promise((r) => setTimeout(r, graceMs + 2_000))]);
}

/** Find an executable on PATH (with Windows extensions), or undefined. */
export async function which(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        await access(p);
        return p;
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}

/** Is something answering on localhost:port with this path? (Used to find Metro.) */
export async function httpText(url: string, timeoutMs = 1_500): Promise<string | undefined> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.text() : undefined;
  } catch {
    return undefined;
  }
}
