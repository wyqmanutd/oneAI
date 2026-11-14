import { BUILTIN_CLIS, defaultWorkspacePath } from './clis';
import { CliDef, FolderEntry, HistoryEntry, TaskSession } from './types';
import { isWindows } from './platform';

/** 渲染进程持有、持久化的全部任务与文件夹状态 */
export interface AppState {
  tasks: TaskSession[];       // 全局有序：数组顺序即侧栏顺序（同一文件夹内的任务保持相对顺序）
  folders: FolderEntry[];     // 侧栏里的文件夹，有序
  activeTaskId: string | null;
  lastFolder: string;         // 没有活动任务时新建任务默认使用的文件夹
  extraClis: CliDef[];        // 自动检测到的、不在内置列表里的 CLI（如 Antigravity、Pi）
}

export interface RecentFolder {
  key: string;
  path: string;
  updatedAt: number;
  entries: HistoryEntry[];    // 最近的会话，已截断
  total: number;              // 该文件夹的会话总数
}

/** Windows 路径大小写不敏感；Unix 路径保留大小写（可能使用大小写敏感的 APFS）。 */
export function folderKey(folder: string): string {
  const windowsPath = isWindows || /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith('\\\\');
  return windowsPath
    ? folder.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
    : folder.replace(/\/+$/, '') || '/';
}

export function folderName(folder: string): string {
  return folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
}

/** 文件夹不在列表里时追加到末尾；expand 为 true 时同时展开 */
export function ensureFolder(folders: FolderEntry[], folder: string, expand = false): FolderEntry[] {
  const key = folderKey(folder);
  const index = folders.findIndex((item) => folderKey(item.path) === key);
  if (index < 0) return [...folders, { path: folder, isExpanded: true }];
  if (expand && !folders[index].isExpanded) return folders.map((item, i) => (i === index ? { ...item, isExpanded: true } : item));
  return folders;
}

