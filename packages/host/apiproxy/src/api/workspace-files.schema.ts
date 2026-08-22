/**
 * workspace-files domain zod schemas (names derived from map keys:
 * workspaceFilesListRequestSchema / workspaceFilesListValueSchema). The
 * GET image route's query schema lives here too, mirroring downloads.schema:
 * query params are all strings, parsed into the route's exact request shape.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'
import type { WorkspaceFileEntryView } from './workspace-files.ts'

/** WorkspaceFileEntryView row of workspaceFiles.list. */
export const workspaceFileEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: z.union([z.literal('directory'), z.literal('file'), z.literal('other')]),
  hidden: z.boolean(),
  size: z.number().nonnegative().optional(),
  mtimeMs: z.number().optional(),
}) satisfies z.ZodType<Wire<WorkspaceFileEntryView>>

/** workspaceFiles.list request payload. */
export const workspaceFilesListRequestSchema = z.object({
  sessionId: sessionIdSchema,
  path: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspaceFiles.list'>>>

/** workspaceFiles.list response value. */
export const workspaceFilesListValueSchema = z.object({
  path: z.string().min(1),
  entries: z.array(workspaceFileEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspaceFiles.list'>>>

/** workspaceFiles.readText request payload. */
export const workspaceFilesReadTextRequestSchema = z.object({
  sessionId: sessionIdSchema,
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'workspaceFiles.readText'>>>

/** workspaceFiles.readText response value. */
export const workspaceFilesReadTextValueSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  totalBytes: z.number().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspaceFiles.readText'>>>

/**
 * `/api/workspace.file` query params → the image route's request. `rev` is the
 * client's cache-bust key (the listing's mtimeMs): opaque to the server, it
 * only forces a distinct URL when a file changes so the private max-age cache
 * cannot serve a stale image. ETag revalidation rides the standard
 * `If-None-Match` header instead.
 */
export const workspaceFileQuerySchema = z.object({
  sessionId: sessionIdSchema,
  path: z.string().min(1),
  rev: z.string().min(1).optional(),
})
