const RELOADED_AT_KEY = 'accs:stale-chunk-reload-at'
/** A failure this soon after our own reload means reloading does not help: stop instead of looping. */
const LOOP_WINDOW_MS = 10_000

/** Chrome, Firefox and Safari messages for a dynamic import whose file is gone (deploy, Vite re-optimizing deps). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|Outdated Optimize Dep/i.test(message)
}

/**
 * Reloads the page to pick up the current build, unless this tab already did so moments ago.
 * Returns whether a reload was started.
 */
export function reloadAfterStaleChunk(reload: () => void = () => window.location.reload(), now: () => number = Date.now): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT_KEY))
    if (last && now() - last < LOOP_WINDOW_MS) return false
    sessionStorage.setItem(RELOADED_AT_KEY, String(now()))
  } catch {
    return false // no storage, no loop guard: let the error surface
  }
  reload()
  return true
}

/** A tab left open across a deploy requests lazy chunks that no longer exist (built app: `vite:preloadError`). */
export function reloadOnStaleChunks(reload?: () => void, now?: () => number): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadAfterStaleChunk(reload, now)) event.preventDefault()
  })
}