/** 把 source 移到 target 的位置（先取出再插入到 target 原来的下标），与旧的拖拽排序语义一致 */
export function moveBefore<T>(list: T[], idOf: (item: T) => string, sourceId: string, targetId: string): T[] {
  const from = list.findIndex((item) => idOf(item) === sourceId);
  const to = list.findIndex((item) => idOf(item) === targetId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 某个文件夹里的任务，保持全局数组中的相对顺序 */
export function tasksInFolder(tasks: TaskSession[], folder: string): TaskSession[] {
  const key = folderKey(folder);
  return tasks.filter((task) => folderKey(task.cwd) === key);
}

/** 侧栏从上到下的任务顺序（也是 Ctrl+Tab / Ctrl+数字 的顺序）；isVisible 用来过滤本机未安装的 CLI */
export function orderedTasks(folders: FolderEntry[], tasks: TaskSession[], isVisible: (task: TaskSession) => boolean = () => true): TaskSession[] {
  const visible = tasks.filter(isVisible);
  const placed = new Set<string>();
  const result: TaskSession[] = [];
  for (const folder of folders) {
    for (const task of tasksInFolder(visible, folder.path)) {
      result.push(task);
      placed.add(task.id);
    }
  }
  return result.concat(visible.filter((task) => !placed.has(task.id)));
}

/** 新任务的默认名称：取该文件夹里已有「Task N」的最大编号加一，避免关闭中间任务后出现重复编号 */
export function nextTaskTitle(folderTasks: TaskSession[]): string {
  const next = folderTasks.reduce((max, task) => Math.max(max, Number(/^Task (\d+)/.exec(task.title)?.[1] ?? 0)), folderTasks.length) + 1;
  return `Task ${next}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanTask(raw: any, fallbackCli: string, fallbackCwd: string): TaskSession | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const { errorMessage: _dropped, ...rest } = raw;
  return {
    ...rest,
    id: raw.id,
    groupId: typeof raw.groupId === 'string' && raw.groupId ? raw.groupId : fallbackCli,
    title: typeof raw.title === 'string' ? raw.title : raw.id,
    cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : fallbackCwd,
    status: 'stopped',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  } as TaskSession;
}

/** 保证每个任务所在的文件夹都在列表里 */
function withTaskFolders(folders: FolderEntry[], tasks: TaskSession[]): FolderEntry[] {
  return tasks.reduce((acc, task) => ensureFolder(acc, task.cwd), folders);
}

/** 校验已保存的新格式状态；格式不符返回 null，由调用方回退到迁移 */
export function normalizeState(raw: unknown, defaultFolder: string = defaultWorkspacePath()): AppState | null {
  if (!isRecord(raw) || !Array.isArray(raw.tasks) || !Array.isArray(raw.folders)) return null;
  const seen = new Set<string>();
  const tasks: TaskSession[] = [];
  for (const item of raw.tasks) {
    const task = cleanTask(item, 'terminal', defaultFolder);
    if (task && !seen.has(task.id)) {
      seen.add(task.id);
      tasks.push(task);
    }
  }
  const folders = withTaskFolders(
    raw.folders
      .filter((item: any) => isRecord(item) && typeof item.path === 'string' && item.path)
      .map((item: any): FolderEntry => ({ path: item.path, isExpanded: Boolean(item.isExpanded) }))
      .filter((item: FolderEntry, index: number, all: FolderEntry[]) => all.findIndex((other) => folderKey(other.path) === folderKey(item.path)) === index),
    tasks,
  );
  const extraClis = Array.isArray(raw.extraClis)
    ? raw.extraClis.filter((cli: any) => isRecord(cli) && typeof cli.id === 'string' && typeof cli.defaultCommand === 'string' && !BUILTIN_CLIS.some((b) => b.id === cli.id))
      .map((cli: any): CliDef => ({ id: cli.id, name: String(cli.name ?? cli.id), icon: String(cli.icon ?? cli.id), defaultCommand: cli.defaultCommand }))
    : [];
  const activeTaskId = typeof raw.activeTaskId === 'string' && seen.has(raw.activeTaskId) ? raw.activeTaskId : tasks[0]?.id ?? null;
  const lastFolder = typeof raw.lastFolder === 'string' && raw.lastFolder ? raw.lastFolder : defaultFolder;
  return { tasks, folders, activeTaskId, lastFolder, extraClis };
}

/**
 * 旧格式（每个工作文件夹各存一份「CLI 分组 → 任务」）合并为单一全局结构：
 * 任务按各自 cwd 归入文件夹，状态一律为已停止；没有任务的旧工作区不导入（上次使用的文件夹除外）；旧数据本身不修改。
 * workspaces 的键是归一化后的路径（丢失了大小写），所以文件夹路径取自任务的 cwd。
 */
export function migrateWorkspaces(input: {
  workspaces: Record<string, any>;
  activeWorkspace: string | null;
  legacy?: unknown;                 // 更早版本的单工作区存储，仅当默认工作区没有数据时使用
  defaultFolder?: string;
  now?: number;
}): AppState {
  const defaultFolder = input.defaultFolder ?? defaultWorkspacePath();
  const activeKey = input.activeWorkspace ? folderKey(input.activeWorkspace) : null;
  const entries: Array<[string, any]> = Object.entries(input.workspaces);
  if (!entries.some(([key]) => key === folderKey(defaultFolder)) && isRecord(input.legacy) && Array.isArray(input.legacy.groups)) {
    entries.push([folderKey(defaultFolder), input.legacy]);
  }
  // 上次使用的工作区排在最前
  entries.sort((a, b) => Number(b[0] === activeKey) - Number(a[0] === activeKey));

  const tasks: TaskSession[] = [];
  const seen = new Set<string>();
  const extraClis: CliDef[] = [];
  let activeTaskId: string | null = null;
  for (const [key, entry] of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.groups)) continue;
    const workspaceFolder = key === activeKey && input.activeWorkspace ? input.activeWorkspace : key;
    for (const group of entry.groups) {
      if (!isRecord(group)) continue;
      if (typeof group.id === 'string' && !BUILTIN_CLIS.some((cli) => cli.id === group.id) && typeof group.defaultCommand === 'string'
        && !extraClis.some((cli) => cli.id === group.id)) {
        extraClis.push({ id: group.id, name: String(group.name ?? group.id), icon: String(group.icon ?? group.id), defaultCommand: group.defaultCommand });
      }
      for (const item of Array.isArray(group.tasks) ? group.tasks : []) {
        const task = cleanTask(item, String(group.id ?? 'terminal'), workspaceFolder);
        if (task && !seen.has(task.id)) {
          seen.add(task.id);
          tasks.push(task);
        }
      }
    }
    if (key === activeKey && typeof entry.activeTaskId === 'string' && seen.has(entry.activeTaskId)) activeTaskId = entry.activeTaskId;
  }

  // 完全没有已保存数据：全新安装，没有任务也没有文件夹，进入后由空状态引导用户选择 CLI 并添加文件夹
  if (entries.length === 0) {
    return { tasks: [], folders: [], activeTaskId: null, lastFolder: defaultFolder, extraClis: [] };
  }

  activeTaskId = activeTaskId ?? tasks[0]?.id ?? null;
  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const lastFolder = input.activeWorkspace || activeTask?.cwd || defaultFolder;
  // 上次使用的文件夹和活动任务所在文件夹展开，其余折叠
  const expandedKeys = new Set([folderKey(lastFolder), ...(activeTask ? [folderKey(activeTask.cwd)] : [])]);
  let folders = input.activeWorkspace ? ensureFolder([], input.activeWorkspace) : [];
  folders = withTaskFolders(folders, tasks).map((folder) => ({ ...folder, isExpanded: expandedKeys.has(folderKey(folder.path)) }));
  return { tasks, folders, activeTaskId, lastFolder, extraClis };
}

/** 历史会话按文件夹归类为「最近任务」：排除已在侧栏显示的文件夹，按最近使用排序并截断 */
export function groupRecent(history: HistoryEntry[], excludeKeys: ReadonlySet<string>, folderLimit = 8, perFolder = 5): RecentFolder[] {
  const byFolder = new Map<string, HistoryEntry[]>();
  for (const entry of history) {
    if (!entry.cwd) continue;
    const key = folderKey(entry.cwd);
    if (excludeKeys.has(key)) continue;
    byFolder.set(key, [...(byFolder.get(key) ?? []), entry]);
  }
  return [...byFolder.entries()]
    .map(([key, entries]) => {
      const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
      return { key, path: sorted[0].cwd, updatedAt: sorted[0].updatedAt, entries: sorted.slice(0, perFolder), total: sorted.length };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, folderLimit);
}

// ---------- 读写（依赖 localStorage 与 window.electronAPI，纯函数部分不依赖） ----------

const STATE_KEY = 'oneai_state_v2';
const OLD_WORKSPACES_KEY = 'oneai_workspaces';
const OLD_ACTIVE_KEY = 'oneai_active_workspace';
const OLD_LEGACY_KEY = 'oneai_workspace';

function readJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

/** 启动时读取状态：新格式优先（主进程落盘文件为准），没有则从旧的各工作区数据迁移 */
export function loadAppState(): AppState {
  let diskState: unknown = null;
  try {
    const raw = window.electronAPI?.loadWorkspaceState?.();
    if (raw) {
      const saved = JSON.parse(raw);
      // 旧数据原样回填到 localStorage，供迁移与保存时透传
      if (isRecord(saved?.workspaces)) localStorage.setItem(OLD_WORKSPACES_KEY, JSON.stringify(saved.workspaces));
      if (typeof saved?.activeWorkspace === 'string' && saved.activeWorkspace) localStorage.setItem(OLD_ACTIVE_KEY, saved.activeWorkspace);
      diskState = saved?.v2 ?? null;
    }
  } catch {}
  const normalized = normalizeState(diskState) ?? normalizeState(readJson(STATE_KEY));
  if (normalized) return normalized;
  const workspaces = readJson(OLD_WORKSPACES_KEY);
  return migrateWorkspaces({
    workspaces: isRecord(workspaces) ? workspaces : {},
    activeWorkspace: localStorage.getItem(OLD_ACTIVE_KEY),
    legacy: readJson(OLD_LEGACY_KEY),
  });
}

/** 同时写入主进程文件（同步落盘、原子替换）与 localStorage；旧的各工作区数据原样透传，不删除 */
export function saveAppState(state: AppState): void {
  const oldWorkspaces = readJson(OLD_WORKSPACES_KEY);
  try {
    window.electronAPI?.saveWorkspaceState?.(JSON.stringify({
      workspaces: isRecord(oldWorkspaces) ? oldWorkspaces : {},
      activeWorkspace: localStorage.getItem(OLD_ACTIVE_KEY),
      v2: state,
    }));
  } catch {}
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
}
