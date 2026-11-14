import { Account, SessionAccount } from './types';
import { t } from './i18n';
import { isWindows } from './platform';

/** 支持多账号的 CLI：id 即 CliDef.id。登录命令在该账号的环境下于终端任务中运行。 */
export const ACCOUNT_CLIS: Array<{
  id: Account['cliId'];
  name: string;
  envVar: string;
  loginCommand: string;
}> = [
  { id: 'codex', name: 'Codex', envVar: 'CODEX_HOME', loginCommand: 'codex login' },
  { id: 'claude', name: 'Claude Code', envVar: 'CLAUDE_CONFIG_DIR', loginCommand: 'claude auth login' },
  { id: 'kimi', name: 'Kimi Code', envVar: 'KIMI_CODE_HOME', loginCommand: 'kimi login' },
];

/** 本机用户主目录（由主进程提供），读取失败时退回 ~ */
export function homeDir(): string {
  try { return window.electronAPI?.getHomeDir?.() || '~'; } catch { return '~'; }
}

const DEFAULT_DIR_NAMES: Record<Account['cliId'], string> = { codex: '.codex', claude: '.claude', kimi: '.kimi-code' };

/** 各 CLI 默认账号的配置目录：本机主目录下的约定位置，用于设置页展示 */
export function defaultConfigDir(cliId: Account['cliId']): string {
  return `${homeDir()}${isWindows ? '\\' : '/'}${DEFAULT_DIR_NAMES[cliId]}`;
}

/** 新账号配置目录的示例路径：主目录下与默认目录并列 */
export function exampleConfigDir(cliId: Account['cliId'], suffix = 'alt'): string {
  return `${homeDir()}${isWindows ? '\\' : '/'}${DEFAULT_DIR_NAMES[cliId]}-${suffix}`;
}

export function accountCli(id: string) {
  return ACCOUNT_CLIS.find((cli) => cli.id === id);
}

/** 额度、状态等按「键」缓存：账号用账号 id，默认账号用分组 id */
export function quotaKey(groupId: string, accountId?: string): string {
  return accountId || groupId;
}

/** 解析附加环境变量文本：每行 KEY=VALUE，空行与 # 开头的行忽略 */
export function parseEnvLines(text: string | undefined): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const [index, raw] of (text || '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { env, error: t('第 {n} 行不是 KEY=VALUE 格式', { n: index + 1 }) };
    env[key] = line.slice(eq + 1).trim();
  }
  return { env };
}

export function toSessionAccount(account: Account): SessionAccount {
  return { cliId: account.cliId, configDir: account.configDir.trim(), env: parseEnvLines(account.env).env };
}

/** 读取已保存的账号列表时过滤掉结构不完整的条目 */
export function sanitizeAccounts(value: unknown): Account[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Account => Boolean(item)
    && typeof item.id === 'string' && item.id.length > 0
    && ACCOUNT_CLIS.some((cli) => cli.id === item.cliId)
    && typeof item.name === 'string' && typeof item.configDir === 'string');
}

/** 设置页保存账号前的校验，返回错误文字；通过时返回空字符串 */
export function validateAccount(draft: Pick<Account, 'cliId' | 'name' | 'configDir' | 'env'>, others: Account[]): string {
  const name = draft.name.trim();
  const dir = draft.configDir.trim();
  if (!name) return t('请填写账号名称。');
  if (others.some((a) => a.cliId === draft.cliId && a.name.trim().toLowerCase() === name.toLowerCase())) return t('同一 CLI 下已有同名账号。');
  if (!dir) return t('请填写配置目录。');
  if (!/^(~([\\/]|$)|[A-Za-z]:[\\/]|\\\\|\/)/.test(dir)) return t('配置目录必须是绝对路径（如 {example}），或以 ~ 开头。', { example: exampleConfigDir(draft.cliId) });
  const normalize = (p: string) => isWindows
    ? p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
    : p.replace(/\/+$/, '');
  if (others.some((a) => a.cliId === draft.cliId && normalize(a.configDir) === normalize(dir))) return t('该目录已被同一 CLI 的另一个账号使用。');
  const parsed = parseEnvLines(draft.env);
  if (parsed.error) return t('附加环境变量：{reason}', { reason: parsed.error });
  return '';
}
