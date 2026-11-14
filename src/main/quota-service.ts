import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { isAccountCli, resolveConfigDir, AccountCliId } from './account-env';
import { t } from './i18n';

export interface QuotaData {
  cliId: string;
  cliName: string;
  model?: string;
  effort?: string;              // 推理思考等级: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  planType?: string;
  tokens?: number;              // 最近活跃会话累计 token（输入 + 输出 + 缓存读写），无数据时缺省
  costUsd?: number;             // 最近活跃会话累计费用（美元），仅 Claude Code 提供
  fiveHourPercent: number;      // 5h remaining pct (0-100)
  fiveHourResetsIn: string;     // e.g. "2h 45m"
  sevenDayPercent: number;      // 7d remaining pct (0-100)
  sevenDayResetsOn: string;     // e.g. "Resets Sun"
  lastUpdated: number;
  status: 'normal' | 'warning' | 'critical' | 'offline';
  message?: string;
}

const CODEX_HOME_DEFAULT = path.join(os.homedir(), '.codex');
const CLAUDE_HOME_DEFAULT = path.join(os.homedir(), '.claude');
const KIMI_HOME_DEFAULT = path.join(os.homedir(), '.kimi-code');
const CLAUDE_STATUS_FILE = path.join(os.homedir(), '.config', 'oneai', 'claude-status.json');
const AGY_SETTINGS_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const PI_SETTINGS_FILE = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
const PI_MODELS_FILE = path.join(os.homedir(), '.pi', 'agent', 'models.json');
const PI_SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');

// claude-sonnet-5-5 -> Sonnet 5.5；别名 sonnet/opus/haiku 首字母大写
export function formatClaudeModel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  return /^[a-z]+$/.test(id) ? id[0].toUpperCase() + id.slice(1) : id;
}

