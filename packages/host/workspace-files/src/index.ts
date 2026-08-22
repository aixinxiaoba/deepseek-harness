/**
 * Workspace-scoped file browsing service: the host-side primitives behind the
 * web UI's workspace files panel. The browsing root is the SESSION's recorded
 * project directory — resolved host-side from the session header, never
 * accepted from a client — and every list/read is confined beneath that root
 * by canonical-path containment (`realpath` + filesystem identity), so a
 * symlink escaping the workspace cannot smuggle a read. Listings are bounded
 * and flag truncation; text reads are byte-capped with binary rejection;
 * image serving is extension-allowlisted and size-capped. mtime is not
 * exposed on the `ctx.fs` seam, so this backend talks to `node:fs/promises`
 * directly, like the directory-picker browse backend before it.
 * @module @deepseek-ai/dsh-host-workspace-files
 */

import { open, opendir, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isPathUnder } from '@deepseek-ai/dsh-fs-sandbox'
import { fullyQualified, raceAbort } from '@deepseek-ai/dsh-host-directory-picker-browse'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceFiles: WorkspaceFiles
  }
}

/** One row of a workspace listing: a child file, directory, or other entry. */
export interface WorkspaceFilesEntry {
  /** Base name within the listed directory. */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Directory, regular file (symlinks resolved by their target's kind), or neither. */
  kind: 'directory' | 'file' | 'other'
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns display. */
  hidden: boolean
  /** Size in bytes for regular files (after symlink resolution). */
  size?: number
  /** Modification time in epoch milliseconds when the filesystem reports it. */
  mtimeMs?: number
}

/** One workspace directory level, as the files panel consumes it. */
export interface WorkspaceFileListing {
  /** Absolute path of the listed directory. */
  path: string
  /** Child entries (files and directories), name-sorted. */
  entries: WorkspaceFilesEntry[]
  /** True when the level held more entries than the complete-result bound. */
  truncated: boolean
}

/** A bounded text-file read. */
export interface WorkspaceTextFile {
  /** Absolute path of the read file. */
  path: string
  /** Decoded UTF-8 content; at most {@link Config.maxTextBytes} bytes worth. */
  content: string
  /** The file's full size in bytes. */
  totalBytes: number
  /** True when the byte cap cut the read short. */
  truncated: boolean
}

/** Closed failure vocabulary of the workspace-files primitives. */
export type WorkspaceFilesErrorCode =
  | 'workspace-session-not-found'
  | 'workspace-session-without-cwd'
  | 'workspace-denied'
  | 'workspace-not-found'
  | 'workspace-not-text'
  | 'workspace-too-large'
  | 'workspace-unreadable'

/** Typed failure so consumers map business codes without string matching. */
export class WorkspaceFilesError extends Error {
  /**
   * @param code - closed business code of the failure.
   * @param path - the path the failure is about (session id for session-level codes).
   * @param message - operator-facing description.
   */
  constructor(readonly code: WorkspaceFilesErrorCode, readonly path: string, message: string) {
    super(message)
    this.name = 'WorkspaceFilesError'
  }
}

/** Image extension allowlist mapped to response content types; never guessed from bytes. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level (hidden rows count toward it). */
  maxEntries: number
  /** Byte cap of one text read; longer files return truncated. */
  maxTextBytes: number
  /** Byte cap of one served image; larger files fail with workspace-too-large. */
  maxImageBytes: number
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/** True when a node:fs rejection means the target does not exist. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The `ctx.workspaceFiles` service. Stateless per call: every method resolves
 * the session's canonical workspace root, confines the target beneath it, and
 * performs one bounded filesystem round trip.
 */
export default class WorkspaceFiles extends Service {
  /**
   * `maxEntries` bounds one listing level (GitHub's web UI truncates at 1,000);
   * `maxTextBytes` caps a preview read (64 KiB); `maxImageBytes` caps a served
   * image (3.5 MiB, matching the attachment store's image ceiling).
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
    maxTextBytes: z.natural().min(1).default(64 * 1024),
    maxImageBytes: z.natural().min(1).default(3_500_000),
  })

  static inject = ['sessions']

  /** @param ctx - host context carrying the sessions service. @param config - validated configuration. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'workspaceFiles')
  }

  /**
   * Resolve the canonical browsing root of one session: the recorded project
   * directory, canonicalized by realpath so later containment compares
   * filesystem identities, not spellings.
   * @param sessionId - the session whose workspace is browsed.
   * @returns the canonical absolute root.
   */
  private async rootOf(sessionId: SessionId): Promise<string> {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new WorkspaceFilesError('workspace-session-not-found', sessionId, `session "${sessionId}" not found (not attached)`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined || !fullyQualified(cwd)) {
      throw new WorkspaceFilesError('workspace-session-without-cwd', sessionId, `session "${sessionId}" records no fully qualified project directory`)
    }
    try {
      return await realpath(resolve(cwd))
    } catch (error: unknown) {
      throw new WorkspaceFilesError('workspace-not-found', cwd, `workspace ${cwd} is unreachable: ${messageOf(error)}`)
    }
  }

