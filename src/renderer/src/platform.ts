/** macOS reports MacIntel even on Apple Silicon; this detects both architectures. */
export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
export const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);

export function primaryModifierPressed(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function macShortcut(text: string): string {
  return isMac ? text.replace(/Ctrl(\s*)\+(\s*)/g, (_match, before, after) => `⌘${before}+${after}`) : text;
}
