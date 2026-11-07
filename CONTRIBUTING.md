# Contributing

Thanks for helping. The most valuable contribution right now is **trying tethertrace on your phone** and reporting what happened (model, Android version, OS, what worked, what didn't) in [Discussions](https://github.com/Saurabhzz9/tethertrace/discussions) or an issue.

## How changes land

- `main` is protected. Nobody pushes to it directly, including maintainers' day-to-day work.
- Every change is a pull request from a fork or branch, needs the CI checks to pass, and needs approval from a code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS)).
- Only maintainers merge. Please don't take it personally if a PR waits a few days.

For anything bigger than a bug fix, open an issue first so we can agree on the approach before you spend time on it.

## Development

```bash
git clone https://github.com/<you>/tethertrace
cd tethertrace
npm ci
npm test          # builds and runs the test suite against a mock device
node dist/cli.js --help
```

Node.js 22 or newer. No Android SDK is needed, for development or for use.

### Tests

- Unit and protocol tests live in `tests/*.test.mjs` and run against `tests/helpers/mock-device.mjs`, a fake `adbd`.
- New behaviour needs a test. Bug fixes need a test that fails without the fix.
- If you verified something on a real phone, say which phone and Android version in the PR. Never claim hardware results you didn't observe.

### Ground rules for the code

- **No adb binary or Android SDK dependency, ever.** The point of the project is speaking the protocol directly.
- **No app-specific code.** Everything must work for any app. Example flows use public apps (like Android Settings) or `com.example.*`.
- Validate everything that goes into a device shell command (package names, coordinates, keys). Never interpolate untrusted text into a shell string unquoted.
- No telemetry, no network calls except to the phone and, only when the user asks for it, an AI provider.
- Keep secrets out of reports (typed text is redacted; keep it that way).
- Keep dependencies few and well-maintained.

## Commit messages

Short imperative subject (`Add swipe step to flows`), a body explaining why when it isn't obvious.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
