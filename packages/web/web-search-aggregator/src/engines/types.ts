/**
 * Shared engine-adapter value types for the backend registry.
 * @module @deepseek-ai/dsh-web-search-aggregator/engines/types
 */

/** Live credential getter for a commercial engine; resolved per call so a stored or rotated key needs no re-registration. */
export type KeyGetter = () => string | undefined