  /**
   * Confine one candidate target beneath a canonical root. The candidate must
   * be fully qualified (never rebased under the process cwd), must exist
   * (realpath), and must sit beneath the root by lexical or
   * filesystem-identity comparison — a symlink pointing outside the workspace
   * resolves outside and is denied here, before any byte is read.
   * @param root - canonical workspace root.
   * @param path - client-supplied candidate path.
   * @param signal - caller lifetime for the containment walk.
   * @returns the candidate's canonical absolute path.
   */
  private async confine(root: string, path: string, signal?: AbortSignal): Promise<string> {
    if (!fullyQualified(path)) {
      throw new WorkspaceFilesError('workspace-denied', path, `"${path}" is not a fully qualified path`)
    }
    let canonical: string
    try {
      canonical = await raceAbort(realpath(resolve(path)), signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isMissing(error)) {
        throw new WorkspaceFilesError('workspace-not-found', path, `${path} does not exist`)
      }
      throw new WorkspaceFilesError('workspace-unreadable', path, `cannot reach ${path}: ${messageOf(error)}`)
    }
    if (!(await raceAbort(isPathUnder(canonical, root), signal))) {
      throw new WorkspaceFilesError('workspace-denied', path, `${path} resolves outside the session workspace`)
    }
    return canonical
  }

