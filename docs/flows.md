# YAML flows

A flow is a list of steps run in order against one app. The first failing step stops the run and the report explains why.

```yaml
app: com.example.app        # required: application id
name: checkout              # optional: report folder name (defaults to the file name)
covers: [lib/cart/**]       # optional: source this flow tests, used by `tethertrace verify` (see verify.md)
steps:
  - launch
  - tap: "Add to cart"
  - waitFor: "Cart (1)"
```

Run it:

```bash
tethertrace run checkout.yaml [--device host:port] [--out reports/checkout]
```

Exit code is `0` on pass and `2` on failure, so it works in scripts and CI.

## Finding labels

Open the screen on the phone and run:

```bash
tethertrace ui
```

```text
      Welcome back
[tap] Sign in  #com.example.app:id/sign_in  @72,1956,1008,2112
[tap] English / Namaste  @558,1674,1008,1884
```

`[tap]` marks clickable elements. Multi-line labels are shown joined with ` / `; matching works on any single line.

## Selectors

Any step that targets an element accepts either a string or an object:

| Form | Matches |
|---|---|
| `"Sign in"` | Visible text **or** accessibility description, exactly, or any line of a multi-line label |
| `{ text: "Sign in" }` | Visible text only |
| `{ desc: "Close" }` | Content description only (icon buttons) |
| `{ id: "sign_in" }` | Resource id (`com.app:id/sign_in` or just `sign_in`); Compose `testTag` when exposed as resource id |
| `{ contains: "welcome" }` | Case-insensitive substring of text or description |
| `{ text: "Delete", index: 1 }` | The second of several matches |

If several elements match, tethertrace prefers the single clickable one, then the innermost clickable one. If it still can't decide it fails with `ambiguous_selector` rather than guess.

## Steps

| Step | Example | Notes |
|---|---|---|
| `launch` | `- launch` | Force-stops, then cold-starts the launcher activity; records launch time |
| `tap` | `- tap: "OK"` | Waits up to 10 s for the element (`timeoutMs` to change) |
| `longPress` | `- longPress: "Photo"` | |
| `type` | `- type: "${EMAIL}"` | ASCII only. `${VAR}` reads environment variables. Never written to reports |
| `key` | `- key: enter` | back, home, enter, tab, delete, menu, recents |
| `back` / `home` | `- back` | Shorthand keys |
| `waitFor` | `- waitFor: "Home"` | Default 10 s |
| `assertVisible` | `- assertVisible: { contains: "paid" }` | Default 5 s |
| `assertHidden` | `- assertHidden: "Loading"` | Default 5 s |
| `scroll` | `- scroll: down` | up, down, left, right |
| `sleep` | `- sleep: 1500` | Milliseconds, max 60 s |
| `screenshot` | `- screenshot: cart` | Saved as `cart.png` in the report |

Per-step timeout:

```yaml
  - waitFor: "Order placed"
    timeoutMs: 30000
```

## Results

Each run writes a folder:

| File | Contents |
|---|---|
| `summary.json` | Machine-readable result (schema below) |
| `report.html` | Human-readable report with screenshots |
| `steps.jsonl` | One line per step with timing |
| `logcat.txt` | Only the app's own process lines (plus crash lines) |
| `crash.txt` | Android crash buffer, if anything crashed |
| `failure.png` · `ui.txt` | Screen and element list at the moment of failure |

Failure categories:

| Category | Meaning |
|---|---|
| `element_not_found` | A tap/wait target never appeared; `visibleOnScreen` lists what did |
| `assertion_failed` | An `assertVisible`/`assertHidden` didn't hold |
| `ambiguous_selector` | Several elements match; add `index` or a narrower selector |
| `app_crash` | A crash was logged (this outranks the step symptom) |
| `anr` | Android reported "app not responding" |
| `app_exited` | The process vanished without a crash report |
| `device_disconnected` | The phone dropped off the network |
| `timeout` | The phone stopped answering |
| `unsupported_step` | Unknown step or untypable text |
| `unknown` | Anything else; the message has details |

## Let an AI write flows

With the MCP server connected (see [mcp.md](mcp.md)), use the built-in `write_test` prompt or ask your agent to read the app source, inspect each screen with `ui_tree`, write the flow, run it with `run_flow` and fix it until it passes. `tethertrace test app.apk` also saves `explored-flow.yaml` as a starting point.

## Tips

- Use `{ id: ... }` for stable tests, text for quick ones.
- Animations: prefer `waitFor` over `sleep`.
- Translated apps: match on ids, or keep one flow per language.
- Keep personal flows out of git (`flows/` is ignored by default).
