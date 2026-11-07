# How it works

tethertrace talks to `adbd`, the debugging daemon already on every Android phone, over the same protocol Google's `adb` uses. It just does it from TypeScript, so there is nothing else to install.

## 1. Discovery (`src/adb/mdns.ts`)

With Wireless debugging on, the phone advertises two mDNS services:

- `_adb-tls-pairing._tcp` while the "Pair device with pairing code" dialog is open
- `_adb-tls-connect._tcp` for normal connections (the port changes every time Wireless debugging is toggled)

tethertrace sends a one-shot query on each IPv4 interface and reads the PTR/SRV/A records.

## 2. Pairing, once (`src/adb/pairing.ts`, `src/adb/spake2.ts`)

1. TLS 1.3 to the pairing port, each side presenting a self-signed certificate.
2. Both sides export 64 bytes of keying material (label `adb-label\0`) and append it to the 6-digit code, binding the code to this TLS session.
3. **SPAKE2** over edwards25519, byte-compatible with BoringSSL's `spake25519.c` (the M/N points, the cofactor handling and the transcript are reproduced exactly; the points are re-derived in the tests).
4. HKDF-SHA256 turns the shared secret into an AES-128-GCM key. Each side sends its `PeerInfo` encrypted: we send our RSA public key, the phone sends its GUID.

A wrong code makes decryption fail on the phone, which closes the connection; nothing is trusted.

## 3. Connecting (`src/adb/connection.ts`)

1. `CNXN` with our features.
2. The phone answers `STLS`; both sides switch the same TCP socket to TLS 1.3. The phone accepts only client certificates whose key was paired.
3. The phone sends its `CNXN` banner (model, features). From here on it's the normal ADB stream protocol: `OPEN` / `OKAY` / `WRTE` / `CLSE`, with `shell,v2` for exit codes and `exec:` for binary-safe output.

Older `adb tcpip` style connections (RSA token signing + public-key prompt) are implemented too.

## 4. Doing things (`src/device.ts`)

| Feature | Android command over the stream |
|---|---|
| Screen elements | `uiautomator dump` |
| Tap / type / keys / swipe | `input tap|text|keyevent|swipe` |
| Screenshot | `screencap` (raw, downscaled in-process) or `screencap -p` |
| Install | `exec:cmd package install -S <size>`, streamed, no temp file |
| Launch time | `am start -W` (`TotalTime`) after `am force-stop` |
| Logs | `logcat -d -T <mark>` and the `crash` buffer, filtered to the app's PIDs |
| Memory | `dumpsys meminfo <pkg>` |
| Package of an APK | Read from the APK's binary `AndroidManifest.xml` (`src/apk.ts`) |

## 5. Verdicts (`src/smoke.ts`, `src/runner.ts`)

The classifier only states what the evidence supports. A crash in the logs outranks the symptom ("button not found" because the app died is reported as `app_crash`). A disappearing process with no crash report is `app_exited`, not a guess.

## Compatibility checks

- Unit tests run the full pairing and connection against a mock `adbd` that shares no state with the client except the wire.
- During development, Google's official `adb` 1.0.41 was pointed at that mock: `adb pair` succeeded with the right code and failed with a wrong one, `adb connect` completed the STLS/TLS upgrade, and `adb shell` ran. Since the mock and the client share the SPAKE2/pairing/framing code, this checks that code against Google's implementation.
- Then the real thing: pairing, TLS connect and everything above on a physical Android 14 phone.

## Dependencies

| Package | Why |
|---|---|
| `@noble/curves` | edwards25519 point arithmetic for SPAKE2 (audited) |
| `@modelcontextprotocol/sdk`, `zod` | MCP server |
| `@anthropic-ai/sdk` | Optional `explain -m anthropic` |
| `commander`, `yaml` | CLI and flow files |

Everything else (TLS, RSA, AES-GCM, HKDF, X.509, ZIP, binary XML, PNG) uses Node's built-ins or small in-repo code.
