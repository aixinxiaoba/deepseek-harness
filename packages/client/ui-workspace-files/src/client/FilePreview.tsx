/**
 * One selected file's preview. Images render natively (`<img src>` pointing
 * at the Host's no-envelope GET route, click opens a local zoom overlay);
 * text files render through the primitives ReadBlock (line numbers +
 * extension-hinted highlighting). Every failure maps its Host business code
 * to a localized notice instead of an error bar.
 */
import { useEffect, useState } from 'react'
import { ReadBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IWorkspaces, SessionId, WorkspaceFileEntryView, WorkspaceTextFileView } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceFilesBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { isImageEntry } from './inject.ts'
import css from './WorkspaceFiles.module.css'

/** The per-line character cap mirrors the read tool's own render bound. */
const PREVIEW_MAX_LINE_LENGTH = 2000

/** Preview phases: loading, a rendered kind, or a mapped failure. */
type PreviewState =
  | { status: 'loading' }
  | { status: 'image'; src: string; alt: string }
  | { status: 'text'; file: WorkspaceTextFileView; lines: ReadBlockLine[]; lang: string }
  | { status: 'error'; kind: 'binary' | 'tooLarge' | 'denied' | 'missing' | 'unreadable' }

/** Project a wire failure code onto the notice vocabulary. */
function errorKindOf(error: WorkspaceFilesBrowseError): Extract<PreviewState, { status: 'error' }>['kind'] {
  switch (error.rpcError.code) {
    case 'workspace-files-not-text': return 'binary'
    case 'workspace-files-too-large': return 'tooLarge'
    case 'workspace-files-denied': return 'denied'
    case 'workspace-files-not-found': return 'missing'
    default: return 'unreadable'
  }
}

/** Split a text head into ReadBlock lines with the per-line cap applied. */
function windowLinesOf(content: string): ReadBlockLine[] {
  const rows = content.split('\n')
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return rows.map((text, index) => ({ number: index + 1, text: text.length > PREVIEW_MAX_LINE_LENGTH ? `${text.slice(0, PREVIEW_MAX_LINE_LENGTH)}…` : text }))
}

/** The entry's extension as a highlight grammar hint (unknown = plain). */
function langOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

/**
 * Viewport-fixed zoom overlay for the previewed image: scrim click and
 * Escape close, the image centers at natural size capped to the viewport.
 * Local on purpose — the attachment package's lightbox is internal to its
 * own surface, and this panel keeps no cross-package UI reach.
 * @param props.src - the image URL. @param props.alt - accessible label. @param props.onClose - dismiss.
 * @returns the overlay element.
 */
function ImageZoom({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  return (
    <div className={css.zoomRoot} role="dialog" aria-label={alt} onClick={onClose}>
      <img className={css.zoomImage} src={src} alt={alt} />
    </div>
  )
}

/** Preview props: the selected entry, the session, the wire service, and locale. */
export interface FilePreviewProps {
  /** The session whose workspace is browsed. */
  sessionId: SessionId
  /** The selected file row. */
  entry: WorkspaceFileEntryView
  /** The wire-facing workspace service. */
  workspaces: IWorkspaces
  /** Locale bound to the panel namespace. */
  t: TranslateNS<'workspace-files'>
}

/**
 * Render one file's preview.
 * @param props - see {@link FilePreviewProps}.
 * @returns the preview element.
 */
export function FilePreview({ sessionId, entry, workspaces, t }: FilePreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [zoomed, setZoomed] = useState(false)

  // Images address the GET route directly (no read RPC); the rev key comes
  // from the listing row so a changed file is a changed URL.
  useEffect(() => {
    setState({ status: 'loading' })
    if (isImageEntry(entry.path)) {
      setState({ status: 'image', src: workspaces.workspaceFileImageUrl(sessionId, entry.path, entry.mtimeMs), alt: entry.name })
      return
    }
    const controller = new AbortController()
    void workspaces.readWorkspaceText(sessionId, entry.path, controller.signal)
      .then((file) => {
        if (controller.signal.aborted) return
        setState({ status: 'text', file, lines: windowLinesOf(file.content), lang: langOf(entry.path) })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState(error instanceof WorkspaceFilesBrowseError
          ? { status: 'error', kind: errorKindOf(error) }
          : { status: 'error', kind: 'unreadable' })
      })
    return () => { controller.abort() }
  }, [sessionId, entry.path, entry.mtimeMs, entry.name, workspaces])

  return (
    <div className={css.preview}>
      {state.status === 'loading' && <div className={css.previewNotice}>{t('preview.loading')}</div>}
      {state.status === 'image' && (
        <div className={css.previewImageWrap}>
          <img
            className={css.previewImage}
            src={state.src}
            alt={state.alt}
            loading="lazy"
            onClick={() => { setZoomed(true) }}
          />
          {zoomed && <ImageZoom src={state.src} alt={state.alt} onClose={() => { setZoomed(false) }} />}
        </div>
      )}
      {state.status === 'text' && (
        <>
          {state.file.truncated && <div className={css.previewNotice}>{t('preview.truncated')}</div>}
          <ReadBlock
            label={entry.name}
            lines={state.lines}
            totalLines={state.lines.length}
            lang={state.lang}
            className={css.previewRead}
          />
        </>
      )}
      {state.status === 'error' && (
        <div className={css.previewNotice}>
          {t(state.kind === 'binary'
            ? 'preview.binary'
            : state.kind === 'tooLarge'
              ? 'preview.tooLarge'
              : state.kind === 'denied'
                ? 'preview.denied'
                : state.kind === 'missing'
                  ? 'preview.missing'
                  : 'preview.unreadable')}
        </div>
      )}
    </div>
  )
}
