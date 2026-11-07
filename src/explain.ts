import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Explain a tethertrace report.
 *
 * Without a model: a deterministic summary built only from the report.
 * With --model: an LLM reads the same evidence and must cite it; tethertrace's own verdict stays the source of truth.
 *
 * Model spec: "anthropic[:model]", "openai[:model]", "ollama:<model>", "lmstudio[:model]",
 * or "openai-compatible:<model>" with --base-url.
 */

export interface ExplainOptions {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ReportBundle {
  summary: Record<string, unknown>;
  logTail: string;
  crash: string;
  ui: string;
}

const MAX_LOG_CHARS = 24_000;

export async function loadReport(dir: string): Promise<ReportBundle> {
  const read = async (f: string) => readFile(join(dir, f), "utf8").catch(() => "");
  const summaryText = await read("summary.json");
  if (!summaryText) throw new Error(`${dir} has no summary.json (is it a tethertrace report folder?)`);
  const log = await read("logcat.txt");
  return {
    summary: JSON.parse(summaryText) as Record<string, unknown>,
    logTail: log.length > MAX_LOG_CHARS ? log.slice(-MAX_LOG_CHARS) : log,
    crash: (await read("crash.txt")).slice(0, 8000),
    ui: (await read("ui.txt")).slice(0, 4000),
  };
}

/** No-AI explanation: restates exactly what the evidence shows. */
export function explainLocally(b: ReportBundle): string {
  const s = b.summary as {
    kind?: string;
    name?: string;
    package?: string;
    status?: string;
    verdict?: string;
    reason?: string;
    failure?: { step: number; category: string; message: string; evidence: string[]; visibleOnScreen?: string[] };
    device?: { manufacturer: string; model: string; androidVersion: string };
    launchTimeMs?: number;
    launch?: { totalTimeMs?: number };
  };
  const lines: string[] = [];
  const dev = s.device ? `${s.device.manufacturer} ${s.device.model}, Android ${s.device.androidVersion}` : "unknown device";
  lines.push(`${s.name ?? s.package} on ${dev}`);
  const launch = s.launchTimeMs ?? s.launch?.totalTimeMs;
  if (launch !== undefined) lines.push(`Cold start: ${launch} ms`);
  if (s.failure) {
    lines.push(`Result: FAILED at step ${s.failure.step} — ${s.failure.category}`);
    lines.push(`What happened: ${s.failure.message}`);
    if (s.failure.evidence.length) lines.push(`Evidence:\n  ${s.failure.evidence.slice(0, 8).join("\n  ")}`);
    if (s.failure.visibleOnScreen?.length) lines.push(`On screen at the time:\n  ${s.failure.visibleOnScreen.slice(0, 12).join("\n  ")}`);
    lines.push(NEXT_STEPS[s.failure.category] ?? "Next: open report.html and check logcat.txt around the failing step.");
  } else if (s.verdict) {
    lines.push(`Result: ${s.verdict} — ${s.reason ?? ""}`);
  } else lines.push(`Result: ${s.status}`);
  return lines.join("\n");
}

const NEXT_STEPS: Record<string, string> = {
  element_not_found: "Next: compare the selector with 'On screen at the time'. The label may differ (language, casing), the screen may not have loaded yet (raise timeoutMs), or the element may need a scroll.",
  assertion_failed: "Next: the expected text never appeared within the timeout. Check whether the previous step actually navigated, and the logs for errors after it.",
  ambiguous_selector: "Next: several elements match. Add `index`, or use `id`/`desc`/`contains` to pick one.",
  app_crash: "Next: the evidence lines are the crash header; the full stack trace is in crash.txt / logcat.txt.",
  anr: "Next: the main thread was blocked. Look for long work on the UI thread around the step.",
  app_exited: "Next: the process disappeared without a crash report. Check logcat.txt for 'Killing' / low-memory messages or an explicit exit.",
  device_disconnected: "Next: the phone dropped off Wi-Fi or Wireless debugging turned off. Re-run; if it repeats, keep the screen on and stay on the same network.",
  timeout: "Next: the device stopped answering. Re-run; if it repeats, reboot the phone.",
};

const SYSTEM = `You are a senior Android engineer reviewing an automated real-device test report produced by tethertrace.
Rules:
- Use only the evidence provided. Quote the exact log lines or fields you rely on.
- tethertrace's own failure category is authoritative; you may add a likely root cause, labelled "likely" with your confidence (low/medium/high).
- If the evidence is insufficient, say "unknown" and list what extra evidence would settle it.
- Output: 1) What failed (one sentence) 2) Evidence (quoted) 3) Likely cause 4) Suggested fix or next check. Keep it under 250 words.`;

function userPrompt(b: ReportBundle) {
  return [
    "## summary.json",
    JSON.stringify(b.summary, null, 2),
    b.crash && "## crash.txt",
    b.crash,
    b.ui && "## ui.txt (screen at failure)",
    b.ui,
    "## logcat.txt (app process only, tail)",
    b.logTail || "(empty)",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseModelSpec(spec: string) {
  const i = spec.indexOf(":");
  const provider = (i < 0 ? spec : spec.slice(0, i)).toLowerCase();
  const model = i < 0 ? undefined : spec.slice(i + 1);
  return { provider, model };
}

export async function explainWithModel(b: ReportBundle, o: ExplainOptions): Promise<string> {
  const { provider, model } = parseModelSpec(o.model!);
  if (provider === "anthropic" || provider === "claude") return explainAnthropic(b, model ?? "claude-opus-5-5", o.apiKey);
  const presets: Record<string, { baseUrl: string; model?: string; keyEnv?: string }> = {
    openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
    ollama: { baseUrl: "http://localhost:11434/v1" },
    lmstudio: { baseUrl: "http://localhost:1234/v1" },
    "openai-compatible": { baseUrl: o.baseUrl ?? "" },
  };
  const p = presets[provider];
  if (!p) throw new Error(`Unknown provider "${provider}". Use anthropic, openai, ollama, lmstudio or openai-compatible.`);
  const baseUrl = (o.baseUrl ?? p.baseUrl).replace(/\/$/, "");
  if (!baseUrl) throw new Error("openai-compatible needs --base-url");
  if (!model) throw new Error(`Give a model name, e.g. ${provider}:<model>`);
  const key = o.apiKey ?? (p.keyEnv ? process.env[p.keyEnv] : undefined);
  if (p.keyEnv && !key) throw new Error(`Set ${p.keyEnv} or pass --api-key`);
  return explainOpenAICompatible(b, baseUrl, model, key);
}

async function explainAnthropic(b: ReportBundle, model: string, apiKey?: string) {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    // On a safety decline, let the API re-run the request on a suitable fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: userPrompt(b) }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined to analyse this report.");
  return response.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
}

async function explainOpenAICompatible(b: ReportBundle, baseUrl: string, model: string, apiKey?: string) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt(b) },
      ],
    }),
  }).catch((e: Error) => {
    throw new Error(`Cannot reach ${baseUrl}: ${e.message}. Is the model server running?`);
  });
  if (!res.ok) throw new Error(`${baseUrl} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The model returned an empty answer");
  return text;
}
