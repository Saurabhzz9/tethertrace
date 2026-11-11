// A framework-free app that uses only what a .tapp package may use.
const $ = (id) => document.getElementById(id);
const rt = window.tapp; // present inside a tapp runtime, absent in a plain browser tab

async function main() {
  if (!rt) {
    $("where").textContent = "Opened outside a tapp runtime";
    return;
  }
  const info = await rt.info();
  $("where").textContent = `Running on ${info.platform}, runtime ${info.runtime}`;

  // Storage: asked for in tapp.config.json, so it is allowed.
  let count = Number((await rt.storage.get("count")) ?? 0);
  const show = () => ($("count").textContent = `Count: ${count}`);
  show();
  $("add").addEventListener("click", async () => {
    count += 1;
    show();
    await rt.storage.set("count", count);
    rt.vibrate(30).catch(() => {}); // a desktop cannot vibrate; that is fine
  });
  $("reset").addEventListener("click", async () => {
    count = 0;
    show();
    await rt.storage.remove("count");
  });

  // WebAssembly: a module with one exported function, add(a, b).
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]);
  try {
    const { instance } = await WebAssembly.instantiate(bytes);
    $("wasm").textContent = `WebAssembly: 2 + 3 = ${instance.exports.add(2, 3)}`;
  } catch (e) {
    $("wasm").textContent = `WebAssembly: failed (${e.message})`;
  }

  // Network: this package does not ask for it, so the runtime must refuse.
  try {
    await fetch("https://example.com/", { mode: "no-cors" });
    $("net").textContent = "Network: reached example.com (this should not happen)";
  } catch {
    $("net").textContent = "Network: blocked, as the manifest says";
  }

  // A permission the package did not ask for.
  $("perm").textContent = `Camera permission: ${rt.has("camera") ? "granted" : "not requested, so not available"}`;
}

main().catch((e) => ($("where").textContent = `Error: ${e.message}`));
