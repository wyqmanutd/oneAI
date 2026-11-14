export type TaskStatus = 'starting' | 'running' | 'idle' | 'waiting' | 'stopped' | 'error';

export interface TaskSession {
  id: string;              // 任务唯一ID（对应底层的 ptyId）
  groupId: string;         // 所属 CLI 的 ID（对应 CliDef.id）
  title: string;           // 任务名称，例如 "Task 1: Auth Refactor"
  status: TaskStatus;      // 运行状态
  cwd: string;             // 执行工作目录
  command?: string;        // 该任务使用的启动命令
  errorMessage?: string;   // 启动失败原因
  historyId?: string;      // 由历史会话恢复时的 CLI 会话 ID
  accountId?: string;      // 使用的账号配置 ID（AppSettings.accounts），缺省为 CLI 的默认账号
  createdAt: number;       // 创建时间戳
}

/** 多账号：每个账号是一个独立的 CLI 配置目录（登录凭据与会话记录都在其中），目前支持 Codex、Claude Code 与 Kimi Code */
export interface Account {
  id: string;
  cliId: 'codex' | 'claude' | 'kimi';
  name: string;
  configDir: string;       // 绝对路径；Codex 对应 CODEX_HOME，Claude Code 对应 CLAUDE_CONFIG_DIR，Kimi Code 对应 KIMI_CODE_HOME
  env?: string;            // 附加环境变量，每行 KEY=VALUE
}

/** 传给主进程的账号：附加环境变量已解析为键值对 */
export interface SessionAccount {
  cliId: Account['cliId'];
  configDir: string;
  env?: Record<string, string>;
}

export interface LoginStatus {
  loggedIn: boolean | null;  // null：无法判断
  detail?: string;           // 如 Claude 返回的邮箱
}

export interface HistoryEntry {
  id: string;
  cliId: 'claude' | 'codex' | 'kimi';
  title: string;
  cwd: string;
  updatedAt: number;
  command: string;
}

/** CLI 定义：图标、默认命令；任务按其 groupId（即 CLI id）关联到这里 */
export interface CliDef {
  id: string;              // 如 "codex", "kimi", "opencode", "claude", "grok", "terminal"
  name: string;            // 显示名称，如 "Codex", "Kimi Code"
  icon: string;            // 品牌专属 Logo，未内置的 CLI 回退为通用终端图标
  defaultCommand: string;  // 默认拉起命令模版
  custom?: boolean;        // 自定义 CLI：完整命令交给当前平台的 Shell 解析
}

/** 用户自定义的 CLI（AppSettings.customClis）：名称与完整启动命令，没有品牌图标，用通用终端图标 */
export interface CustomCli {
  id: string;
  name: string;
  command: string;         // 完整启动命令，可带参数，如 `mycli --model x`
}

/** 侧栏中的一个工作文件夹；任务按 cwd 归属到文件夹，文件夹按此数组顺序显示 */
export interface FolderEntry {
  path: string;            // 首次出现时的原始路径（保留大小写），比较时用 folderKey 归一化
  isExpanded: boolean;
}

// 具体主题 id；bean 豆沙绿、parchment 羊皮纸、dusk 暖夜、nord 北极灰蓝为护眼主题；
// 其余为编辑器配色：darcula、material（Sublime Material），以及 Sublime Text 内置的 monokai、mariana、breakers、solarized-dark、solarized-light、cobalt，以及 IntelliJ IDEA 自带的 idea-classic-light、idea-light、idea-dark、idea-contrast，以及 Kiro IDE 的 kiro-dark、kiro-light
export type ThemeId =
  | 'light' | 'dark' | 'bean' | 'parchment' | 'dusk' | 'nord'
  | 'darcula' | 'material' | 'monokai' | 'mariana' | 'breakers' | 'solarized-dark' | 'solarized-light' | 'cobalt'
  | 'idea-classic-light' | 'idea-light' | 'idea-dark' | 'idea-contrast'
  | 'kiro-dark' | 'kiro-light';

