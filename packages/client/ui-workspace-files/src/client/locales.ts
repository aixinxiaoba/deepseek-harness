/**
 * Panel copy: one key union plus the complete zh/en dictionaries. Keys are
 * the namespace's typed domain (the LocaleNamespaceMap merge in index.ts);
 * templates use `{name}` placeholders.
 */

/** The panel's dictionary key domain. */
export type WorkspaceFilesLocaleKey =
  | 'entry.label'
  | 'drawer.title'
  | 'drawer.empty'
  | 'drawer.close'
  | 'tree.label'
  | 'tree.loading'
  | 'tree.empty'
  | 'tree.truncated'
  | 'tree.showHidden'
  | 'preview.loading'
  | 'preview.truncated'
  | 'preview.imageAlt'
  | 'preview.lightbox.close'
  | 'preview.binary'
  | 'preview.tooLarge'
  | 'preview.denied'
  | 'preview.missing'
  | 'preview.unreadable'
  | 'error.access'
  | 'size.bytes'
  | 'size.kb'
  | 'size.mb'

/** Chinese dictionary. */
export const zh: Record<WorkspaceFilesLocaleKey, string> = {
  'entry.label': '工作空间文件',
  'drawer.title': '工作空间文件',
  'drawer.empty': '当前没有打开的会话，无法浏览工作空间。',
  'drawer.close': '关闭',
  'tree.label': '工作空间文件树',
  'tree.loading': '加载中…',
  'tree.empty': '此目录为空。',
  'tree.truncated': '条目过多，仅显示开头部分。',
  'tree.showHidden': '显示隐藏文件',
  'preview.loading': '读取中…',
  'preview.truncated': '文件较大，仅显示开头部分。',
  'preview.imageAlt': '图片预览',
  'preview.lightbox.close': '关闭',
  'preview.binary': '该文件不是文本文件，无法预览。',
  'preview.tooLarge': '该文件超出预览大小上限。',
  'preview.denied': '该文件不在当前工作空间内，无法预览。',
  'preview.missing': '文件不存在或已被移动。',
  'preview.unreadable': '读取该文件失败。',
  'error.access': '无法读取该目录。',
  'size.bytes': '{size} B',
  'size.kb': '{size} KB',
  'size.mb': '{size} MB',
}

/** English dictionary. */
export const en: Record<WorkspaceFilesLocaleKey, string> = {
  'entry.label': 'Workspace files',
  'drawer.title': 'Workspace files',
  'drawer.empty': 'No session is open, so there is no workspace to browse.',
  'drawer.close': 'Close',
  'tree.label': 'Workspace file tree',
  'tree.loading': 'Loading…',
  'tree.empty': 'This directory is empty.',
  'tree.truncated': 'Too many entries to list; only the beginning is shown.',
  'tree.showHidden': 'Show hidden files',
  'preview.loading': 'Reading…',
  'preview.truncated': 'Large file; only the beginning is shown.',
  'preview.imageAlt': 'Image preview',
  'preview.lightbox.close': 'Close',
  'preview.binary': 'This file is not text and cannot be previewed.',
  'preview.tooLarge': 'This file exceeds the preview size cap.',
  'preview.denied': 'This file is outside the current workspace and cannot be previewed.',
  'preview.missing': 'The file does not exist or was moved.',
  'preview.unreadable': 'Reading this file failed.',
  'error.access': 'This directory cannot be read.',
  'size.bytes': '{size} B',
  'size.kb': '{size} KB',
  'size.mb': '{size} MB',
}
