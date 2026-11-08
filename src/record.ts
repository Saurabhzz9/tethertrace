import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdbError, withTimeout, type AdbStream } from "./adb/connection.js";
import type { Device } from "./device.js";

/**
 * Screen recording of the phone, over the tethertrace connection.
 *
 * - "video": Android's own `screenrecord` (an MP4 on the phone, pulled back afterwards). Android caps one
 *   recording at 180 s, so longer sessions are recorded as consecutive parts.
 * - "frames": fallback for phones whose `screenrecord` is missing or broken (it crashes on some OEM builds).
 *   tethertrace captures screenshots continuously with timestamps and builds a player page; if `ffmpeg`
 *   happens to be installed it also produces an MP4. Nothing extra is required.
 */

const SEGMENT_LIMIT_S = 180;
const MAX_FRAMES = 3000;

export interface RecordingOptions {
  /** Stop automatically after this many seconds (default: until stop()). */
  maxSeconds?: number;
  /** Video bit rate in Mbit/s for the native recorder (default 4). */
  bitRateMbps?: number;
  /** Force a mode instead of detecting it. */
  mode?: "video" | "frames";
}

export type RecordingResult = { kind: "video"; videos: Buffer[] } | { kind: "frames"; frames: { ms: number; png: Buffer }[] };

/** Is the phone's screenrecord usable? (It segfaults on some builds.) */
export async function nativeRecorderWorks(d: Device): Promise<boolean> {
  const probe = `/data/local/tmp/tethertrace-probe-${randomBytes(3).toString("hex")}.mp4`;
  const r = await d.shell(`screenrecord --time-limit 1 ${probe} >/dev/null 2>&1; s=$?; if [ -s ${probe} ]; then echo ok; fi; rm -f ${probe}; exit $s`, 20_000).catch(() => undefined);
  return Boolean(r?.text.includes("ok"));
}

export class Recording {
  readonly mode: "video" | "frames";
  private parts: string[] = [];
  private current?: { path: string; stream: AdbStream; done: Promise<void> };
  private frames: { ms: number; png: Buffer }[] = [];
  private framesLoop?: Promise<void>;
  private stopped = false;
  private readonly started = Date.now();
  private readonly tag = randomBytes(4).toString("hex");
  private failure?: Error;

  private constructor(
    private readonly d: Device,
    private readonly o: RecordingOptions,
    mode: "video" | "frames",
  ) {
    this.mode = mode;
  }

  static async start(d: Device, o: RecordingOptions = {}) {
    const mode = o.mode ?? ((await nativeRecorderWorks(d)) ? "video" : "frames");
    const r = new Recording(d, o, mode);
    if (mode === "video") await r.startSegment();
    else r.framesLoop = r.captureFrames();
    return r;
  }

  private timeUp() {
    return this.o.maxSeconds !== undefined && Date.now() - this.started >= this.o.maxSeconds * 1000;
  }

  private async captureFrames() {
    // Two captures in flight roughly doubles the frame rate over Wi-Fi.
    const worker = async () => {
      while (!this.stopped && !this.timeUp() && this.frames.length < MAX_FRAMES) {
        const ms = Date.now() - this.started;
        try {
          this.frames.push({ ms, png: await this.d.screenshotPng() });
        } catch (e) {
          if (e instanceof AdbError && e.code === "CLOSED") return;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    };
    await Promise.all([worker(), new Promise((r) => setTimeout(r, 150)).then(worker)]);
  }

  private remainingSeconds() {
    if (this.o.maxSeconds === undefined) return SEGMENT_LIMIT_S;
    return Math.max(1, Math.min(SEGMENT_LIMIT_S, Math.ceil(this.o.maxSeconds - (Date.now() - this.started) / 1000)));
  }

  private async startSegment() {
    const path = `/data/local/tmp/tethertrace-rec-${this.tag}-${this.parts.length + 1}.mp4`;
    const bitRate = Math.round((this.o.bitRateMbps ?? 4) * 1_000_000);
    const stream = await this.d.adb.open(`exec:screenrecord --time-limit ${this.remainingSeconds()} --bit-rate ${bitRate} ${path}`);
    this.parts.push(path);
    const done = stream.readAll().then(() => undefined);
    this.current = { path, stream, done };
    // When Android's per-recording limit ends a segment, start the next one.
    void done.then(async () => {
      if (!this.stopped && !this.timeUp()) await this.startSegment().catch((e: Error) => (this.failure ??= e));
    });
  }

  /** Resolves when the recording ends on its own (maxSeconds reached). */
  async finished() {
    if (this.mode === "frames") return this.framesLoop;
    while (this.current) {
      const c = this.current;
      await c.done;
      await new Promise((r) => setTimeout(r, 300));
      if (this.current === c) break;
    }
  }

  /** Stop and collect the recording. Temporary files are removed from the phone. */
  async stop(): Promise<RecordingResult> {
    this.stopped = true;
    if (this.mode === "frames") {
      await this.framesLoop;
      if (!this.frames.length) throw new AdbError("PROTOCOL", "No frames could be captured");
      return { kind: "frames", frames: [...this.frames].sort((a, b) => a.ms - b.ms) };
    }
    const c = this.current;
    if (c && !c.stream.closed) {
      // SIGINT makes screenrecord finish the MP4 properly; match only our own file.
      await this.d.shell(`pkill -INT -f ${c.path} || kill -INT $(pidof screenrecord)`).catch(() => undefined);
      await withTimeout(c.done, 15_000, () => c.stream.close(), new AdbError("TIMEOUT", "screenrecord did not stop")).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 500));
    const videos: Buffer[] = [];
    for (const p of this.parts) {
      const s = await this.d.adb.open(`exec:cat ${p}`);
      const data = await withTimeout(s.readAll(), 120_000, () => s.close(), new AdbError("TIMEOUT", "Downloading the recording timed out"));
      await this.d.shell(`rm -f ${p}`).catch(() => undefined);
      if (data.length > 8 && data.subarray(4, 8).toString("latin1") === "ftyp") videos.push(data);
    }
    if (!videos.length) throw this.failure ?? new AdbError("PROTOCOL", "The phone produced no recording");
    return { kind: "video", videos };
  }
}

function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => execFile("ffmpeg", ["-version"], { timeout: 5000 }, (e) => resolve(!e)));
}

