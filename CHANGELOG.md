# Changelog

## 0.4.3 — 2026-10-19

- Self-check wording: a probe has no live agent, so the job registry's refusal
  now reads as "registry reachable" instead of an error line.

## 0.4.2 — 2026-10-19

- **Fix persistent `cd`**: the bash tools passed the session directory as the
  working directory on every call, which reset the persistent shell's cwd. The
  default workdir is now only the shell's initial directory; an explicit
  `workdir` still changes it for this and later calls. Verified in a real
  desktop session (env vars persisted, cwd now does too) and pinned by the
  integration self-check (`tool cd persistence=OK`).

## 0.4.1 — 2026-10-19

- Opt-in real background-job self-check (registers a job with the host registry
  and verifies the command actually wrote its file inside the distribution).

## 0.4.0 — 2026-10-19

- Add `runInBackground` to `wsl_bash` and the WSL preset's `bash`: the command is
  registered with the host job registry (`job_output` / `job_kill`) and owns its
  own `wsl.exe` process, so the persistent shell's lifecycle cannot kill it.
  Controlled by `backgroundJobs` (default on); refuses clearly when the
  deployment composes no job registry.
- The destructive guard runs before a background registration.
- Tests: 87 cases total.

## 0.3.0 — 2026-10-19

- Add a deterministic destructive-command guard (`dangerGuard`, default on):
  recursive deletes, block-device writes, power control, `find -delete` and
  `git clean -f/-d/-x` are refused unless the call passes `allowDangerous: true`.
  Applied to both `wsl_bash` and the WSL preset's `bash`.
- Add `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TROUBLESHOOTING.md`.
- Add `npm test` (78 cases), a CI workflow (Windows, Node 22/24), and
  `scripts/install-desktop.ps1`.
- Desktop-composition smoke test: an isolated profile replicating the desktop
  bundle set (web-all / market / better-sidebar) boots with both bridge layers
  active.

## 0.2.3 — 2026-10-19

- Packaging for publish: MIT LICENSE, bilingual `locale/*.json` display metadata,
  SVG icon, CHANGELOG, and a publish-shaped `files` list; `npm pack` yields 20
  files / ~37 KB with no build step.
- Fix the integration-test hooks: environment variables (`DSH_WSL_BRIDGE_SELFCHECK`,
  `DSH_WSL_BRIDGE_MARKER`, `DSH_WSL_BRIDGE_WORLD_*`) now override the shipped row
  config instead of being overridden by it.
- Dispose the shells the self-checks open, so a probe run leaves no `wsl.exe`
  processes behind.
- Verified a **packed** install (tarball into a fresh isolated profile, not a
  link): host tools mount, the `WSL` preset mounts, and bash/grep/glob execute in
  the distribution.

## 0.2.0 — 2026-10-19

- Add the declarative `WSL` agent preset: a session created in this mode mounts
  `dsh-wsl-bridge/wsl-world`, so `bash`, `read`, `write`, `edit`, `grep` and
  `glob` all operate on Linux paths inside the distribution.
- Add in-distribution `grep` (GNU grep -E) and `glob` (find + glob matching),
  pruning hidden entries and `node_modules`/VCS metadata.
- Capture the `subprocess` service during `apply()`: a preset mount context is
  inactive after activation, so a late `ctx.subprocess` lookup now never throws.
- Persona sentence tells the model its working directory is inside WSL and that
  Windows files live under `/mnt/<drive>`.

## 0.1.0 — 2026-10-19

- First host-only build: persistent `wsl_bash` (one shell per session, `cd`
  survives between calls), binary-safe `wsl_read`/`wsl_write`, sha256-fenced
  `wsl_edit`, `wsl_path`, `wsl_env`, and a default-on routing prompt section.
- Zero dependencies, no build step; opt-in self-check for integration testing.
