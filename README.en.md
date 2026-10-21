# dsh-wsl-bridge

[中文](README.md)

A native WSL (Linux) execution surface for [DSH](https://github.com/deepseek-ai/DeepSeek-Harness) on Windows. It starts no extra web server and installs nothing inside the distribution. Windows sessions and WSL sessions share one desktop app.

Version **0.4.7**. Requires **Windows**, a working WSL distribution, and **DSH `>= 0.2.1-rc.2`**. It is listed in [dsh-market](https://github.com/dsh-market/dsh-market): search for `dsh-wsl-bridge` in the plugin market, under the WSL category. Source: <https://github.com/TGWgulugu/dsh-wsl-bridge>

## Install

Search for `dsh-wsl-bridge` in DSH's plugin market ([dsh-market](https://github.com/dsh-market/dsh-market)) and install it from the WSL category. The package is also published on npm as [dsh-wsl-bridge](https://www.npmjs.com/package/dsh-wsl-bridge). Run the command below in a normal terminal, not inside a DSH tool sandbox. DSH installs that npm package. If `dsh` is not on `PATH`, use the full path to the `dsh.cmd` that ships with DSH Desktop.

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

**You choose the workspace inside the current distribution.** On a new conversation, selecting WSL lists that distribution's folders, starting at `$HOME`. Open a subfolder or go up a level, then confirm with "Use this folder". The chosen directory is whatever `wslpath -w` prints on that computer. No distribution name or username is built into the plugin. The folder control opens that directory instead of DSH's `default-workspace`.

Esc or Cancel closes the window for this visit only. Switch the mode away from WSL and back to WSL, and the window asks again. After the first message, DSH no longer allows a mode change, so the window does not return in that conversation.

The first `bash`, relative paths, and `grep` / `glob` without a `path` start in the folder you chose. Pass `/mnt/<drive>/...` when the search should cover a Windows directory. The `wsl_*` tools above do not use this window; they keep using the current Windows session directory.

| Tool | What it does |
|---|---|
| `bash` | Persistent bash in the distribution. The syntax is bash, not PowerShell |
| `read` / `write` / `edit` | Linux paths. Relative paths are relative to the folder you chose |
| `grep` | GNU grep in the distribution. Rows look like `path:line: text`. Omitting `path` searches the folder you chose |
| `glob` | Lists files matching a glob, oldest first. Omitting `path` lists the folder you chose |
| `wsl_env` | Distribution facts |

The folder list starts at `$HOME` and shows one level of directories. Text that a login profile prints is not treated as a path. If the lookup fails, the Windows session directory is not opened instead. The picker uses an opaque surface, so a skin that makes the app background translucent does not show through it.

## Configuration

Set these on the plugin row `config` (`cordis.patch.yml`, or a profile patch that overrides it). Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `distro` | `''` | Distribution name. An empty string uses the system default |
| `timeoutMs` | `120000` | Default deadline for `bash` / `wsl_bash`, in milliseconds |
| `fileTimeoutMs` | `30000` | Deadline for one read, write, or search |
| `maxFileBytes` | `2097152` | Maximum bytes `read` / `edit` will load |
| `defaultWorkdir` | `session` | For the host `wsl_*` tools, `session` is the current Windows session directory. In WSL mode, `session` is the folder you chose. `home` uses the distribution's `$HOME`. An absolute Linux path is also accepted |
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
- On a new conversation, WSL mode asks which folder inside the distribution should be the workspace. The folder control opens that directory. Skills and file references follow it. Esc closes that visit; leaving WSL mode and choosing it again asks once more. A conversation that has already started cannot change mode.
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