export interface AppSettings {
  language: 'zh-CN' | 'en'; // 界面语言：首次启动按系统语言预选，在首次引导里确认，之后可在设置 → 外观 切换
  onboardingDone: boolean; // 首次引导（选择语言、认识各入口）是否已完成；完成后不再弹出
  theme: 'system' | ThemeId; // 应用主题，默认跟随系统（仅在 light / dark 间切换）
  voiceReminderEnabled: boolean; // 工作满提醒时长时是否语音播报
  workReminderHours: number; // 工作时长提醒的间隔小时数，默认 1（1 ~ 12 的整数）
  terminalFontSize: number;   // 终端代码字体大小 (12 ~ 24, 默认 15)
  terminalLineHeight: number; // 终端行高 (1.2 ~ 1.6, 默认 1.3)
  uiScale: 'compact' | 'standard' | 'comfortable' | 'large'; // 界面全局字体缩放
  terminalCursorStyle: 'bar' | 'block' | 'underline'; // 终端光标样式 (默认 'bar')
  terminalCursorBlink: boolean; // 终端光标闪烁 (默认 true)
  previewMinimap: boolean; // 文件预览面板右侧是否显示代码缩略图（minimap），默认 true
  musicDirectory: string; // 顶栏音乐播放目录，空字符串表示系统「音乐」目录
  musicPlayerVisible: boolean; // 侧栏底部是否显示音乐播放器，默认 true
  clockOffsetHours: number; // 顶栏时钟相对系统时间增加的小时数，默认 0（-24 ~ 24 的整数）
  topbarDateVisible: boolean; // 窗口最大化时顶栏时钟是否显示年月日（含农历）与星期，默认 true
  accounts: Account[]; // 多账号配置（Codex / Claude Code / Kimi Code），默认空；「恢复默认设置」不会清空
  customClis: CustomCli[]; // 用户自定义的 CLI，默认空；「恢复默认设置」不会清空
}

export interface QuotaData {
  cliId: string;                 // 'kimi' | 'codex' | 'claude' | 'opencode' | 'grok'
  cliName: string;               // 'Kimi Code' | 'Codex' | 'Grok' ...
  model?: string;                // 如 'deepseek-v4-pro' | 'gpt-5.5'
  effort?: string;               // 推理思考等级: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  planType?: string;             // 如 'Plus' | 'Pro'
  tokens?: number;               // 最近活跃会话累计 token，无数据时缺省
  costUsd?: number;              // 最近活跃会话累计费用（美元），仅 Claude Code 提供
  fiveHourPercent: number;       // 5小时配额剩余百分比（0-100）
  fiveHourResetsIn: string;      // 5小时配额重置倒计时（例如 "2h 45m"）
  sevenDayPercent: number;       // 7天配额剩余百分比（0-100）
  sevenDayResetsOn: string;      // 7天配额重置日（例如 "Resets Sun"）
  lastUpdated: number;           // 最后更新时间戳
  status: 'normal' | 'warning' | 'critical' | 'offline';
  message?: string;
}

export type UsageCli = 'claude' | 'codex' | 'agy' | 'pi';

/** 本周某个 CLI 下某个模型的用量 */
export interface UsageRow {
  cliId: UsageCli;
  accountId: string;   // OneAI 账号 id；默认账号为 'default'
  accountName: string; // 账号名，默认账号为「默认账号」
  model: string;
  requests: number;   // 请求数：一次模型回复算一次
  sessions: number;   // 本周内出现过该模型回复的会话数
  subagent?: boolean; // CLI 自动发起的子会话（如 Codex 自动审查），不是用户选用的模型
  input: number;      // 未命中缓存的输入 tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageDay {
  date: string;       // 本地日期 YYYY-MM-DD
  requests: number;
  by: Record<string, number>; // 键为 `${cliId}:${accountId}`，值为当天该 CLI 账号的请求数
}

export interface UsageAccountInfo { cliId: UsageCli; accountId: string; name: string }

export interface UsageStats {
  generatedAt: number;
  weekStart: number;  // 本周周一 00:00（本地时间）
  accounts: UsageAccountInfo[]; // 统计范围内出现过用量的 CLI 账号
  rows: UsageRow[];
  days: UsageDay[];   // 周一对齐、连续，到本周周日为止
}

export interface SystemStats {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netUpBytesPerSec: number | null;
  netDownBytesPerSec: number | null;
}

