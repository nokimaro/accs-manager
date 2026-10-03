import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { convertToTdata } from '@mtcute/convert'
import { defaultProductionDc } from '@mtcute/core/utils.js'
import { zipSync } from 'fflate'

/**
 * A real TDesktop tdata (written by mtcute) for made-up accounts with random auth keys, zipped under
 * `folder/tdata/…` — no real session is ever used in tests.
 */
export async function makeTdataZip(opts: { users: number[]; passcode?: string; folder?: string; extra?: Record<string, Uint8Array> }): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'accs-fixture-'))
  try {
    const tdataDir = join(dir, 'tdata')
    const sessions = opts.users.map((userId) => ({
      version: 3,
      primaryDcs: defaultProductionDc,
      self: { userId, isBot: false, isPremium: false, usernames: [] },
      authKey: new Uint8Array(randomBytes(256)),
    }))
    await convertToTdata(sessions, { path: tdataDir, ...(opts.passcode ? { passcode: opts.passcode } : {}) })
    const files: Record<string, Uint8Array> = { ...opts.extra }
    for (const entry of await readdir(tdataDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      files[`${opts.folder ? `${opts.folder}/` : ''}tdata/${relative(tdataDir, path)}`] = new Uint8Array(await readFile(path))
    }
    return zipSync(files)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
