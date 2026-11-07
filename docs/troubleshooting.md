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
| `INSTALL_FAILED_USER_RESTRICTED` | Some brands (Xiaomi, OPPO/realme, vivo) need "Install via USB/ADB" enabled in Developer options, or ask for confirmation on the phone. |

## Where things live

- Pairing key: `~/.tethertrace/adbkey` (override with `TETHERTRACE_HOME`). Delete it to start over; the phone will need pairing again.
- Reports: `./reports/<name>-<time>/`.

## Still stuck?

Open an issue with the phone model, Android version, your OS, the exact command and its output. Leave out pairing codes and screenshots with personal data.
