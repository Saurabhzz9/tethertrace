import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { TOOL_CLASSES } from "../dist/index.js";

// The optional HOL Guard catalog entry must describe the tools tethertrace really has.
const entry = JSON.parse(await readFile(new URL("../integrations/hol-guard/mcp.tethertrace.json", import.meta.url), "utf8"));
const states = Object.fromEntries(entry.tools.map((t) => [t.name, t.state]));

test("HOL Guard entry: external, opt-in, matched by the tethertrace command", () => {
  assert.equal(entry.schemaVersion, "guard.mcp-server-contribution.v1");
  assert.equal(entry.id, "mcp.tethertrace");
  assert.equal(entry.trustClass, "external");
  assert.equal(entry.activation, "opt-in");
  assert.deepEqual(entry.launch, { kind: "direct-command", command: "tethertrace" });
  assert.equal(entry.license, "MIT");
  assert.ok(entry.description.length <= 512);
  for (const a of entry.saferAlternatives) assert.ok(a.length <= 256, a);
});

test("HOL Guard entry: lists every tool once, and nothing that does not exist", () => {
  assert.equal(new Set(entry.tools.map((t) => t.name)).size, entry.tools.length);
  assert.deepEqual(Object.keys(states).filter((n) => n !== "other").sort(), Object.keys(TOOL_CLASSES).sort());
});

test("HOL Guard entry: can only tighten: read tools inherit, the rest are reviewed, shell is blocked", () => {
  // A direct-command entry may never say allow: a command name does not prove which program runs.
  assert.ok(!Object.values(states).includes("allow"));
  for (const [name, classes] of Object.entries(TOOL_CLASSES)) {
    const readOnly = classes.every((c) => c === "read");
    if (readOnly) assert.equal(states[name], "inherit", name);
    else assert.ok(states[name] === "review" || states[name] === "block", `${name} must be reviewed or blocked`);
  }
  assert.equal(states.shell, "block");
  // A tool added later is reviewed until the entry lists it.
  assert.equal(states.other, "review");
});

test("HOL Guard entry: the trust binding names the same extension as external", async () => {
  const binding = JSON.parse(await readFile(new URL("../integrations/hol-guard/command.mcp-tethertrace.v1.json", import.meta.url), "utf8"));
  assert.deepEqual(binding, { extension: "command.mcp-tethertrace", schemaVersion: "guard.extension-trust-binding.v1", trustClass: "external" });
});
