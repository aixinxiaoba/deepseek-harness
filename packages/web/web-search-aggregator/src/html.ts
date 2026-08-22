/**
 * Defense-in-depth HTML helpers for keyless HTML-format engines (DuckDuckGo,
 * Mojeek). Extraction is deliberately regex-based and never throws on malformed
 * markup: a single changed span degrades to fewer results, not a crash, and the
 * aggregator still has live engines to fall back to.
 * @module @deepseek-ai/dsh-web-search-aggregator/html
 */

/** Decode the common HTML character entities (and numeric refs) in a string. */
export function decodeHtml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Strip HTML tags from a fragment (title / snippet). */
export function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Collapse a title/snippet fragment to clean text. */
export function cleanText(fragment: string): string {
  return decodeHtml(stripTags(fragment))
}

/** True when `value` parses as an absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * DuckDuckGo html endpoints wrap real targets in a `/l/?uddg=` redirect when
 * they are not the clean absolute URL; unwrap it.
 */
export function unwrapDdgRedirect(href: string): string {
  const absolute = href.startsWith('//') ? `https:${href}` : href
  if (!absolute.includes('uddg=')) return absolute
  try {
    const u = new URL(absolute)
    const target = u.searchParams.get('uddg')
    return target !== null && target.length > 0 ? target : href
  } catch {
    return href
  }
}
