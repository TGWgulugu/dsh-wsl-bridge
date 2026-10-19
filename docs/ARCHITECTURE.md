# Architecture

`dsh-wsl-bridge` gives DSH on Windows a native Linux execution surface without a
second web server and without installing anything inside WSL.

## Two layers

| Layer | Entry | Rows | What it does |
|---|---|---|---|
| Host bridge | `index.js` | `wsl-bridge` | Registers `wsl_bash`/`wsl_read`/`wsl_write`/`wsl_edit`/`wsl_path`/`wsl_env` for **every** session and publishes a routing prompt section. |
| WSL preset | `wsl-world.js` | `preset-wsl` → `wsl-world` | Declares an agent preset `WSL`; a session created in that mode gets `bash`/`read`/`write`/`edit`/`grep`/`glob`/`wsl_env` whose world is the distribution. |

The preset row is a plain `@deepseek-ai/dsh-agent-preset` declaration. Its
`plugins` list is the shipped `standard` preset with three substitutions:

- `tool-bash` / `tool-pwsh` removed (they are the Windows shells);
- `tool-fs` / `tool-fs-search` removed (host-path file tools and Windows ripgrep);
- `wsl-world` inserted.

Everything else (persona, instructions, skills, goals, plan mode, compaction,
subagents, todo, web, present) is the shipped set, so a WSL session is a normal
DSH session whose shell and file world happen to be Linux.

## Why no service replacement

DSH exposes `ctx.shell` and `ctx.fs` services, but a composition allows exactly
one implementation of each. Replacing them would change every session, and a
preset-scope provider would need an isolate realm to avoid leaking. Instead the
preset mounts **tools**, which are scoped: the host's tools stay untouched and
the WSL session's tools shadow nothing globally.

## Execution path

```
model tool call
  → tool.execute(args, exec)
  → shell pool (one persistent `wsl.exe … bash -l -s` per agent; one-shots for files)
  → ctx.subprocess.spawn({ argv, stdio })
  → wsl.exe → bash inside the distribution
```

- **Persistent shell**: one frame per call (nonce begin/end markers, `$?`
  captured, stdout/stderr kept separate). `cd` and exports survive; a dead shell
  is reported with `shellRestarted` and rebuilt on the next call.
- **One-shot calls** (`read`/`write`/`edit`/`grep`/`glob`): `wsl.exe --cd <dir> -e
  bash -lc <command>`. Payloads travel as base64 on stdin, so quoting and binary
  bytes can never change the command; writes go through a sibling temp file and
  `mv -T`, and existing file modes are preserved. Edits hash the exact bytes read
  and recheck the hash just before rename. This is a best-effort stale check,
  not atomic compare-and-swap: an external writer can still race the final
  check/rename. Atomic replacement replaces a target symlink rather than its
  referent; use the resolved file path if the link must be preserved. Ownership,
  ACLs and extended attributes are not copied from the old inode.
- **Paths**: Windows drive paths map to `/mnt/<drive>`. Host `wsl_*` tools still
  translate the session directory into the default workdir. A `WSL` session
  (`defaultWorkdir: home`) reads the distribution's `$HOME` once and uses that
  path for the initial shell, relative paths, and grep/glob. `wsl_path` prefers
  the distribution's own `wslpath` and falls back to the host-side mapping.
- **grep/glob** run GNU grep/find inside the distribution (the host search suite
  ships a Windows ripgrep, which cannot see Linux paths). They prune hidden
  entries and `node_modules`/VCS metadata; `.gitignore` is not read (documented).

## Platform and compatibility gates

- Windows only: both rows carry `disabled: !!js process.platform !== 'win32'`.
- `engines.dsh: ">=0.2.1-rc.2"` is the install-time gate the Desktop plugin
  manager reads; the loader itself only composes bundles listed in
  `dsh.profile.bundles`.
- Zero dependencies and no build step. This is deliberate: on DSH 0.2.1 a preset
  row spelled as a `file:` URL cannot resolve bare `@deepseek-ai/*` imports (the
  module interception layer is keyed on the importer's path), so a package-name
  row from the profile's `node_modules` is the only reliable shape. The bundle
  therefore imports nothing outside `node:` built-ins.
