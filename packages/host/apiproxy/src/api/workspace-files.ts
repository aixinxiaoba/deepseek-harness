/**
 * workspace-files domain contract: confined browsing of one session's
 * workspace for the UI files panel — listing, bounded text reads. The image
 * surface rides the carrier's no-envelope GET route (like the downloads
 * domain), so it is absent from this RPC interface; the panel addresses it by
 * URL. The browsing root is the session header's recorded cwd resolved
 * host-side: the client submits a session id and a candidate path, never a
 * root, and every path is confined beneath the canonical root before any
 * byte is read.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One row of a workspace-files listing. */
export interface WorkspaceFileEntryView {
  /** Base name within the listed directory. */
  readonly name: string
  /** Absolute host path — the client never joins path segments itself. */
  readonly path: string
  /** Directory, regular file (symlinks resolved by their target's kind), or neither. */
  readonly kind: 'directory' | 'file' | 'other'
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns display. */
  readonly hidden: boolean
  /** Size in bytes for regular files. */
  readonly size?: number
  /** Modification time in epoch milliseconds when the filesystem reports it. */
  readonly mtimeMs?: number
}

/** One workspace directory level. */
export interface WorkspaceFileListingView {
  /** Absolute path of the listed directory. */
  readonly path: string
  /** Child entries (files and directories), name-sorted. */
  readonly entries: readonly WorkspaceFileEntryView[]
  /** True when the level held more entries than the complete-result bound. */
  readonly truncated: boolean
}

/** A bounded text-file read. */
export interface WorkspaceTextFileView {
  /** Absolute path of the read file. */
  readonly path: string
  /** Decoded UTF-8 content head. */
  readonly content: string
  /** The file's full size in bytes. */
  readonly totalBytes: number
  /** True when the byte cap cut the read short. */
  readonly truncated: boolean
}

/**
 * Workspace-files unary methods (the map keys workspaceFiles.* of
 * RpcMethodMap). Both fail closed: an unknown session answers
 * `session-not-found`, a target outside the workspace `workspace-files-denied`.
 */
export interface WorkspaceFilesApi {
  /**
   * List one directory level of the session's workspace.
   * @param request - the session and an optional directory path; absent lists the workspace root.
   * @param signal - caller lifetime; abort stops the scan.
   */
  list(
    request: RpcRequest<{ sessionId: SessionId; path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<WorkspaceFileListingView>>

  /**
   * Read the bounded head of one text file in the session's workspace.
   * @param request - the session and the file path.
   * @param signal - caller lifetime.
   */
  readText(
    request: RpcRequest<{ sessionId: SessionId; path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<WorkspaceTextFileView>>

  /**
   * Serve one workspace image as a raw response. Host-only surface (no wire
   * envelope; the carrier's GET route answers it directly, like the downloads
   * domain) — the browser addresses the route by URL and is handed fetch-level
   * statuses, never this method.
   * @param request - the session, the image path, and an opaque cache-bust key.
   * @param signal - caller lifetime.
   * @param etag - the request's `If-None-Match`; a match answers 304.
   */
  image(
    request: { sessionId: SessionId; path: string; rev?: string },
    signal: AbortSignal,
    etag?: string,
  ): Promise<Response>
}
