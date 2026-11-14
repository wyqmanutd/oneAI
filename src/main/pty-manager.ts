import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import * as os from 'node:os';
import fs from 'node:fs';
import { buildAccountEnv, SessionAccount } from './account-env';
import { t } from './i18n';
import { defaultShell, shellQuote } from './shell-platform';

interface CreateSessionOptions {
  id: string;
  command?: string;
  cwd?: string;
  shell?: boolean; // 自定义 CLI：整条命令交给当前平台的 Shell 解析
  account?: SessionAccount; // 多账号：按账号的配置目录注入 CODEX_HOME / CLAUDE_CONFIG_DIR；重启时沿用
  cols?: number;
  rows?: number;
}

interface SessionBuffer {
  chunks: string[];
  length: number;
}

const MAX_SESSION_BUFFER_LENGTH = 2 * 1024 * 1024;
const TARGET_BUFFER_CHUNK_LENGTH = 8 * 1024;

export class PtyManager {
  private sessions: Map<string, pty.IPty> = new Map();
  private sessionOptions: Map<string, CreateSessionOptions> = new Map();
  private dataBuffers: Map<string, SessionBuffer> = new Map();
  private mainWindow: BrowserWindow | null = null;

  constructor() {}

  public setWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  /** 仍在运行的终端进程数量 */
  public aliveCount(): number {
    return this.sessions.size;
  }

  public getSessionBuffer(id: string): string {
    return this.dataBuffers.get(id)?.chunks.join('') || '';
  }

  public clearSessionBuffer(id: string) {
    this.dataBuffers.set(id, { chunks: [], length: 0 });
  }

  private appendSessionBuffer(id: string, data: string) {
    if (!data) return;

    const buffer = this.dataBuffers.get(id) || { chunks: [], length: 0 };
    const chunk = data.length > MAX_SESSION_BUFFER_LENGTH
      ? data.slice(-MAX_SESSION_BUFFER_LENGTH)
      : data;
    const lastIndex = buffer.chunks.length - 1;
    if (lastIndex >= 0 && buffer.chunks[lastIndex].length < TARGET_BUFFER_CHUNK_LENGTH) {
      buffer.chunks[lastIndex] += chunk;
    } else {
      buffer.chunks.push(chunk);
    }
    buffer.length += chunk.length;

    while (buffer.length > MAX_SESSION_BUFFER_LENGTH && buffer.chunks.length > 0) {
      const overflow = buffer.length - MAX_SESSION_BUFFER_LENGTH;
      const first = buffer.chunks[0];
      if (first.length <= overflow) {
        buffer.chunks.shift();
        buffer.length -= first.length;
      } else {
        buffer.chunks[0] = first.slice(overflow);
        buffer.length -= overflow;
      }
    }

    this.dataBuffers.set(id, buffer);
  }

