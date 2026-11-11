// Used by CI only: turn a failed `tethertrace build --json` into GitHub annotations, so the reason
// shows on the run's summary page.
import { readFileSync } from "node:fs";

const [resultFile, stderrFile] = process.argv.slice(2);
const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
// Annotation text is one line; GitHub decodes %0A as a line break.
const oneLine = (s) => s.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A").slice(0, 3500);

let result;
try {
  result = JSON.parse(read(resultFile));
} catch {
  result = undefined;
}
if (result?.error) {
  const e = result.error;
  console.log(`::error title=tethertrace build: ${e.category}::${oneLine([e.message, ...e.excerpt, ...e.hints].join("\n"))}`);
  if (result.toolchain) console.log(`::notice title=toolchain::${oneLine(JSON.stringify(result.toolchain))}`);
}
const stderr = read(stderrFile).trim();
if (stderr) console.log(`::error title=tethertrace build: last output::${oneLine(stderr.split("\n").slice(-25).join("\n"))}`);
if (!result?.error && !stderr) console.log("::error title=tethertrace build::failed without a result or any output");
