# dsh-wsl-bridge

[中文](README.md)

A native WSL (Linux) execution surface for [DSH](https://github.com/deepseek-ai/DeepSeek-Harness) on Windows. It starts no extra web server and installs nothing inside the distribution. Windows sessions and WSL sessions share one desktop app.

Version **0.4.6**. Requires **Windows**, a working WSL distribution, and **DSH `>= 0.2.1-rc.2`**. Source: <https://github.com/TGWgulugu/dsh-wsl-bridge>

## Install

The plugin is published on npm as [dsh-wsl-bridge](https://www.npmjs.com/package/dsh-wsl-bridge). Run this in a normal terminal, not inside a DSH tool sandbox. DSH installs that npm package. If `dsh` is not on `PATH`, use the full path to the `dsh.cmd` that ships with DSH Desktop.

```powershell
dsh plugin --profile desktop add dsh-wsl-bridge
```

To install the source in this repository instead of the npm release:

```powershell
dsh plugin --profile desktop add .
```

From the repository root, `pwsh -File scripts/install-desktop.ps1` does the same. Quit DSH Desktop from the tray and open it again. A page refresh does not load the plugin.

After the restart:

- Every session gains `wsl_bash`, `wsl_read`, `wsl_write`, `wsl_edit`, `wsl_path`, and `wsl_env`.
- The new-session mode picker has a **WSL** entry.

Uninstall:

```powershell
dsh plugin --profile desktop remove dsh-wsl-bridge
```

If the app then fails to start, run `pnpm install` in that profile directory.

## Two ways to use it

### WSL tools in any session

These tools are added beside the Windows shell and file tools. They do not replace them.

| Tool | What it does |
|---|---|
| `wsl_bash` | Runs bash in WSL. One persistent shell per session, so `cd` and `export` survive. Output ends with `[exit code: N]` |
| `wsl_read` | Reads a Linux path, with optional line `offset` / `limit` |
| `wsl_write` | Atomically writes a Linux path. `expectedSha256` refuses the write when the file changed after you read it |
| `wsl_edit` | Replaces a string. A sha256 check ties the write to the bytes that were read |
| `wsl_path` | Converts Windows paths to Linux paths and back. Uses the distribution's `wslpath` when it can |
| `wsl_env` | Reports the distribution, kernel, user, and whether node / python3 / git are present |

A routing note is on by default: for Linux work, prefer `wsl_bash` and Linux paths; Windows files are at `/mnt/<drive>`. It does not hide or disable the host tools.

`wsl_bash` accepts `runInBackground: true`. The command is registered as a host job (`job_output` to read it, `job_kill` to stop it) and owns a separate WSL process. It does not inherit the persistent shell's `cd` or `export`, and it is not killed when that shell exits.

### WSL session mode

Choose **WSL** when creating a session. In that session, `bash`, `read`, `write`, `edit`, `grep`, and `glob` run inside Linux and take Linux paths. Persona, skills, goals, plan mode, compaction, subagents, todos, web, and present stay the standard DSH set.

**The default workspace is the current distribution's home directory (`$HOME`).** The first `bash` starts there. Relative paths resolve there. `grep` and `glob` search there when `path` is omitted. Pass `/mnt/<drive>/...` when the search should cover a Windows directory.

| Tool | What it does |
|---|---|
| `bash` | Persistent bash in the distribution. The syntax is bash, not PowerShell |
| `read` / `write` / `edit` | Linux paths. Relative paths are relative to `$HOME` |
| `grep` | GNU grep in the distribution. Rows look like `path:line: text`. Omitting `path` searches `$HOME` |
| `glob` | Lists files matching a glob, oldest first. Omitting `path` lists `$HOME` |
| `wsl_env` | Distribution facts |

`$HOME` is resolved once. Text that a login profile prints is not treated as the path. If the lookup fails, search does not fall back to the Windows session directory.

## Configuration

Set these on the plugin row `config` (`cordis.patch.yml`, or a profile patch that overrides it). Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `distro` | `''` | Distribution name. An empty string uses the system default |
| `timeoutMs` | `120000` | Default deadline for `bash` / `wsl_bash`, in milliseconds |
| `fileTimeoutMs` | `30000` | Deadline for one read, write, or search |
| `maxFileBytes` | `2097152` | Maximum bytes `read` / `edit` will load |
| `defaultWorkdir` | `session` for host tools; `home` for WSL mode | `session` translates the Windows session directory to `/mnt/...`. `home` uses the distribution's `$HOME`. An absolute Linux path is also accepted |
| `dangerGuard` | `true` | Refuses obviously destructive commands unless that call passes `allowDangerous: true` |
| `backgroundJobs` | `true` | Allows `runInBackground`. Refuses clearly when the host has no job registry |
| `promptSection` | `true` | Adds the routing note to host sessions |
| `promptOrder` | `3260` | Sort order of that note |
| `promptText` | `''` | Replaces the built-in routing note. Empty keeps the built-in text |
| `selfCheck` | `false` | Probes WSL once on mount. `DSH_WSL_BRIDGE_SELFCHECK=1` does the same |
| `selfCheckMarker` | `''` | Appends the probe result to this file. Or set `DSH_WSL_BRIDGE_MARKER` |

The refusal list covers recursive deletes, block-device writes, power control, `find -delete`, and `git clean -fdx`. It is a fixed list, not a kernel boundary. A different spelling can still get through.

## Limits

- Windows only. Both rows disable themselves on any other host.
- The tools run through `wsl.exe` and are **not** inside DSH's Windows file sandbox. Treat them as able to write anything that WSL user can write, including Windows paths reached through `/mnt/<drive>`. See [docs/SECURITY.md](docs/SECURITY.md).
- `grep` / `glob` use GNU grep and find. They do not read `.gitignore`. Hidden files, `node_modules`, and VCS metadata are skipped.
- The folder selected in the desktop UI stays that UI's workspace. WSL-mode tools no longer search it by default. Skill directories and UI file references still use Windows paths.
- The first call waits for the distribution to start and can take several seconds. `timeoutMs` defaults to 120 seconds.
- This plugin does not install Node or any other toolchain inside the distribution.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the host tools and the WSL mode are split, and why shell / fs services are left alone.
- [docs/SECURITY.md](docs/SECURITY.md): the sandbox boundary, and what the destructive-command guard does not promise.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): nothing showed up, `EPERM`, a missing mode, cold start, uninstall.

## Development

```powershell
npm test
npm run test:integration
pwsh -NoProfile -File test/release.test.ps1
pwsh -File scripts/release.ps1 -DryRun
```

`npm test` does not need WSL. `npm run test:integration` runs inside a real distribution and deletes its own temporary directory. The release-script check does not publish. A real publish needs a clean git tree, then `pwsh -File scripts/release.ps1`.

The code is plain ESM with no build. `index.js` registers the host tools, `wsl-world.js` registers WSL session mode, and the implementation is in `src/`.

## License

[MIT](LICENSE)
