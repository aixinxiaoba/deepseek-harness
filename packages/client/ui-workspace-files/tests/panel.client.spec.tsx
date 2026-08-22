// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId, WorkspaceFileEntryView, WorkspaceFileListingView } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceFilesBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceFilesPanelController } from '../src/client/controller.ts'
import { WorkspaceFilesDrawer } from '../src/client/WorkspaceFilesDrawer.tsx'
import { WorkspaceFilesButton } from '../src/client/WorkspaceFilesButton.tsx'
import { en, type WorkspaceFilesLocaleKey } from '../src/client/locales.ts'
// Type-only: pulls this package's LocaleNamespaceMap merge into the program
// so DrawerProps['t'] resolves to the typed seat.
import type {} from '../src/client/index.ts'

afterEach(cleanup)

const SID = 's1' as SessionId
const ROOT = '/proj'

/** Two-level fixture tree with a hidden file, a text file, and an image. */
const TREE: Record<string, WorkspaceFileListingView> = {
  [ROOT]: {
    path: ROOT,
    truncated: false,
    entries: [
      { name: '.env', path: `${ROOT}/.env`, kind: 'file', hidden: true, size: 8, mtimeMs: 1 },
      { name: 'logo.png', path: `${ROOT}/logo.png`, kind: 'file', hidden: false, size: 64, mtimeMs: 500 },
      { name: 'src', path: `${ROOT}/src`, kind: 'directory', hidden: false },
    ],
  },
  [`${ROOT}/src`]: {
    path: `${ROOT}/src`,
    truncated: false,
    entries: [
      { name: 'index.ts', path: `${ROOT}/src/index.ts`, kind: 'file', hidden: false, size: 19, mtimeMs: 2 },
    ],
  },
}

interface FakeOptions {
  list?: (path?: string) => Promise<WorkspaceFileListingView>
  read?: (path: string) => Promise<{ path: string; content: string; totalBytes: number; truncated: boolean }>
}

function fakeWorkspaces(options: FakeOptions = {}) {
  return {
    listWorkspaceFiles: vi.fn(async (_session: SessionId, path?: string) => {
      if (options.list !== undefined) return await options.list(path)
      const listing = TREE[path ?? ROOT]
      if (listing === undefined) {
        throw new WorkspaceFilesBrowseError({ code: 'workspace-files-not-found', message: 'missing', details: { path: path ?? ROOT } })
      }
      return listing
    }),
    readWorkspaceText: vi.fn(async (_session: SessionId, path: string) => {
      if (options.read !== undefined) return await options.read(path)
      if (path === `${ROOT}/src/index.ts`) return { path, content: 'export const x = 1\n', totalBytes: 19, truncated: false }
      throw new WorkspaceFilesBrowseError({ code: 'workspace-files-not-found', message: 'missing', details: { path } })
    }),
    workspaceFileImageUrl: vi.fn((session: SessionId, path: string, rev?: number | string) =>
      `/api/workspace.file?sessionId=${session}&path=${encodeURIComponent(path)}${rev === undefined ? '' : `&rev=${rev}`}`),
  }
}

type DrawerProps = Parameters<typeof WorkspaceFilesDrawer>[0]
const t = ((key: WorkspaceFilesLocaleKey) => en[key]) as DrawerProps['t']

interface SessionsFeed {
  ids: SessionId[]
  byId: Record<string, { cwd?: string }>
  current: SessionId | undefined
}

function feedOf(cwd: string | undefined): SessionsFeed {
  return cwd === undefined
    ? { ids: [], byId: {}, current: undefined }
    : { ids: [SID], byId: { [SID]: { cwd } }, current: SID }
}