export interface ElectronTerminalAPI {
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  /** 关闭窗口时仍有终端进程在运行，主进程请求界面确认；参数为运行中的进程数 */
  onWindowCloseRequest?: (callback: (aliveCount: number) => void) => () => void;
  confirmWindowClose?: () => void;
  cancelWindowClose?: () => void;
  selectWorkspaceDirectory?: (currentPath?: string) => Promise<string | null>;
  listMusic?: (dir?: string) => Promise<{ directory: string; tracks: Array<{ name: string; path: string }> }>;
  readMusic?: (filePath: string) => Promise<Uint8Array | null>;
  selectMusicDirectory?: (currentPath?: string) => Promise<string | null>;
  getPathForFile?: (file: File) => string;
  readPasteContent?: () => Promise<{ type: 'text' | 'file-path' | 'image-path' | 'none'; content: string }>;
  writeClipboardText?: (text: string) => Promise<boolean>;
  loadWorkspaceState?: () => string | null;
  saveWorkspaceState?: (json: string) => void;
  listSessionHistory: () => Promise<HistoryEntry[]>;
  deleteSessionHistory: (items: Array<{ cliId: HistoryEntry['cliId']; id: string }>) => Promise<{ deleted: number; failed: number }>;
  /** 本周各 CLI × 模型的用量与每日请求数（Claude Code / Codex / Antigravity）；accounts 为需要一并统计的账号配置目录 */
  getUsageStats?: (accounts: Array<{ id: string; name: string; cliId: string; configDir: string }>) => Promise<UsageStats>;
  /** 按 PATH 检测已安装的 CLI；custom 为用户自定义 CLI，检测到的会一并返回（name 为空） */
  /** 主进程里的已知 CLI 清单（设置 → CLI 显示用），不是写死在界面里 */
  listKnownClis?: () => Promise<Array<{ id: string; name: string; command: string }>>;
  /** 通知主进程当前界面语言，主进程里会显示到界面的文案（错误、额度提示等）跟随它 */
  setLanguage?: (language: string) => Promise<void>;
  /** 当前用户的主目录，新用户首次启动时作为默认文件夹 */
  getHomeDir?: () => string;
  detectClis: (custom?: Array<{ id: string; command: string }>) => Promise<Array<{ id: string; name: string; command: string }>>;
  createSession: (options: { id: string; command?: string; cwd?: string; shell?: boolean; account?: SessionAccount }) => Promise<{ success: boolean; buffer?: string; error?: string }>;
  getSessionBuffer: (id: string) => Promise<string>;
  writeSession: (id: string, data: string) => Promise<void>;
  resizeSession: (id: string, cols: number, rows: number) => Promise<void>;
  killSession: (id: string) => Promise<void>;
  restartSession?: (id: string) => Promise<{ success: boolean; buffer?: string; error?: string }>;
  clearSessionBuffer?: (id: string) => Promise<boolean>;
  resolvePreviewPaths?: (cwd: string, candidates: string[]) => Promise<Array<string | null>>;
  readPreviewFile?: (cwd: string, filePath: string) => Promise<FilePreviewResult>;
  openExternal?: (url: string) => Promise<boolean>;
  /** 在资源管理器中打开文件夹，目录不存在时返回 false */
  openDirectory?: (dir: string) => Promise<boolean>;
  saveLogFile?: (defaultName: string, content: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
  onSessionData: (callback: (event: { id: string; data: string }) => void) => () => void;
  onSessionExit: (callback: (event: { id: string; exitCode: number }) => void) => () => void;
  getQuota: (cliId?: string) => Promise<QuotaData>;
  getAllQuotas: () => Promise<Record<string, QuotaData>>;
  refreshQuota: (cliId?: string) => Promise<Record<string, QuotaData>>;
  /** 同步账号列表给额度服务；账号的额度以账号 id 为键，与默认账号（键为 cliId）并列返回 */
  setQuotaAccounts?: (accounts: Array<{ key: string; cliId: string; configDir: string }>) => Promise<void>;
  /** 读取任务对应会话里最近一条用户消息（仅 Claude / Codex / Kimi）；text 为 null 表示还没有消息 */
  /** 窗口控件覆盖层的颜色与高度，随主题与界面缩放同步 */
  setTitleBarOverlay?: (opts: { color: string; symbolColor: string; height: number }) => void;
  getTaskSummaries?: (tasks: Array<{ id: string; cliId: string; cwd: string; createdAt: number; historyId?: string; configDir?: string }>) => Promise<Record<string, { text: string | null }>>;
  /** 读取各文件夹所在 Git 仓库的当前分支（只读 .git/HEAD）；不在仓库内为 null */
  getGitBranches?: (paths: string[]) => Promise<Record<string, string | null>>;
  /** 在该账号的环境下运行 CLI 的状态命令，判断是否已登录 */
  checkAccountLogin?: (account: SessionAccount) => Promise<LoginStatus | { error: string }>;
  onQuotaUpdate: (callback: (quotas: Record<string, QuotaData>) => void) => () => void;
  onSystemStats: (callback: (stats: SystemStats) => void) => () => void;
}

export type FilePreviewResult =
  | { kind: 'text'; path: string; size: number; content: string }
  | { kind: 'image'; path: string; size: number; dataUrl: string }
  | { kind: 'binary' | 'too-large' | 'error'; path: string; size?: number; message?: string };

declare global {
  interface Window {
    electronAPI: ElectronTerminalAPI;
  }
}
