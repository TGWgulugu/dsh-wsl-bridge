# Troubleshooting

## Nothing appears after installing

- The host half loads **at DSH start**: fully quit the app from the tray and open
  it again (a page refresh is not enough).
- Check the bundle is declared: `package.json` → `dsh.profile.bundles` contains
  `dsh-wsl-bridge`.
- Check the host version: `engines.dsh` requires `>=0.2.1-rc.2`. A mismatch is
  reported by the Desktop plugin manager at install time.

## `spawn EPERM` / "cannot start wsl.exe"

- If the host process itself runs under a restricted token (for example a test
  host launched from inside a sandboxed agent session), Windows refuses
  `CreateProcess` for `wsl.exe`. This is not a WSL or bridge bug.
- The real Desktop host runs unrestricted. If you see EPERM there, check Windows
  security software and that `wsl.exe` exists at `%SystemRoot%\System32\wsl.exe`.
- Inside an agent session, run `wsl_env` first: it reports the exact launcher
  error instead of hiding it.

## `cannot get required service "subprocess" in inactive context`

Fixed in 0.2.0+: the plugin captures the service object during `apply()`. If you
see it, you are running a build older than 0.2.0.

## The `WSL` mode is missing from the mode picker

- Restart DSH (presets mount at start, not on page refresh).
- A preset whose activation failed stays on the roster with a diagnostic and
  cannot compose a session; check the host log for `preset-wsl`.
- The preset is Windows-only, like the rest of the bundle.

## First WSL command is slow

The distribution is started on demand: a cold `bash -lc` measured 5.6–7.1 s on a
real machine, hot calls ~1.2 s. `timeoutMs` defaults to 120 s.

## `node: command not found` inside the distribution

The bridge does not need Node inside WSL. If your project does, install it there
(for example with `nvm`) — nothing is installed on your behalf.

## Uninstall

```powershell
dsh plugin --profile desktop remove dsh-wsl-bridge
# if the app then fails to start, run pnpm install in the profile directory
```