function mountDrawer(feed: SessionsFeed, options: FakeOptions = {}, open = true) {
  const controller = new WorkspaceFilesPanelController()
  if (open) controller.toggle()
  const workspaces = fakeWorkspaces(options)
  const props = {
    controller,
    workspaces,
    t,
    useSessions: ((selector: (feed: unknown) => unknown) => selector(feed)) as DrawerProps['useSessions'],
  } as unknown as DrawerProps
  const view = render(<WorkspaceFilesDrawer {...props} />)
  return { view, controller, workspaces }
}

describe('WorkspaceFilesDrawer', () => {
  it('renders nothing while closed and lists the workspace root when open', async () => {
    mountDrawer(feedOf(ROOT), {}, false)
    expect(screen.queryByRole('dialog')).toBeNull()

    const drawer = mountDrawer(feedOf(ROOT))
    await waitFor(() => { expect(screen.getByRole('treeitem', { name: /src/ })).toBeTruthy() })
    expect(drawer.workspaces.listWorkspaceFiles).toHaveBeenCalledWith(SID, ROOT, expect.any(AbortSignal))
    expect(screen.queryByText('.env')).toBeNull()
  })

  it('lazily loads a subdirectory on expand and previews a text file with its content', async () => {
    const drawer = mountDrawer(feedOf(ROOT))
    await waitFor(() => { expect(screen.getByRole('treeitem', { name: /src/ })).toBeTruthy() }, { timeout: 4000 })
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
    await waitFor(() => { expect(screen.getByRole('treeitem', { name: /index\.ts/ })).toBeTruthy() }, { timeout: 4000 })
    expect(drawer.workspaces.listWorkspaceFiles).toHaveBeenCalledWith(SID, `${ROOT}/src`, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('treeitem', { name: /index\.ts/ }))
    // ReadBlock splits one line across highlight spans, so no single leaf
    // carries the whole text — assert some node's full text matches.
    await waitFor(() => {
      expect(screen.getAllByText((_, node) => node?.textContent === 'export const x = 1').length).toBeGreaterThan(0)
    }, { timeout: 4000 })
  })

  it('previews an image through the GET route URL with the mtime rev key', async () => {
    mountDrawer(feedOf(ROOT))
    fireEvent.click(await screen.findByRole('treeitem', { name: /logo\.png/ }))
    const img = await waitFor(() => screen.getByAltText('logo.png') as HTMLImageElement)
    expect(img.src).toContain('/api/workspace.file?')
    expect(img.src).toContain(encodeURIComponent(`${ROOT}/logo.png`))
    expect(img.src).toContain('rev=500')
  })

  it('maps the binary refusal to a localized notice', async () => {
    const binaryListing: WorkspaceFileListingView = {
      path: ROOT,
      truncated: false,
      entries: [
        { name: 'binary.bin', path: `${ROOT}/binary.bin`, kind: 'file', hidden: false, size: 3, mtimeMs: 3 },
      ],
    }
    mountDrawer(feedOf(ROOT), {
      list: async () => binaryListing,
      read: async (path) => {
        throw new WorkspaceFilesBrowseError({ code: 'workspace-files-not-text', message: 'binary', details: { path } })
      },
    })
    fireEvent.click(await screen.findByRole('treeitem', { name: /binary\.bin/ }))
    await waitFor(() => { expect(screen.getByText(en['preview.binary'])).toBeTruthy() })
  })

  it('shows the empty state without a current session and closes on Escape', () => {
    mountDrawer(feedOf(undefined))
    expect(screen.getByText(en['drawer.empty'])).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('WorkspaceFilesButton', () => {
  it('toggles the shared controller', () => {
    const controller = new WorkspaceFilesPanelController()
    const props = { wide: false, controller, t } as unknown as Parameters<typeof WorkspaceFilesButton>[0]
    render(<WorkspaceFilesButton {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en['entry.label'] }))
    expect(controller.getSnapshot().open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['entry.label'] }))
    expect(controller.getSnapshot().open).toBe(false)
  })
})

/** Entry-shape guard kept close to the fixture: rows stay readonly views. */
export type FixtureEntry = WorkspaceFileEntryView
