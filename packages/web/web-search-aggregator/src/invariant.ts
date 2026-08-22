/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-web-search-aggregator`.
 * @module @deepseek-ai/dsh-web-search-aggregator/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-aggregator'

/** Cordis companion plugin name. */
export const name = 'web-search-aggregator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the aggregator is a pure provider of transient network
 * results — there is no later authoritative event to relate a dispatch to.
 * Engine-failover honesty is pinned at the provider boundary instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
