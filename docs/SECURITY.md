# Security and boundaries

## What the bridge can touch

The bridge spawns `wsl.exe` through the host `subprocess` service. That path is
**below** DSH's file sandbox: on Windows the sandbox wraps shell executors and the
filesystem mutations with an ACL/restricted-token runner, but the Linux side of a
`wsl.exe` child runs on the Linux kernel and cannot be fenced by a Windows token.

Consequences, stated rather than hidden:

- A WSL-side write through these tools is not constrained by the session's
  `workspace-write` policy. Treat the bridge as able to write anything the WSL
  user can write, plus whatever the Windows user can reach through `/mnt/<drive>`.
- The destructive-command guard is a **deterministic refusal list**, not a kernel
  boundary: it stops obvious irreversible commands (`rm -r`, device writes,
  power control, `find -delete`, `git clean -fdx`) unless the call passes
  `allowDangerous: true`. A differently spelled command can still do damage.
- `distro` is a caller-visible string; no shell interpolation happens on the host
  side (argv arrays only), and paths/payloads are quoted or base64-encoded.

## What it does not do

- It opens no network listener and starts no server.
- It installs nothing in the distribution and asks for no credentials.
- It does not read the host environment into the distribution: `ctx.subprocess`
  already scrubs `*KEY*`/`*SECRET*`/`*TOKEN*` and `DSH_*` from child environments.

## Reporting

This is a community plugin. Report security-relevant issues through
https://github.com/TGWgulugu/dsh-wsl-bridge/issues and include the minimum
reproduction, without credentials or personal paths.