function formatDuration(diffMs: number): string {
  if (diffMs <= 0) return '0m';
  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatResetDay(targetMs: number): string {
  if (!targetMs || targetMs <= Date.now()) return t('已重置');
  const date = new Date(targetMs);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = days[date.getDay()];
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `Resets ${dayName} ${hours}:${minutes}`;
}

export class QuotaService {
  private mainWindow: BrowserWindow | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private quotasCache: Record<string, QuotaData> = {};
  private cacheExpiry: Record<string, number> = {};
  private readonly CACHE_TTL_MS = 25000;
  private readonly AGY_USAGE_TTL_MS = 120000;
  private agyUsageRaw: string | null = null;
  private agyUsageAt = 0;
  private agyUsageError = '';
  private agyUsagePending: Promise<void> | null = null;
  // 多账号：key 为渲染进程里的账号 id，与默认账号（key 为 cliId）并列缓存、轮询和广播
  private accounts = new Map<string, { cliId: AccountCliId; dir: string }>();

  constructor() {
    const kimiInfo = this.getKimiInfo();
    const codexInfo = this.getCodexInfo();
    const claudeInfo = this.getClaudeInfo();
    const grokInfo = this.getGrokInfo();
    const opencodeInfo = this.getOpenCodeInfo();
    const agyInfo = this.getAgyInfo();
    const piInfo = this.getPiInfo();

    this.quotasCache = {
      kimi: {
        cliId: 'kimi',
        cliName: 'Kimi Code',
        model: kimiInfo.model,
        effort: kimiInfo.effort,
        planType: 'Kimi Coding',
        fiveHourPercent: 100,
        fiveHourResetsIn: '--',
        sevenDayPercent: 100,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
      },
      codex: {
        cliId: 'codex',
        cliName: 'Codex',
        model: codexInfo.model,
        effort: codexInfo.effort,
        planType: 'Plus',
        fiveHourPercent: 100,
        fiveHourResetsIn: '--',
        sevenDayPercent: 100,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
      },
      claude: {
        cliId: 'claude',
        cliName: 'Claude Code',
        model: claudeInfo.model,
        effort: claudeInfo.effort,
        planType: 'Pro',
        fiveHourPercent: 100,
        fiveHourResetsIn: '--',
        sevenDayPercent: 100,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
      },
      opencode: {
        cliId: 'opencode',
        cliName: 'OpenCode',
        model: opencodeInfo.model,
        effort: opencodeInfo.effort,
        fiveHourPercent: -1,
        fiveHourResetsIn: '--',
        sevenDayPercent: -1,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: t('无额度接口'),
      },
      pi: {
        cliId: 'pi',
        cliName: 'Pi',
        model: piInfo.model,
        effort: piInfo.effort,
        fiveHourPercent: -1,
        fiveHourResetsIn: '--',
        sevenDayPercent: -1,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: t('无额度接口'),
      },
      agy: {
        cliId: 'agy',
        cliName: 'Antigravity',
        model: agyInfo.model,
        effort: agyInfo.effort,
        fiveHourPercent: -1,
        fiveHourResetsIn: '--',
        sevenDayPercent: -1,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: t('无额度接口'),
      },
      grok: {
        cliId: 'grok',
        cliName: 'Grok Build',
        model: grokInfo.model,
        effort: grokInfo.effort,
        planType: 'xAI Premium',
        fiveHourPercent: 100,
        fiveHourResetsIn: '--',
        sevenDayPercent: 100,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
      },
      terminal: {
        cliId: 'terminal',
        cliName: t('系统终端'),
        model: process.platform === 'darwin' ? 'zsh / Shell' : 'PowerShell / CMD',
        planType: 'Local Shell',
        fiveHourPercent: 100,
        fiveHourResetsIn: '--',
        sevenDayPercent: 100,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: process.platform === 'darwin' ? 'Shell Ready' : 'PowerShell Ready',
      },
    };

    this.setupFileWatchers();
  }

  private setupFileWatchers(): void {
    const watchList: Array<{ filePath: string; cliId: string }> = [
      { filePath: path.join(os.homedir(), '.kimi-code', 'config.toml'), cliId: 'kimi' },
      { filePath: path.join(os.homedir(), '.codex', 'config.toml'), cliId: 'codex' },
      { filePath: path.join(os.homedir(), '.claude', 'settings.json'), cliId: 'claude' },
      { filePath: path.join(os.homedir(), '.claude.json'), cliId: 'claude' },
      { filePath: CLAUDE_STATUS_FILE, cliId: 'claude' },
      { filePath: path.join(os.homedir(), '.grok', 'settings_cache.json'), cliId: 'grok' },
      { filePath: path.join(os.homedir(), '.grok', 'models_cache.json'), cliId: 'grok' },
      { filePath: path.join(os.homedir(), '.grok', 'config.toml'), cliId: 'grok' },
      { filePath: path.join(os.homedir(), '.opencode', 'config.json'), cliId: 'opencode' },
      { filePath: AGY_SETTINGS_FILE, cliId: 'agy' },
      { filePath: PI_SETTINGS_FILE, cliId: 'pi' },
      { filePath: PI_MODELS_FILE, cliId: 'pi' },
    ];

    const debounceMap = new Map<string, NodeJS.Timeout>();

    for (const item of watchList) {
      try {
        if (fs.existsSync(item.filePath)) {
          fs.watch(item.filePath, () => {
            const prev = debounceMap.get(item.cliId);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
              this.refreshQuota(item.cliId);
            }, 300);
            debounceMap.set(item.cliId, t);
          });
        }
      } catch (err) {
        console.warn(`[QuotaService] Failed to watch ${item.filePath}:`, err);
      }
    }

    // pi 切换模型只追加会话 jsonl，监听会话目录以便即时刷新
    try {
      if (fs.existsSync(PI_SESSIONS_DIR)) {
        fs.watch(PI_SESSIONS_DIR, { recursive: true }, () => {
          const prev = debounceMap.get('pi');
          if (prev) clearTimeout(prev);
          debounceMap.set('pi', setTimeout(() => this.refreshQuota('pi'), 500));
        });
      }
    } catch (err) {
      console.warn('[QuotaService] Failed to watch pi sessions:', err);
    }
  }

  public setWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  public startPolling(intervalMs: number = 30000) {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }
    this.refreshAllQuotas();

    this.intervalTimer = setInterval(() => {
      this.refreshAllQuotas();
    }, intervalMs);
  }

  public stopPolling() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  public getQuota(cliId: string = 'kimi'): QuotaData {
    return this.quotasCache[cliId] || this.quotasCache['kimi'];
  }

  public getAllQuotas(): Record<string, QuotaData> {
    return this.quotasCache;
  }

  /** 同步账号列表：只保留有效账号，配置目录变化或已删除的账号丢弃旧缓存，然后立即刷新 */
  public setAccounts(list: Array<{ key: string; cliId: string; configDir: string }>): void {
    const next = new Map<string, { cliId: AccountCliId; dir: string }>();
    for (const item of list) {
      const dir = resolveConfigDir(item?.configDir);
      if (typeof item?.key === 'string' && item.key && isAccountCli(item.cliId) && dir) next.set(item.key, { cliId: item.cliId, dir });
    }
    for (const [key, old] of this.accounts) {
      if (next.get(key)?.dir !== old.dir) {
        delete this.quotasCache[key];
        delete this.cacheExpiry[key];
      }
    }
    this.accounts = next;
    void this.refreshAllQuotas();
  }

  public async refreshQuota(cliId?: string): Promise<Record<string, QuotaData>> {
    if (cliId && this.quotasCache[cliId]) {
      this.cacheExpiry[cliId] = 0;
      await this.fetchQuotaForCli(cliId);
      this.broadcast();
      return this.quotasCache;
    }
    return this.refreshAllQuotas();
  }

  public async refreshAllQuotas(): Promise<Record<string, QuotaData>> {
    const cliIds = ['kimi', 'codex', 'claude', 'opencode', 'agy', 'pi', 'grok', ...this.accounts.keys()];
    await Promise.allSettled(cliIds.map((id) => this.fetchQuotaForCli(id)));
    this.broadcast();
    return this.quotasCache;
  }

  private async fetchQuotaForCli(cliId: string): Promise<void> {
    const now = Date.now();
    if (this.cacheExpiry[cliId] && now < this.cacheExpiry[cliId]) {
      return;
    }

    try {
      let data: QuotaData | null = null;
      const account = this.accounts.get(cliId);
      switch (account ? account.cliId : cliId) {
        case 'kimi':
          data = await this.fetchKimiQuota(cliId, account?.dir);
          break;
        case 'codex':
          data = await this.fetchCodexQuota(cliId, account?.dir);
          break;
        case 'claude':
          data = await this.fetchClaudeQuota(account?.dir);
          break;
        case 'opencode':
          data = await this.fetchOpenCodeQuota();
          break;
        case 'pi':
          data = this.fetchPiQuota();
          break;
        case 'agy':
          data = await this.fetchAgyQuota();
          break;
        case 'grok':
          data = await this.fetchGrokQuota();
          break;
      }

      if (data) {
        this.quotasCache[cliId] = data;
        this.cacheExpiry[cliId] = now + this.CACHE_TTL_MS;
      }
    } catch (err) {
      console.error(`[QuotaService] Error fetching quota for ${cliId}:`, err);
    }
  }

  public getKimiInfo(home: string = KIMI_HOME_DEFAULT): { model: string; effort?: string } {
    const configPath = path.join(home, 'config.toml');
    if (!fs.existsSync(configPath)) {
      return { model: 'K3', effort: undefined };
    }

    let model = 'K3';
    let effort: string | undefined = undefined;

    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const defaultModelMatch = content.match(/default_model\s*=\s*["']([^"']+)["']/);
      const defaultModelKey = defaultModelMatch ? defaultModelMatch[1] : '';

      if (defaultModelKey) {
        const escapedKey = defaultModelKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sectionRegex = new RegExp(`\\[models\\."?${escapedKey}"?\\]([\\s\\S]*?)(?=\\n\\[|$)`);
        const sectionMatch = content.match(sectionRegex);
        if (sectionMatch) {
          const displayMatch = sectionMatch[1].match(/display_name\s*=\s*["']([^"']+)["']/);
          if (displayMatch && displayMatch[1]) {
            model = displayMatch[1];
          }
          const modelEffortMatch = sectionMatch[1].match(/default_effort\s*=\s*["']([^"']+)["']/);
          if (modelEffortMatch && modelEffortMatch[1]) {
            effort = modelEffortMatch[1];
          }
        }

        if (model === 'K3') {
          if (defaultModelKey.includes('highspeed')) model = 'K2.7 Highspeed';
          else if (defaultModelKey.includes('kimi-for-coding')) model = 'K2.8 Preview';
          else if (defaultModelKey.includes('k3')) model = 'K3';
          else model = defaultModelKey.split('/').pop() || defaultModelKey;
        }
      }

      // 优先从 [thinking] 块中提取全局设置的 effort（如 effort = "high"）
      const thinkingBlock = content.match(/\[thinking\]([\s\S]*?)(?=\n\[|$)/);
      if (thinkingBlock) {
        const ef = thinkingBlock[1].match(/effort\s*=\s*["']([^"']+)["']/);
        if (ef && ef[1]) {
          effort = ef[1];
        }
      }
    } catch (e) {
      console.warn('[QuotaService] Error parsing Kimi config:', e);
    }

    if (process.env.KIMI_EFFORT) effort = process.env.KIMI_EFFORT;

    return { model, effort };
  }

  public getCodexInfo(home: string = CODEX_HOME_DEFAULT): { model: string; effort?: string } {
    let model = 'Auto';
    let effort: string | undefined = undefined;
    const configPath = path.join(home, 'config.toml');
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf8');
        const mm = content.match(/model\s*=\s*["']([^"']+)["']/);
        if (mm && mm[1]) model = mm[1];
        const me = content.match(/model_reasoning_effort\s*=\s*["']([^"']+)["']/);
        if (me && me[1]) effort = me[1];
      } catch (e) {
        console.warn('[QuotaService] Error reading Codex config:', e);
      }
    }
    if (model === 'Auto' && process.env.CODEX_MODEL) {
      model = process.env.CODEX_MODEL;
    }
    if (!effort && process.env.CODEX_REASONING_EFFORT) {
      effort = process.env.CODEX_REASONING_EFFORT;
    }
    return { model, effort };
  }

  public getClaudeInfo(configDir?: string): { model: string; effort?: string } {
    let modelId = '';
    let settings: any = null;

    // 非默认账号只读它自己的 settings.json：statusLine 快照与 ~/.claude.json 都属于默认账号
    const settingsPath = path.join(configDir ?? CLAUDE_HOME_DEFAULT, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    }

    // 1. statusLine 落盘文件：会话内 /model、推理等级切换后立即更新，是唯一实时来源
    let statusEffort: string | undefined;
    if (!configDir) {
      try {
        const d = JSON.parse(fs.readFileSync(CLAUDE_STATUS_FILE, 'utf8'));
        modelId = d.model?.id || d.model?.display_name || '';
        if (typeof d.effort?.level === 'string') statusEffort = d.effort.level;
      } catch {}
    }

    // 2. settings.json / 环境变量
    if (!modelId && settings) {
      const m = settings.model ? String(settings.model) : '';
      modelId = settings.env?.[`ANTHROPIC_DEFAULT_${m.toUpperCase()}_MODEL`] || settings.env?.ANTHROPIC_MODEL || m;
    }
    if (!modelId && !configDir) modelId = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '';

    // 3. 兜底：~/.claude.json 中最近启动项目的 lastModelUsage。它是上一个已结束会话的用量统计，不随 /model 变化
    if (!modelId && !configDir) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
        const projs = Object.values(c.projects || {})
          .filter((v: any) => v && v.lastModelUsage && Object.keys(v.lastModelUsage).length > 0)
          .sort((x: any, y: any) => (y.lastStartTime || 0) - (x.lastStartTime || 0));
        if (projs.length > 0) {
          const keys = Object.keys((projs[0] as any).lastModelUsage).filter((k) => !/haiku/i.test(k));
          if (keys.length > 0) modelId = keys[keys.length - 1];
        }
      } catch {}
    }

    let effort: string | undefined = statusEffort || settings?.modelSettings?.[modelId]?.effortLevel;
    if (!effort) effort = settings?.effortLevel || settings?.effort;

    return { model: modelId ? formatClaudeModel(modelId) : 'Claude', effort };
  }

  public getGrokInfo(): { model: string; effort?: string } {
    let model = 'Grok 4.7';
    let effort: string | undefined = undefined;

    // 1. 优先读取 ~/.grok/config.toml 中用户的自定义配置与推理等级
    const grokConfig = path.join(os.homedir(), '.grok', 'config.toml');
    let configDefaultModel: string | undefined = undefined;
    if (fs.existsSync(grokConfig)) {
      try {
        const content = fs.readFileSync(grokConfig, 'utf8');
        const mm = content.match(/default\s*=\s*["']([^"']+)["']/);
        if (mm && mm[1]) configDefaultModel = mm[1];
        const me = content.match(/(?:default_)?reasoning_effort\s*=\s*["']([^"']+)["']/);
        if (me && me[1]) effort = me[1];
      } catch {}
    }

    // 2. 读取 ~/.grok/settings_cache.json
    const grokSettings = path.join(os.homedir(), '.grok', 'settings_cache.json');
    let defaultModelId = configDefaultModel || 'grok-4.7';
    if (fs.existsSync(grokSettings)) {
      try {
        const raw = JSON.parse(fs.readFileSync(grokSettings, 'utf8'));
        const payload = typeof raw.payload === 'string' ? JSON.parse(raw.payload) : raw.payload;
        if (!configDefaultModel && payload?.settings?.default_model) {
          defaultModelId = payload.settings.default_model;
        }
      } catch (e) {
        console.warn('[QuotaService] Error reading Grok settings_cache:', e);
      }
    }

    // 3. 查看 models_cache.json 获取友好名称与兜底 reasoning_effort
    const modelsCache = path.join(os.homedir(), '.grok', 'models_cache.json');
    if (fs.existsSync(modelsCache)) {
      try {
        const mc = JSON.parse(fs.readFileSync(modelsCache, 'utf8'));
        const targetModel = mc.models?.[defaultModelId] || Object.values(mc.models || {})[0];
        if (targetModel?.info) {
          if (targetModel.info.name) model = targetModel.info.name;
          if (!effort && targetModel.info.reasoning_effort) effort = targetModel.info.reasoning_effort;
        }
      } catch {}
    } else {
      model = defaultModelId;
    }

    if (process.env.GROK_MODEL) model = process.env.GROK_MODEL;
    if (process.env.XAI_MODEL) model = process.env.XAI_MODEL;
    if (process.env.GROK_REASONING_EFFORT) effort = process.env.GROK_REASONING_EFFORT;

    return { model, effort };
  }

  public getOpenCodeInfo(): { model: string; effort?: string } {
    let model = 'Auto';
    let effort: string | undefined = undefined;
    if (process.env.OPENCODE_MODEL) model = process.env.OPENCODE_MODEL;
    if (process.env.OPENCODE_EFFORT) effort = process.env.OPENCODE_EFFORT;
    const opencodeConfig = path.join(os.homedir(), '.opencode', 'config.json');
    if (fs.existsSync(opencodeConfig)) {
      try {
        const c = JSON.parse(fs.readFileSync(opencodeConfig, 'utf8'));
        if (c.model) model = c.model;
        if (c.effort || c.reasoning_effort) effort = c.effort || c.reasoning_effort;
      } catch {}
    }
    return { model, effort };
  }

  private piSessionCache: { file: string; offset: number; pending: Buffer; state: { provider?: string; modelId?: string; thinkingLevel?: string } } | null = null;

  /** 找到最近修改的 pi 会话文件，取其中最后一条 model_change / thinking_level_change；pi 的 /model 只写会话文件，不改 settings.json。 */
  private readPiSessionState(): { provider?: string; modelId?: string; thinkingLevel?: string } {
    try {
      let latest: { file: string; mtime: number } | null = null;
      for (const dir of fs.readdirSync(PI_SESSIONS_DIR)) {
        const dirPath = path.join(PI_SESSIONS_DIR, dir);
        let names: string[];
        try { names = fs.readdirSync(dirPath); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const file = path.join(dirPath, name);
          const mtime = fs.statSync(file).mtimeMs;
          if (!latest || mtime > latest.mtime) latest = { file, mtime };
        }
      }
      if (!latest) return {};
      // 会话文件只追加：记住已读到的位置，之后只读新增的部分，避免长会话每次刷新都整份重读
      let cache = this.piSessionCache;
      const size = fs.statSync(latest.file).size;
      if (!cache || cache.file !== latest.file || size < cache.offset) {
        cache = { file: latest.file, offset: 0, pending: Buffer.alloc(0), state: {} };
        this.piSessionCache = cache;
      }
      if (size > cache.offset) {
        const chunk = Buffer.alloc(size - cache.offset);
        const fd = fs.openSync(latest.file, 'r');
        let read = 0;
        try {
          read = fs.readSync(fd, chunk, 0, chunk.length, cache.offset);
        } finally {
          fs.closeSync(fd);
        }
        cache.offset += read;
        const data = Buffer.concat([cache.pending, chunk.subarray(0, read)]);
        // 末尾可能是还没写完的半行，留到下次再解析
        const lastNewline = data.lastIndexOf(0x0a);
        cache.pending = lastNewline < 0 ? data : data.subarray(lastNewline + 1);
        if (lastNewline >= 0) {
          for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
            if (!line.startsWith('{"type":"model_change"') && !line.startsWith('{"type":"thinking_level_change"')) continue;
            try {
              const e = JSON.parse(line);
              if (e.type === 'model_change') { cache.state.provider = e.provider; cache.state.modelId = e.modelId; }
              else cache.state.thinkingLevel = e.thinkingLevel;
            } catch {}
          }
        }
      }
      return cache.state;
    } catch {
      return {};
    }
  }

  /** 读取 pi 当前模型：优先取最近会话里的实际模型，没有会话时回退 settings.json 的 defaultModel；显示名取自 models.json。 */
  public getPiInfo(): { model: string; effort?: string } {
    let model = 'Auto';
    let effort: string | undefined = undefined;
    let provider: string | undefined;
    let modelId: string | undefined;
    try {
      const s = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8'));
      if (typeof s.defaultModel === 'string' && s.defaultModel) { modelId = s.defaultModel; provider = s.defaultProvider; }
      if (typeof s.defaultThinkingLevel === 'string' && s.defaultThinkingLevel) effort = s.defaultThinkingLevel;
    } catch {}
    const session = this.readPiSessionState();
    if (session.modelId) { modelId = session.modelId; provider = session.provider; }
    if (session.thinkingLevel) effort = session.thinkingLevel;
    if (modelId) {
      model = modelId;
      try {
        const providers = JSON.parse(fs.readFileSync(PI_MODELS_FILE, 'utf8')).providers || {};
        const list: any[] = (provider && providers[provider]?.models) || [];
        const hit = list.find((m) => m.id === modelId);
        if (hit?.name) model = hit.name;
      } catch {}
    }
    return { model, effort };
  }

  /** 读取 agy 当前模型，settings.json 中形如 "Gemini 4 Hydrogen (Medium)"，括号内为推理等级。 */
  public getAgyInfo(): { model: string; effort?: string } {
    let model = 'Auto';
    let effort: string | undefined = undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(AGY_SETTINGS_FILE, 'utf8')).model;
      if (typeof raw === 'string' && raw.trim()) {
        const m = raw.trim().match(/^(.*?)\s*\(([^)]+)\)$/);
        if (m) {
          model = m[1];
          effort = m[2].toLowerCase();
        } else {
          model = raw.trim();
        }
      }
    } catch {}
    return { model, effort };
  }

  private getKimiCurrentModel(): string {
    return this.getKimiInfo().model;
  }

  private getCodexCurrentModel(): string {
    return this.getCodexInfo().model;
  }

  private getClaudeCurrentModel(): string {
    return this.getClaudeInfo().model;
  }

  private getGrokCurrentModel(): string {
    return this.getGrokInfo().model;
  }

  private getOpenCodeCurrentModel(): string {
    return this.getOpenCodeInfo().model;
  }

  /** key 为缓存键（默认账号是 'kimi'），home 为该账号的 KIMI_CODE_HOME；账号读取失败时额度记为未知，不借用默认账号的缓存 */
  private async fetchKimiQuota(key: string = 'kimi', home: string = KIMI_HOME_DEFAULT): Promise<QuotaData> {
    const isAccount = home !== KIMI_HOME_DEFAULT;
    const credPath = path.join(home, 'credentials', 'kimi-code.json');
    const kimiInfo = this.getKimiInfo(home);
    const currentModel = kimiInfo.model;
    const currentEffort = kimiInfo.effort;

    if (!fs.existsSync(credPath)) {
      return {
        cliId: 'kimi',
        cliName: 'Kimi Code',
        model: currentModel,
        effort: currentEffort,
        fiveHourPercent: 0,
        fiveHourResetsIn: '--',
        sevenDayPercent: 0,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'offline',
        message: t('未找到 Kimi 凭证文件'),
      };
    }

    try {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const token = cred.access_token;
      if (!token) {
        throw new Error(t('access_token 不存在'));
      }

      const resData = await new Promise<any>((resolve, reject) => {
        const req = https.request('https://api.kimi.com/coding/v1/usages', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          timeout: 8000,
        }, (res) => {
          let chunks = '';
          res.on('data', (chunk) => (chunks += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(chunks));
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`Kimi API status ${res.statusCode}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Kimi API timeout'));
        });
        req.end();
      });

      const usages = resData.usages || {};
      const limit5h = usages.limit_5h || {};
      const limit7d = usages.limit_7d || {};

      // 接口未返回对应窗口时记为 -1，界面显示 "--"，避免把缺失数据误显示为 100%
      const toRemaining = (w: any): number =>
        typeof w.used_ratio === 'number' ? Math.max(0, Math.min(100, Math.round((1 - w.used_ratio) * 100))) : -1;
      const fiveHourPercent = toRemaining(limit5h);
      const sevenDayPercent = toRemaining(limit7d);

      let fiveHourResetsIn = fiveHourPercent < 0 ? '--' : t('已就绪');
      if (limit5h.reset_time) {
        const resetMs = new Date(limit5h.reset_time).getTime();
        const diff = resetMs - Date.now();
        if (diff > 0) fiveHourResetsIn = formatDuration(diff);
      }

      let sevenDayResetsOn = sevenDayPercent < 0 ? '--' : t('近期重置');
      if (limit7d.reset_time) {
        const resetMs = new Date(limit7d.reset_time).getTime();
        sevenDayResetsOn = formatResetDay(resetMs);
      }

      const known = [fiveHourPercent, sevenDayPercent].filter((p) => p >= 0);
      const minPct = known.length ? Math.min(...known) : 100;
      const status = minPct < 15 ? 'critical' : minPct < 40 ? 'warning' : 'normal';

      return {
        cliId: 'kimi',
        cliName: 'Kimi Code',
        model: currentModel,
        effort: currentEffort,
        planType: 'Kimi Coding',
        fiveHourPercent,
        fiveHourResetsIn,
        sevenDayPercent,
        sevenDayResetsOn,
        lastUpdated: Date.now(),
        status,
      };
    } catch (err: any) {
      console.warn('[QuotaService] Kimi fetch fallback:', err.message);
      return this.quotasCache[key] || {
        cliId: 'kimi',
        cliName: 'Kimi Code',
        model: currentModel,
        effort: currentEffort,
        fiveHourPercent: isAccount ? -1 : 100,
        fiveHourResetsIn: '--',
        sevenDayPercent: isAccount ? -1 : 100,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: isAccount ? t('额度读取失败：{reason}', { reason: err.message }) : undefined,
      };
    }
  }

  /** key 为缓存键（默认账号是 'codex'），home 为该账号的 CODEX_HOME；账号没有会话记录时额度记为未知而不是 100% */
  private async fetchCodexQuota(key: string = 'codex', home: string = CODEX_HOME_DEFAULT): Promise<QuotaData> {
    const isAccount = home !== CODEX_HOME_DEFAULT;
    const unknownPct = isAccount ? -1 : 100;
    const codexInfo = this.getCodexInfo(home);
    const currentModel = codexInfo.model;
    const currentEffort = codexInfo.effort;
    const codexSessionsDir = path.join(home, 'sessions');
    if (!fs.existsSync(codexSessionsDir)) {
      return {
        cliId: 'codex',
        cliName: 'Codex',
        model: currentModel,
        effort: currentEffort,
        planType: 'Plus',
        fiveHourPercent: unknownPct,
        fiveHourResetsIn: '--',
        sevenDayPercent: unknownPct,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: isAccount ? t('该账号暂无会话记录') : undefined,
      };
    }

    try {
      // 会话按 YYYY/MM/DD 目录存放：由新到旧遍历，凑够 10 个文件即停，避免每次全量扫描
      const MAX_SESSION_FILES = 10;
      const findRecentJsonl = (dir: string, depth = 0): string[] => {
        if (depth > 4) return [];
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
        const res: string[] = [];
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.jsonl')) res.push(path.join(dir, e.name));
        }
        const subDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
        for (const name of subDirs) {
          if (res.length >= MAX_SESSION_FILES) break;
          res.push(...findRecentJsonl(path.join(dir, name), depth + 1));
        }
        return res;
      };

      // 额度信息位于文件末尾，只读取尾部 256 KiB，避免整文件读入
      const TAIL_BYTES = 256 * 1024;
      const readTail = (file: string): string => {
        const fd = fs.openSync(file, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const length = Math.min(size, TAIL_BYTES);
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, size - length);
          return buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      };

      const files = findRecentJsonl(codexSessionsDir);
      const filesWithStats = files
        .map((f) => {
          try {
            return { path: f, mtime: fs.statSync(f).mtimeMs };
          } catch {
            return { path: f, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime);

      let foundRateLimits: any = null;
      let turnContext: { model?: string; effort?: string; at: number } | null = null;
      let planType = 'Plus';

      for (const item of filesWithStats.slice(0, 10)) {
        try {
          const content = readTail(item.path);
          const lines = content.split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line.includes('"turn_context"') && !turnContext) {
              try {
                const parsed = JSON.parse(line);
                if (parsed?.payload?.model) {
                  turnContext = {
                    model: parsed.payload.model,
                    effort: typeof parsed.payload.effort === 'string' ? parsed.payload.effort : undefined,
                    at: Date.parse(parsed.timestamp) || item.mtime,
                  };
                }
              } catch {}
            }
            if (line.includes('"rate_limits"') && !foundRateLimits) {
              try {
                const parsed = JSON.parse(line);
                const rl = parsed?.payload?.rate_limits;
                if (rl && (rl.primary || rl.secondary)) {
                  foundRateLimits = rl;
                  if (rl.plan_type) planType = rl.plan_type.toUpperCase();
                }
              } catch {}
            }
            if (foundRateLimits && turnContext) break;
          }
          if (foundRateLimits && turnContext) break;
        } catch {}
      }

      // 累计 token 只取最新会话文件的最后一条 token_count，新会话尚无记录时不显示
      let tokens: number | undefined;
      if (filesWithStats[0]) {
        try {
          for (const line of readTail(filesWithStats[0].path).split('\n').reverse()) {
            if (!line.includes('"total_token_usage"')) continue;
            try {
              const total = JSON.parse(line)?.payload?.info?.total_token_usage?.total_tokens;
              if (typeof total === 'number') { tokens = total; break; }
            } catch {}
          }
        } catch {}
      }

      // 会话内切换的模型与推理等级只记录在会话日志里：最近一轮比 config.toml 的修改时间新时以它为准，
      // 配置未写模型时也采用；之后又改过配置则仍以配置为准
      let model = currentModel;
      let effort = currentEffort;
      if (turnContext) {
        let configMtime = 0;
        try { configMtime = fs.statSync(path.join(home, 'config.toml')).mtimeMs; } catch {}
        if (turnContext.at > configMtime || model === 'Auto') {
          model = turnContext.model || model;
          effort = turnContext.effort || effort;
        }
      }

      if (foundRateLimits) {
        const primary = foundRateLimits.primary || {};
        const secondary = foundRateLimits.secondary || {};

        // 窗口已过重置时间说明额度已恢复，不再沿用日志里的旧占用
        const remaining = (w: any): number => {
          if (w.resets_at && w.resets_at * 1000 <= Date.now()) return 100;
          const used = typeof w.used_percent === 'number' ? w.used_percent : 0;
          return Math.max(0, Math.min(100, Math.round(100 - used)));
        };
        const fiveHourPercent = remaining(primary);
        const sevenDayPercent = remaining(secondary);

        let fiveHourResetsIn = t('已就绪');
        if (primary.resets_at) {
          const resetMs = primary.resets_at * 1000;
          const diff = resetMs - Date.now();
          if (diff > 0) fiveHourResetsIn = formatDuration(diff);
        }

        let sevenDayResetsOn = t('近期重置');
        if (secondary.resets_at) {
          const resetMs = secondary.resets_at * 1000;
          sevenDayResetsOn = formatResetDay(resetMs);
        }

        const minPct = Math.min(fiveHourPercent, sevenDayPercent);
        const status = minPct < 15 ? 'critical' : minPct < 40 ? 'warning' : 'normal';

        return {
          cliId: 'codex',
          cliName: 'Codex',
          model,
          effort,
          planType,
          tokens,
          fiveHourPercent,
          fiveHourResetsIn,
          sevenDayPercent,
          sevenDayResetsOn,
          lastUpdated: Date.now(),
          status,
        };
      }

      return {
        cliId: 'codex',
        cliName: 'Codex',
        model,
        effort,
        planType,
        tokens,
        fiveHourPercent: unknownPct,
        fiveHourResetsIn: '--',
        sevenDayPercent: unknownPct,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: isAccount ? t('该账号暂无额度记录') : undefined,
      };
    } catch (err: any) {
      console.warn('[QuotaService] Error parsing Codex sessions:', err.message);
      return this.quotasCache[key];
    }
  }

  private claudeTokenCache: { file: string; offset: number; pending: Buffer; perMessage: Map<string, number>; total: number } | null = null;

  /**
   * 累计 Claude Code 会话 token：快照里的 context_window 只是当前上下文大小，累计值要从会话记录算。
   * 同一条 assistant 消息会按内容块写成多行（usage 相同或递增），按 message.id + requestId 去重并以最后一行为准。
   * 只统计主会话记录，不含子代理的独立记录；会话文件只追加，按偏移增量读取并分片，避免大文件一次读入。
   */
  private readClaudeSessionTokens(file: string): number | undefined {
    try {
      const size = fs.statSync(file).size;
      let cache = this.claudeTokenCache;
      if (!cache || cache.file !== file || size < cache.offset) {
        cache = { file, offset: 0, pending: Buffer.alloc(0), perMessage: new Map(), total: 0 };
        this.claudeTokenCache = cache;
      }
      const SLICE = 8 * 1024 * 1024;
      const fd = fs.openSync(file, 'r');
      try {
        while (cache.offset < size) {
          const chunk = Buffer.alloc(Math.min(SLICE, size - cache.offset));
          const read = fs.readSync(fd, chunk, 0, chunk.length, cache.offset);
          if (read <= 0) break;
          cache.offset += read;
          const data = Buffer.concat([cache.pending, chunk.subarray(0, read)]);
          const lastNewline = data.lastIndexOf(0x0a);
          cache.pending = lastNewline < 0 ? data : data.subarray(lastNewline + 1);
          if (lastNewline < 0) continue;
          for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
            if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
            try {
              const e = JSON.parse(line);
              const u = e.message?.usage;
              if (e.type !== 'assistant' || !u) continue;
              const sum = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
              const key = `${e.message.id}:${e.requestId}`;
              cache.total += sum - (cache.perMessage.get(key) ?? 0);
              cache.perMessage.set(key, sum);
            } catch {}
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      return cache.total;
    } catch {
      return undefined;
    }
  }

  /** configDir 缺省为默认账号；非默认账号只显示模型与推理等级，额度来自共用的 statusLine 快照，无法区分账号，故显示「--」 */
  private async fetchClaudeQuota(configDir?: string): Promise<QuotaData> {
    const { model, effort } = this.getClaudeInfo(configDir);
    const base: QuotaData = {
      cliId: 'claude',
      cliName: 'Claude Code',
      model,
      effort,
      fiveHourPercent: -1,
      fiveHourResetsIn: '--',
      sevenDayPercent: -1,
      sevenDayResetsOn: '--',
      lastUpdated: Date.now(),
      status: 'normal',
    };

    if (configDir) return { ...base, message: t('非默认账号暂无额度数据') };

    // 额度来源：~/.claude/oneai-statusline.js 通过 Claude Code statusLine 写入的快照
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(CLAUDE_STATUS_FILE, 'utf8'));
    } catch {
      return { ...base, message: t('等待 Claude Code 会话数据') };
    }

    const rl = data.rate_limits || {};
    const now = Date.now();
    const calc = (w: any): { pct: number; resetMs?: number } => {
      if (!w || typeof w.used_percentage !== 'number') return { pct: -1 };
      const resetMs = w.resets_at ? w.resets_at * 1000 : undefined;
      // 窗口已过期说明已重置
      if (resetMs && resetMs < now) return { pct: 100 };
      return { pct: Math.max(0, Math.min(100, Math.round(100 - w.used_percentage))), resetMs };
    };
    const five = calc(rl.five_hour);
    const seven = calc(rl.seven_day);

    return {
      ...base,
      tokens: typeof data.transcript_path === 'string' ? this.readClaudeSessionTokens(data.transcript_path) : undefined,
      costUsd: typeof data.cost?.total_cost_usd === 'number' ? data.cost.total_cost_usd : undefined,
      fiveHourPercent: five.pct,
      fiveHourResetsIn: five.resetMs ? formatDuration(five.resetMs - now) : '--',
      sevenDayPercent: seven.pct,
      sevenDayResetsOn: seven.resetMs ? formatResetDay(seven.resetMs) : '--',
      status: Math.min(five.pct, seven.pct) >= 0 && Math.min(five.pct, seven.pct) < 10 ? 'critical' : 'normal',
      message: data.context_window?.used_percentage ? `Ctx: ${data.context_window.used_percentage}%` : undefined,
    };
  }

  private async fetchOpenCodeQuota(): Promise<QuotaData> {
    const opencodeInfo = this.getOpenCodeInfo();
    return {
      cliId: 'opencode',
      cliName: 'OpenCode',
      model: opencodeInfo.model,
      effort: opencodeInfo.effort,
      fiveHourPercent: -1,
      fiveHourResetsIn: '--',
      sevenDayPercent: -1,
      sevenDayResetsOn: '--',
      lastUpdated: Date.now(),
      status: 'normal',
      message: t('无额度接口'),
    };
  }

  // pi 是通用客户端，没有 5h / 7d 额度，只展示当前默认模型。
  private fetchPiQuota(): QuotaData {
    const piInfo = this.getPiInfo();
    return {
      cliId: 'pi',
      cliName: 'Pi',
      model: piInfo.model,
      effort: piInfo.effort,
      fiveHourPercent: -1,
      fiveHourResetsIn: '--',
      sevenDayPercent: -1,
      sevenDayResetsOn: '--',
      lastUpdated: Date.now(),
      status: 'normal',
      message: t('无额度接口'),
    };
  }

  /**
   * 通过 `agy -p /usage` 读取额度：输出为制表符分隔的「分组 / 窗口 / 剩余百分比 / 重置时间(UTC)」，
   * 不读取 agy 的凭据。单次约 5 秒，故独立节流并避免并发重复调用。
   */
  private async fetchAgyQuota(): Promise<QuotaData> {
    const agyInfo = this.getAgyInfo();
    const base = {
      cliId: 'agy',
      cliName: 'Antigravity',
      model: agyInfo.model,
      effort: agyInfo.effort,
    };
    const prev = this.quotasCache['agy'];
    const now = Date.now();
    if (this.agyUsageRaw === null || now - this.agyUsageAt >= this.AGY_USAGE_TTL_MS) {
      if (!this.agyUsagePending) {
        this.agyUsagePending = this.runAgyUsage()
          .then((raw) => {
            this.agyUsageRaw = raw;
            this.agyUsageError = '';
          })
          .catch((err: Error) => {
            this.agyUsageError = err.message;
          })
          .finally(() => {
            this.agyUsageAt = Date.now();
            this.agyUsagePending = null;
          });
      }
      await this.agyUsagePending;
    }

    if (this.agyUsageRaw === null) {
      return {
        ...base,
        fiveHourPercent: -1,
        fiveHourResetsIn: '--',
        sevenDayPercent: -1,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: 'normal',
        message: this.agyUsageError ? t('额度读取失败：{reason}', { reason: this.agyUsageError }) : t('额度读取中'),
      };
    }

    // Gemini 系列共用「Gemini Models」额度，其余（Claude / GPT）共用另一组
    const group = /gemini/i.test(agyInfo.model) ? 'Gemini Models' : 'Claude and GPT models';
    const pick = (label: RegExp): { pct: number; resetMs: number } => {
      for (const line of this.agyUsageRaw!.split(/\r?\n/)) {
        const [g, l, pct, reset] = line.split('\t');
        if (g === group && l && label.test(l)) {
          const n = parseInt(pct, 10);
          const t = new Date(reset).getTime();
          return { pct: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : -1, resetMs: Number.isFinite(t) ? t : 0 };
        }
      }
      return { pct: -1, resetMs: 0 };
    };
    const five = pick(/^Five Hour/i);
    const seven = pick(/^Weekly/i);
    const known = [five.pct, seven.pct].filter((x) => x >= 0);
    const minPct = known.length ? Math.min(...known) : 100;
    const fiveReset = five.resetMs - Date.now();

    return {
      ...base,
      planType: prev?.planType,
      fiveHourPercent: five.pct,
      fiveHourResetsIn: five.pct < 0 ? '--' : fiveReset > 0 ? formatDuration(fiveReset) : t('已就绪'),
      sevenDayPercent: seven.pct,
      sevenDayResetsOn: seven.pct < 0 ? '--' : seven.resetMs ? formatResetDay(seven.resetMs) : t('近期重置'),
      lastUpdated: this.agyUsageAt,
      status: minPct < 15 ? 'critical' : minPct < 40 ? 'warning' : 'normal',
      message: this.agyUsageError ? t('额度刷新失败：{reason}', { reason: this.agyUsageError }) : undefined,
    };
  }

  private runAgyUsage(): Promise<string> {
    const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
    const bin = fs.existsSync(local) ? local : 'agy';
    return new Promise((resolve, reject) => {
      execFile(bin, ['-p', '/usage'], { cwd: os.homedir(), windowsHide: true, timeout: 30000 }, (err, stdout) => {
        if (err) return reject(new Error(err.message.split('\n')[0]));
        if (!stdout.includes('\t')) return reject(new Error(t('输出中没有额度数据')));
        resolve(stdout);
      });
    });
  }

  private async fetchGrokQuota(): Promise<QuotaData> {
    try {
      const grokInfo = this.getGrokInfo();
      const hasApiKey = !!(process.env.XAI_API_KEY || process.env.GROK_API_KEY);
      const xaiDir = path.join(os.homedir(), '.xai');
      const grokDir = path.join(os.homedir(), '.grok');
      const hasConfig = fs.existsSync(xaiDir) || fs.existsSync(grokDir);

      return {
        cliId: 'grok',
        cliName: 'Grok Build',
        model: grokInfo.model,
        effort: grokInfo.effort,
        planType: 'xAI Premium',
        fiveHourPercent: 100,
        fiveHourResetsIn: '--',
        sevenDayPercent: 100,
        sevenDayResetsOn: '--',
        lastUpdated: Date.now(),
        status: hasApiKey || hasConfig ? 'normal' : 'normal',
        message: hasApiKey ? 'API Key Active' : 'Ready',
      };
    } catch {
      return this.quotasCache['grok'];
    }
  }

  private broadcast() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('quota:update', this.quotasCache);
    }
  }
}

export const quotaService = new QuotaService();
