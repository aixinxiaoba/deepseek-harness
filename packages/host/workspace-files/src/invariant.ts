/**
 * Package-owned invariant companion for the workspace-files service.
 * @module @deepseek-ai/dsh-host-workspace-files/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-workspace-files'

/** Cordis companion plugin name. */
export const name = 'host-workspace-files-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: each list/read is one stateless confined filesystem round trip; the filesystem is the authoritative state. */
const install: InvariantInstaller = () => {}

/**
 * Register the workspace-files invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
