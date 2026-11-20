# Troubleshooting

| Message | What to do |
|---|---|
| `No phone found on this network` | Turn Wireless debugging on. Phone and computer must be on the same Wi-Fi; guest networks and some office networks block devices from seeing each other. Try `tethertrace discover --timeout 8000`, or pass `--device host:port` from the Wireless debugging screen. |
| `CONNECT: … ECONNREFUSED` | Wireless debugging is off, or its port changed. Many phones turn it off when the screen locks, Wi-Fi changes or after a while. Turn it on again; the pairing is remembered. |
| `TLS_REJECTED` | This computer isn't paired, or the pairing was removed on the phone ("Forget" / "Revoke authorizations"). Run `tethertrace pair <code>` again. |
| `WRONG_CODE_OR_EXPIRED` | The code was mistyped or the pairing dialog closed. Open it again and use the new code quickly. |
| `No pairing dialog found` | Keep **Pair device with pairing code** open while you run `pair`, or pass the `host:port` shown in it. |
| `element_not_found` | Compare your selector with "On screen instead" in the output or `tethertrace ui`. The screen may need more time (`timeoutMs`), a scroll, or the text differs (language, casing). |
| `UI hierarchy unavailable` | Secure screens (passwords, banking), games and custom canvases don't expose elements. Use `screenshot` and `tap` with x/y. |
| `UNSUPPORTED_TEXT` | `type` can only send ASCII. For other scripts, paste via the app or test with ids. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | A version signed with a different key is installed. Uninstall it on the phone first. |
| Recording says "screenshot frames" | The phone's built-in `screenrecord` is missing or crashes (seen on some MediaTek/ColorOS builds). tethertrace records continuous screenshots instead (~4–6 fps) and builds `recording/index.html`; install ffmpeg if you also want an MP4. |
| `INSTALL_FAILED_USER_RESTRICTED` | Some brands (Xiaomi, OPPO/realme, vivo) need "Install via USB/ADB" enabled in Developer options, or ask for confirmation on the phone. |

## The screen locks or goes dark during a run

`run`, `smoke`, `explore` and `verify` check the screen before they start and again whenever an
element is not found. When the screen is off they wake it; when the lock screen needs no PIN,
pattern or password (Swipe or None) they dismiss it and carry on.

A real lock (PIN, pattern, password) is never entered. The step fails at once as `screen_locked`
instead of waiting out its timeout, and an "is gone" check never passes because of a lock screen.
For a phone you test on often, set Screen lock to Swipe or None and raise Screen timeout.

Reading the screen (`ui`, `screenshot`, MCP read tools) never wakes or unlocks the phone; it reports
`SCREEN_LOCKED` or `SCREEN_OFF` instead.

## "UI hierarchy unavailable" (videos, animations)

Android's `uiautomator` waits for the screen to be still before it reads it. A playing video or an
endless animation can stop it from ever finishing ("could not get idle state"). tethertrace retries
until the step's timeout, then fails the step as `ui_unavailable` with uiautomator's own message.
It does not pause media for you: add a step that pauses the video, or wait for a still screen.
Screens marked secure (FLAG_SECURE) cannot be read at all.

## The phone drops off Wi-Fi mid-run

A step that times out is checked with a quick round trip; if the phone no longer answers, the
failure is `device_disconnected`, evidence that needs the phone is skipped (instead of waiting for
each read to time out), and the report is still written. Steps already done are in `steps.jsonl`.
In `verify`, flows after the loss are reported as not run. Commands do not reconnect mid-run;
run them again. `dev` and the MCP server reconnect on the next action.

## Where things live

- Pairing key: `~/.tethertrace/adbkey` (override with `TETHERTRACE_HOME`). Delete it to start over; the phone will need pairing again.
- Reports: `./reports/<name>-<time>/`.

## Still stuck?

Open an issue with the phone model, Android version, your OS, the exact command and its output. Leave out pairing codes and screenshots with personal data.