  /**
   * List one directory level of a session's workspace.
   * @param sessionId - the session whose workspace is browsed.
   * @param path - directory to list; absent lists the workspace root.
   * @param signal - caller lifetime; abort stops the scan.
   * @returns the level's entries, name-sorted, bounded with a truncation flag.
   */
  async list(sessionId: SessionId, path?: string, signal?: AbortSignal): Promise<WorkspaceFileListing> {
    const root = await this.rootOf(sessionId)
    const target = path === undefined ? root : await this.confine(root, path, signal)
    const info = await raceAbort(stat(target), signal).catch((error: unknown) => {
      signal?.throwIfAborted()
      throw new WorkspaceFilesError('workspace-not-found', target, `${target} does not exist or is not a directory: ${messageOf(error)}`)
    })
    if (!info.isDirectory()) {
      throw new WorkspaceFilesError('workspace-not-found', target, `${target} is not a directory`)
    }
    const entries: WorkspaceFilesEntry[] = []
    let truncated = false
    try {
      const level = await raceAbort(opendir(target), signal)
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          const entryPath = join(target, dirent.name)
          let kind: WorkspaceFilesEntry['kind'] = 'other'
          let size: number | undefined
          let mtimeMs: number | undefined
          try {
            // stat (not lstat): a symlink's row reports its target's shape, so
            // the panel can offer directory expansion / preview consistently;
            // the read paths re-confine anyway, so an escaping link is denied
            // at access time, not hidden at listing time.
            const entryInfo = await raceAbort(stat(entryPath), signal)
            if (entryInfo.isDirectory()) kind = 'directory'
            else if (entryInfo.isFile()) {
              kind = 'file'
              size = entryInfo.size
              mtimeMs = entryInfo.mtimeMs
            }
          } catch {
            // Broken symlink or racing deletion: keep the row as 'other'.
          }
          if (entries.length === this.config.maxEntries) {
            truncated = true
            break
          }
          entries.push({ name: dirent.name, path: entryPath, kind, hidden: dirent.name.startsWith('.'), ...size !== undefined ? { size } : {}, ...mtimeMs !== undefined ? { mtimeMs } : {} })
        }
      } finally {
        const closing = level.close()
        /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
        if (signal?.aborted) {
          closing.catch(() => {})
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new WorkspaceFilesError('workspace-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { path: target, entries, truncated }
  }

  /**
   * Read the bounded head of one text file in the session workspace. A NUL
   * byte in the read window marks the file binary (the readWholeText rule);
   * longer-than-cap files return their head with `truncated`.
   * @param sessionId - the session whose workspace is browsed.
   * @param path - the file to read.
   * @param signal - caller lifetime.
   * @returns the decoded head, the full size, and the truncation flag.
   */
  async readText(sessionId: SessionId, path: string, signal?: AbortSignal): Promise<WorkspaceTextFile> {
    const root = await this.rootOf(sessionId)
    const target = await this.confine(root, path, signal)
    const info = await raceAbort(stat(target), signal).catch((error: unknown) => {
      signal?.throwIfAborted()
      throw new WorkspaceFilesError('workspace-not-found', target, `${target} does not exist: ${messageOf(error)}`)
    })
    if (!info.isFile()) {
      throw new WorkspaceFilesError('workspace-not-found', target, `${target} is not a regular file`)
    }
    const cap = this.config.maxTextBytes
    const handle = await raceAbort(open(target, 'r'), signal).catch((error: unknown) => {
      signal?.throwIfAborted()
      throw new WorkspaceFilesError('workspace-unreadable', target, `cannot open ${target}: ${messageOf(error)}`)
    })
    try {
      const buffer = Buffer.alloc(Math.min(cap, info.size))
      if (buffer.length > 0) {
        await raceAbort(handle.read(buffer, 0, buffer.length, 0), signal)
      }
      // A NUL byte in the window is the binary marker (fsio's readWholeText rule).
      if (buffer.includes(0)) {
        throw new WorkspaceFilesError('workspace-not-text', target, `${target} is not a text file`)
      }
      return { path: target, content: buffer.toString('utf8'), totalBytes: info.size, truncated: info.size > cap }
    } finally {
      /* v8 ignore next 2 -- a close failure of an abandoned handle has no consumer. */
      await handle.close().catch(() => {})
    }
  }

  /**
   * Serve one image file of the session workspace as a fetch `Response`. The
   * extension allowlist fixes the content type (bytes are never sniffed), the
   * stat size must fit the cap before any byte is read, and the response
   * carries an ETag (mtime+size) with `If-None-Match` honored as 304 — so a
   * reopened preview revalidates instead of re-downloading.
   * @param sessionId - the session whose workspace is browsed.
   * @param path - the image file to serve.
   * @param signal - caller lifetime.
   * @param etag - the request's `If-None-Match` value; a match yields a 304.
   * @returns the fetch response (200/304; 413-shaped failures throw {@link WorkspaceFilesError}).
   */
  async image(sessionId: SessionId, path: string, signal?: AbortSignal, etag?: string): Promise<Response> {
    const root = await this.rootOf(sessionId)
    const target = await this.confine(root, path, signal)
    const contentType = IMAGE_TYPES[extname(target).toLowerCase()]
    if (contentType === undefined) {
      throw new WorkspaceFilesError('workspace-not-found', target, `${target} is not a previewable image`)
    }
    const info = await raceAbort(stat(target), signal).catch((error: unknown) => {
      signal?.throwIfAborted()
      throw new WorkspaceFilesError('workspace-not-found', target, `${target} does not exist: ${messageOf(error)}`)
    })
    if (!info.isFile()) {
      throw new WorkspaceFilesError('workspace-not-found', target, `${target} is not a regular file`)
    }
    if (info.size > this.config.maxImageBytes) {
      throw new WorkspaceFilesError('workspace-too-large', target, `${target} exceeds the preview image cap`)
    }
    const tag = `"${Math.trunc(info.mtimeMs).toString(36)}-${info.size.toString(36)}"`
    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-length': String(info.size),
      'etag': tag,
      'cache-control': 'private, max-age=3600',
    }
    if (etag !== undefined && etag === tag) {
      return new Response(null, { status: 304, headers })
    }
    const handle = await raceAbort(open(target, 'r'), signal).catch((error: unknown) => {
      signal?.throwIfAborted()
      throw new WorkspaceFilesError('workspace-unreadable', target, `cannot open ${target}: ${messageOf(error)}`)
    })
    try {
      const stream = Readable.toWeb(handle.createReadStream({ start: 0, end: Math.max(0, info.size - 1) })) as ReadableStream<Uint8Array>
      return new Response(stream, { status: 200, headers })
    } catch (error: unknown) {
      /* v8 ignore next 3 -- wrapping can only fail on a stream-construction fault after a successful open. */
      await handle.close().catch(() => {})
      throw new WorkspaceFilesError('workspace-unreadable', target, `cannot read ${target}: ${messageOf(error)}`)
    }
  }
}
