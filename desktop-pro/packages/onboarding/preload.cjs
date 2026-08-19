/**
 * Onboarding preload — the ONLY preload bridge in the product, scoped to the
 * first-run setup window alone. The main UI carrier stays preload-free and
 * sandboxed (ADR-3); this window needs exactly one capability: persist the
 * operator's choices.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshPro', {
  /**
   * Persist the onboarding choices (empty string = leave unchanged).
   * @param {{apiKey: string, updateUrl: string}} config
   */
  save: (config) => ipcRenderer.invoke('dsh-pro:onboarding-save', config),
  /** Close the onboarding window. */
  finish: () => ipcRenderer.invoke('dsh-pro:onboarding-finish'),
})
