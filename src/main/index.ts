import { app, BrowserWindow, ipcMain, clipboard, shell, dialog, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ptyManager } from './pty-manager';
import { quotaService } from './quota-service';
import { startSystemStats } from './system-stats';
import { checkAccountLogin } from './account-login';
import { setupGitBranch } from './git-branch';
import { setupTaskSummary } from './task-summary';
import { listSessionHistory, deleteSessionHistory } from './session-history';
import { getUsageStats } from './usage-stats';
import { detectInstalledClis, listKnownClis } from './cli-detect';
import { setupWorkspaceStore } from './workspace-store';
import { setupMusicLibrary } from './music-library';
import { setupFilePreview } from './file-preview';
import { getLanguage, setLanguage, t } from './i18n';
import { initializeMacPath } from './shell-platform';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 禁用硬件加速某些已知 Windows 终端闪烁问题（若需要可启用）
// app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const preloadCandidate = path.join(__dirname, '../preload/index.cjs');
  const preloadPath = fs.existsSync(preloadCandidate)
    ? preloadCandidate
    : path.resolve(__dirname, '../../src/preload/index.cjs');

  const iconCandidate = path.resolve(__dirname, '../../resources/icon.png');
  const appIcon = fs.existsSync(iconCandidate) ? iconCandidate : undefined;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1117',
    title: 'OneAI',
    icon: appIcon,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
    // 隐藏原生标题栏，由顶栏承担拖动与标题栏职责；窗口控件（最小化 / 最大化 / 关闭）以覆盖层显示在右上角，颜色由渲染进程随主题同步
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#161b22', symbolColor: '#e2e8f0', height: 44 } }),
    autoHideMenuBar: true,
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-change', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-change', false));

  ptyManager.setWindow(mainWindow);
  quotaService.setWindow(mainWindow);
  quotaService.startPolling(30000); // 每 30 秒轮询一次大模型配额
  const stopSystemStats = startSystemStats(mainWindow);

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer Log ${level}]: ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer Failed Load] code=${errorCode}, desc=${errorDescription}, url=${validatedURL}`);
  });

  // 区分开发与生产环境加载路径
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // 还有终端进程在运行时，关闭窗口先交给界面确认，避免误关丢掉所有 CLI 会话
  let closeConfirmed = false;
  ipcMain.removeAllListeners('window:confirm-close');
  ipcMain.on('window:confirm-close', () => {
    closeConfirmed = true;
    mainWindow?.close();
  });
  let closeRequestedAt = 0;
  // 系统关机或注销时不拦截
  mainWindow.on('session-end', () => { closeConfirmed = true; });
  mainWindow.on('close', (event) => {
    const win = mainWindow;
    if (closeConfirmed || !win || ptyManager.aliveCount() === 0 || win.webContents.isCrashed()) return;
    // 界面没有响应确认请求时，隔 1.5 秒以上再点一次关闭就直接关，避免窗口关不掉
    const now = Date.now();
    if (closeRequestedAt && now - closeRequestedAt > 1500) return;
    closeRequestedAt = now;
    event.preventDefault();
    win.webContents.send('window:close-request', ptyManager.aliveCount());
  });
  ipcMain.removeAllListeners('window:cancel-close');
  ipcMain.on('window:cancel-close', () => { closeRequestedAt = 0; });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopSystemStats();
    quotaService.stopPolling();
    ptyManager.destroyAll();
  });
}

// 注册 IPC 消息通道
function setupIPC() {
  setupWorkspaceStore();
  setupMusicLibrary(() => mainWindow);
  setupFilePreview();
  setupGitBranch();
  setupTaskSummary();
  ipcMain.handle('history:list', () => listSessionHistory());
  ipcMain.handle('history:delete', (_event, items) => deleteSessionHistory(Array.isArray(items) ? items : []));
  ipcMain.handle('usage:stats', (_event, accounts) => getUsageStats(accounts));
  ipcMain.handle('app:set-language', (_event, language) => {
    const before = getLanguage();
    setLanguage(language);
    // 额度提示等文案已按旧语言缓存，语言变化后立即重新读取一次
    if (getLanguage() !== before) void quotaService.refreshAllQuotas();
  });
  ipcMain.on('app:home-dir', (event) => { event.returnValue = app.getPath('home'); });
  ipcMain.handle('cli:known', () => listKnownClis());
  ipcMain.handle('cli:detect', (_event, custom) => detectInstalledClis(Array.isArray(custom) ? custom : []));
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle('workspace:select-directory', async (_event, currentPath?: string) => {
    if (!mainWindow) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: t('选择工作目录'),
      defaultPath: currentPath && fs.existsSync(currentPath) ? currentPath : app.getPath('home'),
      properties: ['openDirectory'],
    });
    return canceled ? null : filePaths[0] || null;
  });

  ipcMain.handle('terminal:create', async (_event, options) => {
    return ptyManager.createSession(options);
  });

  ipcMain.handle('terminal:get-buffer', async (_event, { id }) => {
    return ptyManager.getSessionBuffer(id);
  });

  ipcMain.handle('terminal:write', async (_event, { id, data }) => {
    ptyManager.writeSession(id, data);
  });

  ipcMain.handle('terminal:resize', async (_event, { id, cols, rows }) => {
    ptyManager.resizeSession(id, cols, rows);
  });

  ipcMain.handle('terminal:kill', async (_event, { id }) => {
    ptyManager.killSession(id);
  });

  ipcMain.handle('terminal:restart', async (_event, { id }) => {
    return ptyManager.restartSession(id);
  });

  ipcMain.handle('terminal:clear-buffer', async (_event, { id }) => {
    ptyManager.clearSessionBuffer(id);
    return true;
  });

  ipcMain.handle('quota:get', async (_event, cliId?: string) => {
    return quotaService.getQuota(cliId);
  });

  ipcMain.handle('quota:get-all', async () => {
    return quotaService.getAllQuotas();
  });

  ipcMain.handle('quota:refresh', async (_event, cliId?: string) => {
    return quotaService.refreshQuota(cliId);
  });

  // 窗口控件覆盖层随主题变色；只接受 #rrggbb 与合理的高度
  ipcMain.on('window:set-title-bar-overlay', (_event, opts: { color?: unknown; symbolColor?: unknown; height?: unknown }) => {
    const hex = /^#[0-9a-f]{6}$/i;
    if (typeof opts?.color !== 'string' || !hex.test(opts.color) || typeof opts.symbolColor !== 'string' || !hex.test(opts.symbolColor)) return;
    const height = typeof opts.height === 'number' && opts.height >= 24 && opts.height <= 80 ? Math.round(opts.height) : 44;
    try { mainWindow?.setTitleBarOverlay({ color: opts.color, symbolColor: opts.symbolColor, height }); } catch {}
  });

  ipcMain.handle('account:login-status', (_event, account) => checkAccountLogin(account));

  // 多账号：渲染进程同步账号列表，额度服务按各账号的配置目录单独读取
  ipcMain.handle('quota:set-accounts', async (_event, accounts: Array<{ key: string; cliId: string; configDir: string }>) => {
    quotaService.setAccounts(Array.isArray(accounts) ? accounts : []);
  });

  // 读取剪贴板内容（支持纯文本，以及图片自动存盘返回临时路径）
  ipcMain.handle('clipboard:read-paste-content', async () => {
    try {
      // 1. 优先读取纯文本
      const text = clipboard.readText();
      if (text && text.trim().length > 0) {
        return { type: 'text', content: text };
      }

      // 2. 复制的是文件（资源管理器、微信等常以文件形式放图片）：readText / readImage 都为空，
      //    改读 FileNameW 拿到路径，与拖拽文件的行为一致；Electron 只能读到第一个文件
      const fileNameW = clipboard.readBuffer('FileNameW');
      if (fileNameW.length > 0) {
        const filePath = fileNameW.toString('utf16le').replace(/\0+$/, '');
        if (filePath && fs.existsSync(filePath)) {
          return { type: 'file-path', content: filePath.includes(' ') ? `"${filePath}"` : filePath };
        }
      }

      // 3. 检查剪贴板是否含有位图（如截图、复制的图像）
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const pngBuffer = img.toPNG();
        const tempDir = path.join(app.getPath('temp'), 'OneAI_Images');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const filename = `paste_${Date.now()}.png`;
        const fullPath = path.join(tempDir, filename);
        fs.writeFileSync(fullPath, pngBuffer);
        return { type: 'image-path', content: fullPath.includes(' ') ? `"${fullPath}"` : fullPath };
      }
    } catch (e) {
      console.error('[OneAI] Error reading clipboard paste content:', e);
    }
    return { type: 'none', content: '' };
  });

  // 写入系统剪贴板纯文本
  ipcMain.handle('clipboard:write-text', async (_event, text: string) => {
    try {
      if (typeof text === 'string') {
        clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.error('[OneAI] Error writing text to clipboard:', e);
    }
    return false;
  });

  // 在系统默认浏览器中打开外部超链接
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    try {
      if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:'))) {
        await shell.openExternal(url);
        return true;
      }
    } catch (e) {
      console.error('[OneAI] Error opening external URL:', e);
    }
    return false;
  });

  // 在资源管理器中打开任务的工作目录；只接受已存在的文件夹
  ipcMain.handle('shell:open-directory', async (_event, dir: string) => {
    try {
      if (typeof dir === 'string' && fs.statSync(dir).isDirectory()) {
        return (await shell.openPath(dir)) === '';
      }
    } catch {
      // 目录不存在或无法访问
    }
    return false;
  });

  // 弹出保存文件对话框，将终端完整日志存盘
  ipcMain.handle('dialog:save-log-file', async (_event, { defaultName, content }: { defaultName: string; content: string }) => {
    try {
      if (!mainWindow) return { success: false, error: 'No main window' };
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: t('导出终端会话完整日志'),
        defaultPath: defaultName || `terminal-log-${Date.now()}.txt`,
        filters: [
          { name: t('Markdown 文档 (*.md)'), extensions: ['md'] },
          { name: t('文本文件 (*.txt)'), extensions: ['txt'] },
          { name: t('所有文件 (*.*)'), extensions: ['*'] },
        ],
      });
      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true, filePath };
    } catch (e: any) {
      console.error('[OneAI] Error saving log file:', e);
      return { success: false, error: e?.message || String(e) };
    }
  });
}

app.whenReady().then(async () => {
  await initializeMacPath();
  // 去掉 Electron 默认菜单：它的 Ctrl+W 关窗、Ctrl+R 刷新与 CLI 常用键冲突，按 Alt 还会弹出菜单栏抢走焦点。
  // 开发模式保留，方便用 Ctrl+Shift+I 打开开发者工具。
  // macOS 需要原生应用菜单（退出、编辑、复制/粘贴等）。
  if (process.platform !== 'darwin' && !process.env.VITE_DEV_SERVER_URL) Menu.setApplicationMenu(null);
  setupIPC();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  quotaService.stopPolling();
  ptyManager.destroyAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
