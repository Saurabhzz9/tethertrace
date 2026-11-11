# Security policy

tethertrace holds a key that your phone trusts for debugging, so security issues matter.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and the impact. You'll get an acknowledgement within a few days. Please give us reasonable time to fix it before disclosing publicly; we'll credit you unless you prefer otherwise.

## Scope

In scope:

- The ADB protocol implementation (pairing, SPAKE2, TLS, authentication)
- Handling of the host key in `~/.tethertrace`
- Command injection into the device shell through CLI, flow files or MCP tool arguments
- MCP server permission switches (`--read-only`, `--package`, `--allow-shell`) not being enforced
- Secrets leaking into reports

Out of scope: the inherent power of Android Wireless debugging itself (anyone you pair has shell access by design), and vulnerabilities in Android or in third-party AI providers.

## Using tethertrace safely

- Pair only computers you control, and only on networks you trust.
- Turn Wireless debugging off when you're done. Revoke old pairings in Developer options.
- Give AI agents `--read-only` or `--package <your app>` unless they need more. Keep `--allow-shell` off.
- For anything you would not want done without you, add `--confirm install,execute,sensitive`. The server then waits for your approval on each call.
- `~/.tethertrace/audit.jsonl` records what agents were allowed and denied. The full model is in [docs/mcp.md](docs/mcp.md#security-model).
- Review reports before sharing: screenshots and logs can contain personal data.
