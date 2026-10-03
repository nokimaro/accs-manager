import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'

export interface ZipLimits {
  maxFiles: number
  maxUnpackedBytes: number
}

export class ZipLimitError extends Error {
  readonly kind: 'files' | 'size' | 'path'
  constructor(kind: ZipLimitError['kind'], message: string) {
    super(message)
    this.name = 'ZipLimitError'
    this.kind = kind
  }
}

/** A safe relative path inside the target dir, or null for entries we skip (directories, macOS metadata). */
export function safeEntryPath(name: string): string | null {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.endsWith('/')) return null
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.')
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') return null
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..') || parts.length === 0) {
    throw new ZipLimitError('path', `Недопустимый путь в архиве: ${name}`)
  }
  return parts.join(sep)
}

/**
 * Streams a zip into `dir`: entries are written one by one (never the whole archive unpacked in memory),
 * the file count and the unpacked size are capped as they grow (zip bombs), paths cannot escape `dir`
 * (zip-slip), and nothing but regular files is ever created — a symlink entry becomes a small text file.
 */
export function extractZip(data: Uint8Array, dir: string, limits: ZipLimits): number {
  // the streaming reader silently finds nothing in non-zip bytes: check the local-file / empty-archive signature
  const signature = data.length >= 4 ? (data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24)) >>> 0 : 0
  if (signature !== 0x04034b50 && signature !== 0x06054b50) throw new Error('not a zip archive')
  let files = 0
  let total = 0
  let failure: Error | null = null
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (file) => {
    if (failure) return
    let relative: string | null
    try {
      relative = safeEntryPath(file.name)
    } catch (err) {
      failure = err as Error
      return
    }
    if (relative === null) return
    if (++files > limits.maxFiles) {
      failure = new ZipLimitError('files', `В архиве больше ${limits.maxFiles} файлов`)
      return
    }
    const target = join(dir, relative)
    mkdirSync(dirname(target), { recursive: true })
    const fd = openSync(target, 'wx')
    file.ondata = (err, chunk, final) => {
      if (failure) return
      if (err) {
        failure = err
      } else {
        total += chunk.length
        if (total > limits.maxUnpackedBytes) failure = new ZipLimitError('size', `После распаковки архив больше ${Math.round(limits.maxUnpackedBytes / 1024 / 1024)} МБ`)
        else writeSync(fd, chunk)
      }
      if (final || failure) closeSync(fd)
    }
    file.start()
  }
  // feed in slices so a limit stops the inflation early instead of after the whole archive
  const STEP = 64 * 1024
  for (let offset = 0; offset < data.length && !failure; offset += STEP) {
    unzip.push(data.subarray(offset, offset + STEP), offset + STEP >= data.length)
  }
  if (failure) throw failure
  return files
}
