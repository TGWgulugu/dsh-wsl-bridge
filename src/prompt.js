/**
 * The model-facing routing section (default ON, per the user's decision).
 *
 * It only changes which executor the model reaches for first; it hides nothing
 * and disables nothing (the host's `pwsh`/`bash` tools stay visible). The text
 * is registered with `interpolate: false` so nothing in it is treated as a
 * prompt variable — DSH 0.2.x registers only `provider` and `model`, and an
 * unknown `{{...}}` reference fails prompt assembly.
 *
 * @module dsh-wsl-bridge/prompt
 */

/** Built-in routing text. English, like the rest of the system prompt. */
export const DEFAULT_SECTION_TEXT = [
  '# WSL bridge',
  '',
  'This Windows host also has a WSL (Windows Subsystem for Linux) distribution. For',
  'work that belongs on the Linux side — building, running, scripting, git in a',
  'Linux checkout, inspecting Linux services — prefer `wsl_bash` over `pwsh`.',
  '`wsl_bash` runs in the distribution with a real Linux kernel and a persistent',
  'bash: `cd` and exported variables survive between calls, and its output ends',
  'with `[exit code: N]`.',
  '',
  '- Paths on the WSL side are Linux paths (`/home/me/...`, `/mnt/d/...`). `wsl_read`,',
  '  `wsl_write` and `wsl_edit` take those paths; a Windows path is translated for you.',
  '- Windows files stay reachable inside WSL as `/mnt/<drive>/...`; `wsl_path`',
  '  converts both ways when you need the Windows spelling.',
  '- `wsl_bash` is bash, not PowerShell: send bash syntax, not cmdlets.',
  '- Use `pwsh` only when the task genuinely needs a Windows-native capability',
  '  (registry, services, COM, Windows-only tools).',
].join('\n')

/**
 * Register the routing section in the calling context's prompt scope.
 *
 * @param {object} ctx - cordis context carrying `systemPrompt`.
 * @param {object} config - resolved bridge config.
 * @returns {unknown} the registry's disposer (the service binds it to ctx).
 */
export function registerPromptSection(ctx, config) {
  const text = config.promptText === '' ? DEFAULT_SECTION_TEXT : config.promptText
  return ctx.systemPrompt.section({
    name: config.promptSectionName,
    order: config.promptOrder,
    text,
    interpolate: false,
  })
}
