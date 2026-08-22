/** Behavior of the workspace-files service over a real temporary workspace. */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import WorkspaceFiles from '../src/index.ts'
import type { WorkspaceFilesEntry } from '../src/index.ts'

const SESSION = 's1' as SessionId
let root: string
let outside: string
let service: WorkspaceFiles
let dispose: () => Promise<void>

beforeAll(async () => {
  // Canonicalize at creation: the service realpaths its root, and the platform
  // temp spelling may be an 8.3 alias that would then differ from every join.
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wsfiles-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wsfiles-out-')))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1\n')
  await writeFile(join(root, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(root, '.env'), 'SECRET=1\n')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]))
  await writeFile(join(root, 'big.txt'), 'a'.repeat(100 * 1024))
  // Junctions need no privilege on Windows; both links stay representative.
  await symlink(join(root, 'src'), join(root, 'inner-link'), 'junction')
  await symlink(outside, join(root, 'escape'), 'junction')

  const ctx = new Context()
  ctx.provide('sessions', {
    get: (id: string) => {
      if (id === SESSION) return { header: { cwd: root } }
      if (id === 'no-cwd') return { header: {} }
      return undefined
    },
  })
  const fiber = ctx.plugin(WorkspaceFiles)
  await fiber.await()
  service = ctx.get('workspaceFiles') as WorkspaceFiles
  dispose = () => fiber.dispose()
})

afterAll(async () => {
  await dispose()
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('list', () => {
  it('lists the workspace root: files and directories, sorted, hidden flagged, file rows sized', async () => {
    const listing = await service.list(SESSION)
    expect(listing.path).toBe(root)
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map(entry => entry.name)).toEqual(['.env', 'assets', 'big.txt', 'binary.bin', 'escape', 'inner-link', 'src'])
    const kinds = Object.fromEntries(listing.entries.map(entry => [entry.name, entry.kind]))
    expect(kinds['src']).toBe('directory')
    expect(kinds['inner-link']).toBe('directory')
    expect(kinds['big.txt']).toBe('file')
    const big = listing.entries.find(entry => entry.name === 'big.txt') as WorkspaceFilesEntry
    expect(big.size).toBe(100 * 1024)
    expect(typeof big.mtimeMs).toBe('number')
    expect(listing.entries.find(entry => entry.name === '.env')?.hidden).toBe(true)
  })

  it('lists a subdirectory by path', async () => {
    const listing = await service.list(SESSION, join(root, 'src'))
    expect(listing.entries.map(entry => entry.name)).toEqual(['index.ts'])
    expect(listing.entries[0]?.kind).toBe('file')
  })

  it('follows an inner symlink to a directory', async () => {
    const listing = await service.list(SESSION, join(root, 'inner-link'))
    expect(listing.entries.map(entry => entry.name)).toEqual(['index.ts'])
  })

  it('cuts the level at maxEntries and flags the cut', async () => {
    const ctx = new Context()
    ctx.provide('sessions', { get: () => ({ header: { cwd: root } }) })
    const fiber = ctx.plugin(WorkspaceFiles, { maxEntries: 2, maxTextBytes: 16, maxImageBytes: 3_500_000 })
    await fiber.await()
    const bounded = ctx.get('workspaceFiles') as WorkspaceFiles
    try {
      const cut = await bounded.list(SESSION)
      expect(cut.entries.length).toBe(2)
      expect(cut.truncated).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects a symlink escaping the workspace', async () => {
    await expect(service.list(SESSION, join(root, 'escape'))).rejects.toMatchObject({ code: 'workspace-denied' })
  })

  it('rejects a relative path (never rebased under the process cwd)', async () => {
    await expect(service.list(SESSION, 'src')).rejects.toMatchObject({ code: 'workspace-denied' })
  })

  it('rejects a missing target and a missing session', async () => {
    await expect(service.list(SESSION, join(root, 'nope'))).rejects.toMatchObject({ code: 'workspace-not-found' })
    await expect(service.list('ghost' as SessionId, root)).rejects.toMatchObject({ code: 'workspace-session-not-found' })
    await expect(service.list('no-cwd' as SessionId, root)).rejects.toMatchObject({ code: 'workspace-session-without-cwd' })
  })
})

describe('readText', () => {
  it('reads a workspace text file with its full size', async () => {
    const file = await service.readText(SESSION, join(root, 'src', 'index.ts'))
    expect(file.content).toBe('export const x = 1\n')
    expect(file.totalBytes).toBe(19)
    expect(file.truncated).toBe(false)
  })

  it('truncates files beyond the byte cap and reports the full size', async () => {
    const file = await service.readText(SESSION, join(root, 'big.txt'))
    expect(file.content.length).toBe(64 * 1024)
    expect(file.totalBytes).toBe(100 * 1024)
    expect(file.truncated).toBe(true)
  })

  it('rejects a binary file (NUL byte) and a directory target', async () => {
    await expect(service.readText(SESSION, join(root, 'binary.bin'))).rejects.toMatchObject({ code: 'workspace-not-text' })
    await expect(service.readText(SESSION, join(root, 'src'))).rejects.toMatchObject({ code: 'workspace-not-found' })
  })

  it('refuses paths outside the workspace', async () => {
    await expect(service.readText(SESSION, join(outside, 'any.txt'))).rejects.toMatchObject({ code: 'workspace-not-found' })
  })
})

describe('image', () => {
  it('serves an allowlisted image with its extension content type and an ETag', async () => {
    const response = await service.image(SESSION, join(root, 'assets', 'logo.png'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe('4')
    const tag = response.headers.get('etag')
    expect(tag).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/)
    // A matching If-None-Match revalidates as 304.
    const cached = await service.image(SESSION, join(root, 'assets', 'logo.png'), undefined, tag ?? undefined)
    expect(cached.status).toBe(304)
  })

  it('rejects non-allowlisted extensions and oversized images', async () => {
    await expect(service.image(SESSION, join(root, 'big.txt'))).rejects.toMatchObject({ code: 'workspace-not-found' })
    const ctx = new Context()
    ctx.provide('sessions', { get: () => ({ header: { cwd: root } }) })
    const fiber = ctx.plugin(WorkspaceFiles, { maxEntries: 1000, maxTextBytes: 65536, maxImageBytes: 2 })
    await fiber.await()
    const capped = ctx.get('workspaceFiles') as WorkspaceFiles
    try {
      await expect(capped.image(SESSION, join(root, 'assets', 'logo.png'))).rejects.toMatchObject({ code: 'workspace-too-large' })
    } finally {
      await fiber.dispose()
    }
  })
})