/** Frames → MP4 with ffmpeg, keeping the real timing. Only used when ffmpeg is already installed. */
async function framesToMp4(dir: string, frames: { ms: number; file: string }[], out: string) {
  const lines: string[] = [];
  for (const [i, f] of frames.entries()) {
    const next = frames[i + 1]?.ms ?? f.ms + 1000;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.05, (next - f.ms) / 1000).toFixed(3)}`);
  }
  lines.push(`file '${frames[frames.length - 1]!.file}'`);
  await writeFile(join(dir, "frames.txt"), `${lines.join("\n")}\n`);
  await new Promise<void>((resolve, reject) =>
    execFile(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.txt", "-vf", "scale=trunc(iw/4)*2:trunc(ih/4)*2,format=yuv420p", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", out],
      { cwd: dir, timeout: 300_000 },
      (e) => (e ? reject(e) : resolve()),
    ),
  );
}

function playerHtml(frames: { ms: number; file: string }[]) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tethertrace recording</title>
<style>body{margin:0;background:#111;color:#ddd;font:14px system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px}
img{max-height:80vh;max-width:100%;border-radius:12px;border:1px solid #333}input{width:min(420px,90vw)}button{font:inherit;padding:6px 14px}</style>
<img id="f" alt="recording frame"><div><button id="p">Pause</button> <span id="t"></span></div><input id="s" type="range" min="0" value="0">
<p style="color:#888">Captured as screenshots (${frames.length} frames) because this phone's built-in recorder is unavailable.</p>
<script>const F=${JSON.stringify(frames)};const img=document.getElementById("f"),s=document.getElementById("s"),t=document.getElementById("t"),p=document.getElementById("p");
s.max=F.length-1;let i=0,playing=true,timer;function show(){img.src=F[i].file;s.value=i;t.textContent=(F[i].ms/1000).toFixed(1)+" s";}
function tick(){show();if(!playing)return;const n=i+1<F.length?F[i+1].ms-F[i].ms:1500;i=(i+1)%F.length;timer=setTimeout(tick,Math.max(30,n));}
p.onclick=()=>{playing=!playing;p.textContent=playing?"Pause":"Play";clearTimeout(timer);if(playing)tick();};s.oninput=()=>{i=+s.value;show();};F.forEach(f=>{const im=new Image();im.src=f.file;});tick();</script>`;
}

/** Save a recording into a folder (and link it from report.html/summary.json if present). Returns the saved names. */
export async function attachRecording(outDir: string, rec: RecordingResult): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const names: string[] = [];
  if (rec.kind === "video") {
    const files = rec.videos.length === 1 ? ["recording.mp4"] : rec.videos.map((_, i) => `recording-${i + 1}.mp4`);
    for (const [i, v] of rec.videos.entries()) await writeFile(join(outDir, files[i]!), v);
    names.push(...files);
  } else {
    const dir = join(outDir, "recording");
    await mkdir(dir, { recursive: true });
    const frames = rec.frames.map((f, i) => ({ ms: f.ms, file: `frame-${String(i).padStart(5, "0")}.png` }));
    for (const [i, f] of rec.frames.entries()) await writeFile(join(dir, frames[i]!.file), f.png);
    await writeFile(join(dir, "index.html"), playerHtml(frames));
    names.push("recording/index.html");
    if (await hasFfmpeg()) {
      try {
        await framesToMp4(dir, frames, join("..", "recording.mp4"));
        names.unshift("recording.mp4");
      } catch {
        /* the frame player is still there */
      }
    }
  }
  try {
    const summaryPath = join(outDir, "summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { files?: string[] };
    summary.files = [...(summary.files ?? []), ...names];
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const htmlPath = join(outDir, "report.html");
    const html = await readFile(htmlPath, "utf8");
    const video = names.find((n) => n.endsWith(".mp4"));
    const block = `<h2>Screen recording</h2>${video ? `<video controls preload="metadata" src="${video}" style="max-width:360px;border:1px solid #ccc;border-radius:8px"></video>` : ""}${names.includes("recording/index.html") ? `<p><a href="recording/index.html">Open the frame-by-frame recording</a></p>` : ""}`;
    await writeFile(htmlPath, html.replace(/(<p style="color:#666;font-size:13px">)/, `${block}\n$1`));
  } catch {
    /* no report in this folder: the recording is still saved */
  }
  return names;
}

/** Run `fn` while recording into `outDir`; the recording is attached after `fn` has written its report. */
export async function recordWhile<T>(d: Device, on: boolean | undefined, outDir: string, fn: () => Promise<T>, log: (m: string) => void = () => undefined): Promise<T> {
  if (!on) return fn();
  const rec = await Recording.start(d);
  log(`Recording the screen (${rec.mode === "video" ? "built-in recorder" : "screenshot frames: this phone's recorder is unavailable"})…`);
  try {
    return await fn();
  } finally {
    try {
      const names = await attachRecording(outDir, await rec.stop());
      log(`Recording: ${outDir}/${names[0]}`);
    } catch (e) {
      log(`Recording failed: ${(e as Error).message}`);
    }
  }
}