  public createSession(options: CreateSessionOptions): { success: boolean; buffer?: string; error?: string } {
    const remembered = this.sessionOptions.get(options.id);
    const resolvedOptions: CreateSessionOptions = {
      ...remembered,
      ...options,
      cols: options.cols ?? remembered?.cols,
      rows: options.rows ?? remembered?.rows,
    };
    const { id, command, cwd } = resolvedOptions;
    this.sessionOptions.set(id, resolvedOptions);

    // 如果该 session 已经存在，则返回当前缓冲区
    if (this.sessions.has(id)) {
      return { success: true, buffer: this.getSessionBuffer(id) };
    }

    try {
      const isWindows = os.platform() === 'win32';
      const systemShell = defaultShell();
      const rawCommand = (command || systemShell).trim();
      const workDir = cwd || os.homedir();
      if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
        return { success: false, error: t('工作目录不存在或不是文件夹：{dir}', { dir: workDir }) };
      }

      let accountEnv: Record<string, string> = {};
      if (resolvedOptions.account) {
        const built = buildAccountEnv(resolvedOptions.account);
        if ('error' in built) return { success: false, error: built.error };
        accountEnv = built.env;
      }

      // 正确拆分可执行文件与命令行参数
      let file = systemShell;
      let args: string[] = [];

      if (isWindows) {
        if (rawCommand.toLowerCase() === 'kimi' || rawCommand.toLowerCase() === 'kimi code') {
          file = 'powershell.exe';
          args = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', 'kimi'];
        } else if (rawCommand.toLowerCase() === 'codex') {
          file = 'powershell.exe';
          args = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', 'codex'];
        } else if (rawCommand.toLowerCase() === 'claude') {
          file = 'powershell.exe';
          args = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', 'claude'];
        } else if (rawCommand.toLowerCase() === 'opencode') {
          file = 'powershell.exe';
          args = [
            '-NoExit',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            'if (Get-Command opencode -ErrorAction SilentlyContinue) { opencode } else { Write-Host "`n' + t('[OneAI 提示]: 本地尚未安装或配置 opencode 环境变量。当前已为您打开交互终端，可随时输入命令。') + '" -ForegroundColor Yellow }',
          ];
        } else if (rawCommand.toLowerCase() === 'grok') {
          file = 'powershell.exe';
          args = [
            '-NoExit',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            'if (Get-Command grok -ErrorAction SilentlyContinue) { grok } else { Write-Host "`n' + t('[OneAI 提示]: 本地尚未安装或配置 grok CLI 环境变量。当前已为您打开交互终端，可随时输入命令。') + '" -ForegroundColor Yellow }',
          ];
        } else if (rawCommand.toLowerCase() === 'powershell' || rawCommand.toLowerCase() === 'powershell.exe') {
          file = 'powershell.exe';
          args = ['-NoExit', '-ExecutionPolicy', 'Bypass'];
        } else if (rawCommand.toLowerCase() === 'cmd' || rawCommand.toLowerCase() === 'cmd.exe') {
          file = 'cmd.exe';
          args = [];
        } else if (resolvedOptions.shell || /^(kimi|codex|claude)\s/i.test(rawCommand)) {
          // 恢复历史会话：带参数的 CLI 命令交给 PowerShell 解析，兼容 .cmd/.ps1 启动器
          file = 'powershell.exe';
          args = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', rawCommand];
        } else if (rawCommand.includes(' ')) {
          // 按空格拆分，但保留引号内的空格（如 "C:\Program Files\x\tool.exe" --flag）
          const parts = (rawCommand.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((part) => part.replace(/^(["'])(.*)\1$/, '$2'));
          file = parts[0];
          args = parts.slice(1);
        } else {
          file = 'powershell.exe';
          args = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', rawCommand];
        }
      } else if (rawCommand === systemShell || /^(?:\/bin\/)?(?:zsh|bash|sh)$/.test(rawCommand)) {
        // 系统终端：直接运行交互式登录 Shell。
        file = rawCommand;
        args = ['-l', '-i'];
      } else {
        // 在登录 Shell 中执行命令，确保用户的 PATH / Shell 配置可用。
        // CLI 退出后仍保留可交互的 Shell，与 Windows 的 -NoExit 行为一致。
        // 这也支持 `codex resume <id>`、自定义 CLI 和其他带参数的命令。
        file = systemShell;
        args = ['-l', '-i', '-c', `${rawCommand}\nexec ${shellQuote(systemShell)} -l -i`];
      }

      console.log(`[PTY] Spawning session ${id}: file=${file}, args=${JSON.stringify(args)}, cwd=${workDir}`);

      const ptyProcess = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(20, resolvedOptions.cols || 120),
        rows: Math.max(10, resolvedOptions.rows || 32),
        cwd: workDir,
        env: {
          ...process.env,
          ...accountEnv,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        } as Record<string, string>,
        useConpty: isWindows,
        // Pi 在开启原始输入前就写入鼠标追踪序列，系统自带 ConPTY 会吞掉这类序列，导致滚轮无法滚动 Pi 的全屏视窗；
        // node-pty 自带的 conpty.dll（OpenConsole）会原样透传，因此仅 Pi 会话使用它。
        useConptyDll: isWindows && /^pi(\s|$)/i.test(rawCommand),
      });

      this.clearSessionBuffer(id);
      this.sessions.set(id, ptyProcess);

      // 监听 PTY 输出数据并缓存与实时发送
      ptyProcess.onData((data: string) => {
        if (this.sessions.get(id) !== ptyProcess) return;
        this.appendSessionBuffer(id, data);

        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('terminal:data', { id, data });
        }
      });

      // 监听进程退出
      ptyProcess.onExit(({ exitCode }) => {
        if (this.sessions.get(id) !== ptyProcess) return;
        console.log(`[PTY] Session ${id} exited with code ${exitCode}`);
        this.sessions.delete(id);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('terminal:exit', { id, exitCode });
        }
      });

      return { success: true, buffer: '' };
    } catch (err: any) {
      console.error(`[PTY] Failed to spawn session ${id}:`, err);
      return { success: false, error: err.message };
    }
  }

  public writeSession(id: string, data: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.write(data);
    }
  }

  public resizeSession(id: string, cols: number, rows: number) {
    const safeCols = Math.max(1, cols);
    const safeRows = Math.max(1, rows);
    const previous = this.sessionOptions.get(id) || { id };
    this.sessionOptions.set(id, { ...previous, cols: safeCols, rows: safeRows });

    const session = this.sessions.get(id);
    if (session) {
      try {
        session.resize(safeCols, safeRows);
      } catch (err) {
        console.warn(`[PTY] Resize failed for ${id}:`, err);
      }
    }
  }

  public killSession(id: string) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) {
      try {
        session.kill();
      } catch {
        // ignore
      }
    }
    this.sessionOptions.delete(id);
    this.dataBuffers.delete(id);
  }

  public restartSession(id: string): { success: boolean; buffer?: string; error?: string } {
    const options = this.sessionOptions.get(id);
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) {
      try {
        session.kill();
      } catch {
        // ignore
      }
    }
    this.dataBuffers.delete(id);
    if (options) {
      return this.createSession(options);
    }
    return this.createSession({ id });
  }

  public destroyAll() {
    for (const [id, session] of this.sessions) {
      try {
        session.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.sessionOptions.clear();
    this.dataBuffers.clear();
  }
}

export const ptyManager = new PtyManager();
