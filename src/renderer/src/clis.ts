import { CliDef } from './types';
import { t } from './i18n';

/** 没有活动任务、也没有保存过文件夹时，新任务默认使用的文件夹：本机用户主目录（由主进程提供） */
export function defaultWorkspacePath(): string {
  try { return window.electronAPI?.getHomeDir?.() || ''; } catch { return ''; }
}

/** 内置 CLI 定义（绑定各 AI CLI 的真实执行命令），顺序即默认菜单顺序 */
export const BUILTIN_CLIS: CliDef[] = [
  { id: 'codex', name: 'Codex', icon: 'codex', defaultCommand: 'codex' },
  { id: 'claude', name: 'Claude Code', icon: 'claude', defaultCommand: 'claude' },
  { id: 'kimi', name: 'Kimi Code', icon: 'kimi', defaultCommand: 'kimi' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', defaultCommand: 'opencode' },
  { id: 'grok', name: 'Grok Build', icon: 'grok', defaultCommand: 'grok' },
  // 空命令由主进程选择本机默认 Shell（Windows PowerShell / macOS zsh 等）。
  { id: 'terminal', get name() { return t('系统终端'); }, icon: 'terminal', defaultCommand: '' },
];
