/**
 * workspace-files carrier path: the POST unary routes validate payloads and
 * map WorkspaceFilesError onto the wire vocabulary, and the no-envelope GET
 * image route parses its query, honors If-None-Match, and answers HEAD with
 * headers only. The filesystem behavior itself is covered by the service
 * package's own suite; the domain here is a scripted fake.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceFilesError } from '@deepseek-ai/dsh-host-workspace-files'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

/** The scripted workspace-files domain: canned outcomes per target path. */
const fakeDomain = {
  async list(sessionId: SessionId) {
    return {
      path: '/proj',
      entries: [{ name: 'a.ts', path: '/proj/a.ts', kind: 'file' as const, hidden: false, size: 3, mtimeMs: 1000 }],
      truncated: false,
      sessionId,
    }
  },
  async readText(sessionId: SessionId, path: string) {
    if (path === '/proj/denied.txt') throw new WorkspaceFilesError('workspace-denied', path, 'outside')
    if (path === '/proj/bin.dat') throw new WorkspaceFilesError('workspace-not-text', path, 'binary')
    return { path, content: 'abc', totalBytes: 3, truncated: false, sessionId }
  },
  async image(_sessionId: SessionId, path: string, _signal?: AbortSignal, etag?: string) {
    if (path === '/proj/gone.png') throw new WorkspaceFilesError('workspace-not-found', path, 'missing')
    if (path === '/proj/big.png') throw new WorkspaceFilesError('workspace-too-large', path, 'huge')
    if (path === '/proj/secret.png') throw new WorkspaceFilesError('workspace-denied', path, 'outside')
    if (etag === '"fresh"') return new Response(null, { status: 304 })
    return new Response('pngbytes', {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '8', 'etag': '"fresh"' },
    })
  },
}

async function buildApi(): Promise<ApiProxy> {
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceFiles', fakeDomain as never)
  return createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
}

async function post(api: ApiProxy, method: string, payload: unknown): Promise<Response> {
  const handler = toFetchHandler(api)
  return handler.fetch(`http://host/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }),
  })
}

async function get(api: ApiProxy, query: string, headers?: Record<string, string>): Promise<Response> {
  const handler = toFetchHandler(api)
  return handler.fetch(`http://host/api/workspace.file?${query}`, { method: 'GET', ...headers !== undefined ? { headers } : {} })
}

describe('workspaceFiles unary routes', () => {
  it('lists a workspace level through the envelope', async () => {
    const api = await buildApi()
    const response = await post(api, 'workspaceFiles.list', { sessionId: sid('s1') })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { ok: boolean; value?: { path: string } } }
    expect(body.result.ok).toBe(true)
    expect(body.result.value?.path).toBe('/proj')
  })

  it('maps service failures onto the workspace-files-* error codes', async () => {
    const api = await buildApi()
    const denied = await post(api, 'workspaceFiles.readText', { sessionId: sid('s1'), path: '/proj/denied.txt' })
    const body = await denied.json() as { result: { ok: boolean; error?: { code: string } } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('workspace-files-denied')

    const binary = await post(api, 'workspaceFiles.readText', { sessionId: sid('s1'), path: '/proj/bin.dat' })
    const binaryBody = await binary.json() as { result: { error?: { code: string } } }
    expect(binaryBody.result.error?.code).toBe('workspace-files-not-text')
  })

  it('rejects an invalid payload with bad-request', async () => {
    const api = await buildApi()
    const response = await post(api, 'workspaceFiles.list', { sessionId: '' })
    const body = await response.json() as { result: { ok: boolean; error?: { code: string } } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('bad-request')
  })
})

describe('/api/workspace.file GET route', () => {
  it('serves an image with its content type and etag', async () => {
    const api = await buildApi()
    const response = await get(api, `sessionId=s1&path=${encodeURIComponent('/proj/a.png')}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('pngbytes')
  })

  it('answers a matching If-None-Match with the service 304', async () => {
    const api = await buildApi()
    const response = await get(api, `sessionId=s1&path=${encodeURIComponent('/proj/a.png')}`, { 'if-none-match': '"fresh"' })
    expect(response.status).toBe(304)
  })

  it('answers HEAD with status and headers only', async () => {
    const api = await buildApi()
    const handler = toFetchHandler(api)
    const response = await handler.fetch(`http://host/api/workspace.file?sessionId=s1&path=${encodeURIComponent('/proj/a.png')}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"fresh"')
    expect(await response.text()).toBe('')
  })

  it('rejects a bad query with 400 and an unknown method with 404', async () => {
    const api = await buildApi()
    expect((await get(api, 'sessionId=')).status).toBe(400)
    const response = await post(api, 'workspaceFiles.nothing', {})
    expect(response.status).toBe(404)
  })

  it('maps service failures to fetch statuses (404/413/403)', async () => {
    const api = await buildApi()
    expect((await get(api, `sessionId=s1&path=${encodeURIComponent('/proj/gone.png')}`)).status).toBe(404)
    expect((await get(api, `sessionId=s1&path=${encodeURIComponent('/proj/big.png')}`)).status).toBe(413)
    expect((await get(api, `sessionId=s1&path=${encodeURIComponent('/proj/secret.png')}`)).status).toBe(403)
  })
})
