/**
 * Background execution for the WSL tools.
 *
 * A background command gets its OWN `wsl.exe` process (never `&` inside the
 * persistent shell: that shell lives inside the subprocess provider's managed
 * range, so disposing the shell — on timeout, abort or agent disposal — would
 * kill the background work with it). The process is registered with the host job
 * registry so the model collects it with `job_output` and stops it with
 * `job_kill`.
 *
 * The registry is consumed structurally (`start(spec)`), the same way
 * `@linxin666/dsh-win-bash` does: a leaf plugin takes no dependency on the job
 * implementation to call one method on an optional service.
 *
 * @module dsh-wsl-bridge/jobs
 */

/** Job kind / id prefix; keeps these jobs distinguishable in `job_list`. */
export const BACKGROUND_JOB_KIND = 'dsh-wsl-bridge'

/** In-memory capture ceiling for a background job's stdout. */
export const BACKGROUND_STDOUT_BYTES = 4 * 1024 * 1024

/** In-memory capture ceiling for a background job's stderr. */
export const BACKGROUND_STDERR_BYTES = 64 * 1024

/** Spill file ceiling for either stream. */
const SPILL_BYTES = 64 * 1024 * 1024

/**
 * Build the argv for a script piped into `bash -s` inside the distribution.
 *
 * @param {{distro: string}} config
 * @param {string|undefined} workdir - absolute Linux directory, when known.
 * @returns {string[]}
 */
export function backgroundArgv(config, workdir) {
  return [
    'wsl.exe',
    ...(config.distro === '' ? [] : ['-d', config.distro]),
    ...(workdir === undefined ? [] : ['--cd', workdir]),
    '-e', 'bash', '-s',
  ]
}

/**
 * Register one command as a host background job.
 *
 * @param {object} request
 * @param {object} request.subprocess - host subprocess service (spawn).
 * @param {{start: Function}} request.jobs - host job registry.
 * @param {object} request.config - resolved bridge config.
 * @param {string|undefined} request.owner - owning agent/session id.
 * @param {string} request.script - command text, run through `bash -s`.
 * @param {string} request.label - model-facing job label.
 * @param {string|undefined} request.workdir - absolute Linux directory.
 * @returns {string} the registry-issued job id.
 */
export function startWslBackgroundJob({ subprocess, jobs, config, owner, script, label, workdir }) {
  let process
  let failedBeforeStart
  let terminated = false

  const source = (channel) => ({
    channel,
    read: (fromByte) => {
      const reader = process?.collected?.[channel]
      if (reader === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      return reader.readFrom(fromByte)
    },
  })

  return jobs.start({
    kind: BACKGROUND_JOB_KIND,
    label,
    ...(owner === undefined ? {} : { owner }),
    output: [source('stdout'), source('stderr')],
    run: () => {
      try {
        process = subprocess.spawn({
          argv: backgroundArgv(config, workdir),
          cwd: processCwd(),
          stdio: {
            // The batch shape: the script is written to the child's stdin and the
            // descriptor is closed, so `bash -s` reads and runs it. No frame
            // protocol is involved — one command, one end.
            stdin: { data: script },
            stdout: { maxBytes: BACKGROUND_STDOUT_BYTES, spill: { maxBytes: SPILL_BYTES } },
            stderr: { maxBytes: BACKGROUND_STDERR_BYTES, spill: { maxBytes: SPILL_BYTES } },
          },
          graceMs: 5_000,
        })
      } catch (error) {
        failedBeforeStart = messageOf(error)
      }
      const spawned = process
      const done = spawned === undefined
        ? Promise.resolve(outcome(undefined, failedBeforeStart, false))
        : spawned.done.then(
          async (exit) => {
            try {
              await spawned.waitForExit()
            } catch {
              // The exit facts are already known; nothing left to observe.
            }
            return outcome(exit, undefined, terminated)
          },
          (error) => {
            failedBeforeStart = messageOf(error)
            return outcome(undefined, failedBeforeStart, false)
          },
        )
      return {
        cancel: () => {
          if (terminated) return
          terminated = true
          process?.terminate()
        },
        done,
      }
    },
  })
}

/**
 * The host-side working directory for the launcher process. The Linux directory
 * travels as `--cd`; `wsl.exe` itself starts anywhere on Windows.
 * @returns {string}
 */
function processCwd() {
  return typeof process.cwd === 'function' ? process.cwd() : '.'
}

/**
 * Map a settled process onto the job outcome vocabulary.
 * @param {{exitCode: number|null, signal?: string|null}|undefined} exit
 * @param {string|undefined} failedBeforeStart
 * @param {boolean} terminated
 * @returns {{status: string, detail?: string}}
 */
function outcome(exit, failedBeforeStart, terminated) {
  if (failedBeforeStart !== undefined) return { status: 'failed', detail: failedBeforeStart }
  if (terminated) {
    return { status: 'killed', detail: exit?.signal != null ? 'signal: ' + exit.signal : 'terminated before exit' }
  }
  return { status: 'completed', detail: 'exit code: ' + String(exit?.exitCode ?? 0) }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
