# Test memory and `verify`

tethertrace remembers what it has seen of an app, so the next build does not start from nothing. `verify` uses that memory to decide what has to be checked again.

```bash
tethertrace verify --discover -p com.example.app   # first time: explore and record the screens
tethertrace verify                                 # after a new build: check what could be affected
tethertrace verify --full                          # run every flow and explore again
```

`verify` looks for flows in `./flows` unless you pass files or folders. It exits `0` when everything it ran passed (or nothing needed checking) and `2` when a flow failed or the explorer saw a crash.

## What is remembered

One JSON file per app in `~/.tethertrace/memory/android-<package>.json`:

| Part | What it holds |
|---|---|
| `builds` | Each build seen: version name, version code, install time, and the git commit when `verify` ran inside a checkout |
| `screens` | Screens the explorer reached: a signature of the structure, the title, and the first and last build it was seen on |
| `flows` | For each flow file: its last 20 runs with build, result, failing step and report folder |
| `explorations` | The last 20 explorer runs: verdict, coverage, number of screens |
| `notes` | Free text for you. tethertrace never changes it |

Typed text is never stored. Screen titles are stored, so treat the file like a report: it can contain text from the app.

```bash
tethertrace memory                      # apps that are remembered
tethertrace memory com.example.app      # a readable summary, and the file's path
tethertrace memory com.example.app --json
tethertrace memory com.example.app --forget
```

You can edit the file. Set `"ignore": true` on a screen whose content always differs (a feed, a clock) and it is left out of comparisons. If the file is not valid JSON, `verify` stops and says so. It does not overwrite a file it cannot read.

## How a build is identified

The phone reports the app's version code and the time it was last installed. Together they are the build's identity, so rebuilding the same version still counts as a new build. If the phone reports neither, the build is treated as new every time.

## What `--changed` runs

For each flow, in this order:

| Situation | Result |
|---|---|
| Never run before | runs |
| The flow file changed since its last run | runs |
| It failed last time | runs |
| It already passed on this exact build | not run |
| New build, the flow has no `covers` | runs |
| New build, `covers` is set, but what changed in the source is not known | runs |
| New build, a changed file matches `covers` | runs |
| New build, no changed file matches `covers` | not run |

A flow is skipped only when there is a recorded reason. Anything unknown runs. A flow that was not run is reported as `not_run`. It is never counted or stored as passed.

### `covers`

A flow can name the source it tests:

```yaml
app: com.example.app
name: login
covers:
  - app/src/main/java/com/example/login/**
  - app/src/main/res/layout/activity_login.xml
steps:
  - launch
  - tap: "Sign in"
```

Paths are relative to the root of the git repository. `**` crosses folders, `*` stays inside one name, and a folder name covers everything in it.

When `verify` runs inside a git checkout (`--project <dir>`, default the current folder), it stores the commit with the build. On the next build it compares that commit with the current one, including uncommitted files, and runs the flows whose `covers` match a changed file.

This assumes the installed build was made from that checkout. tethertrace cannot check that, and it says so in the output. If you are not sure, use `--full`.

## Regressions

A flow that passed on the previous build with the same flow file and fails now is marked as a regression. The report shows the failing step, the category and what was on screen instead.

tethertrace does not repair anything on its own. It never rewrites a selector or an assertion in your flow. A label that changed on purpose and a broken screen look the same from the outside, so that decision stays with you.

## Exploring

`verify` explores the app when the build is new, in `--full` and in `--discover`. It compares the screens it reached with the remembered ones and reports:

- **New or changed screens**: a structure not seen before.
- **Known screens not reached this time**: this does not mean they were removed. The explorer may have taken another path or hit its limit.

Reaching a screen shows that it opens without a crash. It does not show that the screen does the right thing. Flows with `assertVisible` do that.

Use `--no-explore` to run flows only.

## From an AI agent

Over MCP the same things are `verify_app` (permission class `interact`) and `app_memory` (read-only). In a session started with `--package`, both are limited to those apps.
