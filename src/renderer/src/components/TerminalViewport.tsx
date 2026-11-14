import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { TaskSession, ThemeId } from '../types';
import { TerminalSearchBar } from './TerminalSearchBar';
import { t } from '../i18n';
import { isMac, isWindows, primaryModifierPressed } from '../platform';

export interface TerminalViewportRef {
  openSearch: () => void;
  closeSearch: () => void;
  clearActiveTerminal: () => void;
  restartActiveTerminal: (taskId?: string | null) => Promise<{ success: boolean; error?: string } | undefined>;
  exportActiveTerminalLog: (mode: 'copy' | 'save') => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>;
}

/** 把终端里实际渲染出来的文字（含回滚区）导出为纯文本，折行的物理行合并为一行。 */
function readTerminalText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

interface TerminalViewportProps {
  theme: ThemeId;
  tasks: TaskSession[];
  activeTaskId: string | null;
  fontSize?: number;
  lineHeight?: number;
  cursorStyle?: 'bar' | 'block' | 'underline';
  cursorBlink?: boolean;
  /** 没有任何任务时显示的引导内容 */
  emptyState?: React.ReactNode;
  /** 点击终端中的工作目录内文件路径时触发，参数为任务 cwd 与文件绝对路径 */
  onPreviewFile?: (cwd: string, filePath: string, line?: number) => void;
}

interface LogicalLine {
  text: string;
  /** text 中每个 UTF-16 单元对应的终端单元格：1 起始的列、行号和占用列数（中文为 2） */
  cells: Array<{ x: number; y: number; w: number }>;
}

/** 合并因终端宽度折行的物理行，并记录字符与单元格的对应关系，供链接识别按真实列号定位。 */
export function getLogicalLine(term: Terminal, bufferLineNumber: number): LogicalLine | null {
  const buf = term.buffer.active;
  let start = bufferLineNumber - 1;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let text = '';
  const cells: LogicalLine['cells'] = [];
  for (let y = start; ; y++) {
    const line = buf.getLine(y);
    if (!line || (y > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) {
        text += chars[i];
        cells.push({ x: x + 1, y: y + 1, w: cell.getWidth() });
      }
    }
  }
  return text ? { text, cells } : null;
}

/** 把 text 中 [start, start+length) 的匹配换算为 xterm 链接范围（end 为闭区间）；匹配不在 bufferLineNumber 行上时返回 null。 */
export function matchToLinkRange(logical: LogicalLine, start: number, length: number, bufferLineNumber: number) {
  const first = logical.cells[start];
  const last = logical.cells[start + length - 1];
  if (!first || !last || bufferLineNumber < first.y || bufferLineNumber > last.y) return null;
  return {
    start: { x: first.x, y: first.y },
    end: { x: last.x + last.w - 1, y: last.y },
  };
}

/**
 * Chromium 同时只允许约 16 个 WebGL 上下文，超出时最早的会被强制丢弃（往往就是当前终端）。
 * 只给最近显示过的终端保留 WebGL，当前终端一定有；更早的隐藏终端释放后退回 DOM 渲染，切回来时再挂上。
 */
const MAX_WEBGL_TERMINALS = 8;

const SEARCH_DECORATIONS = {
  matchBackground: '#b58900',
  matchOverviewRuler: '#b58900',
  activeMatchBackground: '#e8590c',
  activeMatchColorOverviewRuler: '#e8590c',
};

/**
 * Kimi Code 隐藏真实光标，并把它停在输入行最右端或底部状态栏，输入法组合文字和候选框会跟到那里。
 * 仅对 Kimi 任务生效：按输入框底边框找到其上一行的文字末尾，作为输入法的定位点。
 * 找不到输入框时不干预，保持 xterm 默认行为。
 */
function findKimiInputAnchor(term: Terminal): { row: number; col: number } | null {
  const buf = term.buffer.active;
  for (let y = term.rows - 1; y >= 1; y--) {
    const border = buf.getLine(buf.viewportY + y);
    const text = border?.translateToString(true).trim() ?? '';
    if (text.length < 8 || !/^[╰└╚]?[─━═╌┄-]{6,}[╯┘╝]?$/.test(text)) continue;
    const line = buf.getLine(buf.viewportY + y - 1);
    if (!line) return null;
    let col = 0;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      const ch = cell?.getChars() ?? '';
      if (cell && ch && ch !== ' ' && ch !== '│' && ch !== '┃') col = x + Math.max(cell.getWidth(), 1);
    }
    return { row: y - 1, col };
  }
  return null;
}

/**
 * Pi 隐藏真实光标，在输入框里画一个反色空格作为光标，真实光标则停在行尾之外。
 * 输入框夹在两条整行横线之间：自下而上找到相邻两条横线，取其间的反色单元格作为定位点。
 */
function findPiInputAnchor(term: Terminal): { row: number; col: number } | null {
  const buf = term.buffer.active;
  const isBorder = (y: number) => /^[─━═]{20,}$/.test(buf.getLine(buf.viewportY + y)?.translateToString(true).trim() ?? '');
  let lower = -1;
  for (let y = term.rows - 1; y >= 0; y--) {
    if (!isBorder(y)) continue;
    if (lower >= 0) {
      for (let r = y + 1; r < lower; r++) {
        const line = buf.getLine(buf.viewportY + r);
        for (let x = 0; line && x < line.length; x++) {
          if (line.getCell(x)?.isInverse()) return { row: r, col: x };
        }
      }
    }
    lower = y;
  }
  return null;
}

type InputAnchorFinder = (term: Terminal) => { row: number; col: number } | null;

/** 各 CLI 的输入法定位点查找方式，未列出的 CLI 保持 xterm 默认行为。 */
export const IME_ANCHOR_FINDERS: Record<string, InputAnchorFinder> = {
  kimi: findKimiInputAnchor,
  pi: findPiInputAnchor,
};

export function attachImeAnchor(term: Terminal, host: HTMLElement, find: InputAnchorFinder): void {
  const textarea = term.textarea;
  const root = term.element;
  if (!textarea || !root) return;
  // xterm 在重绘、光标移动和组合输入的延时回调里都会把 textarea 的内联 left/top 写回真实光标，
  // 输入法恰好在这些回写之后读取位置。这里不再和它抢写内联样式，
  // 改由 index.css 的 .ime-anchored 规则用 !important 读取下面两个变量，xterm 的回写因此不生效。
  const place = () => {
    const screen = host.querySelector<HTMLElement>('.xterm-screen');
    const anchor = find(term);
    if (!screen || !anchor || !screen.clientWidth) {
      root.classList.remove('ime-anchored');
      return;
    }
    root.style.setProperty('--ime-left', `${(anchor.col * screen.clientWidth) / term.cols}px`);
    root.style.setProperty('--ime-top', `${(anchor.row * screen.clientHeight) / term.rows}px`);
    root.classList.add('ime-anchored');
  };
  term.onRender(place);
  term.onCursorMove(place);
  textarea.addEventListener('focus', place);
  textarea.addEventListener('compositionstart', place);
  textarea.addEventListener('compositionupdate', place);
}

interface TerminalInstance {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webglAddon?: WebglAddon;
  container: HTMLDivElement;
  pendingData: string;
  flushTimer: NodeJS.Timeout | null;
  flush: () => void;
}

const DARK_TERMINAL_THEME = {
  background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#1f6feb40',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff',
  magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4', brightBlack: '#6e7681',
  brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

const LIGHT_TERMINAL_THEME = {
  background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#0969da40',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da',
  magenta: '#8250df', cyan: '#0550ae', white: '#6e7781', brightBlack: '#57606a',
  brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#9a6700', brightBlue: '#218bff',
  brightMagenta: '#a475f9', brightCyan: '#0969da', brightWhite: '#24292f',
};

const BEAN_TERMINAL_THEME = {
  background: '#cce8cf', foreground: '#223226', cursor: '#0e5e8a', selectionBackground: '#0e5e8a38',
  black: '#223226', red: '#b91c28', green: '#146e32', yellow: '#7a5200', blue: '#0e5e8a',
  magenta: '#6e40be', cyan: '#0b6b70', white: '#4c6250', brightBlack: '#3f5a45',
  brightRed: '#9a1520', brightGreen: '#0f5a28', brightYellow: '#6a4600', brightBlue: '#0a4c70',
  brightMagenta: '#5a30a0', brightCyan: '#085a5e', brightWhite: '#223226',
};

const PARCHMENT_TERMINAL_THEME = {
  background: '#f4ecd8', foreground: '#3b3126', cursor: '#1e64a0', selectionBackground: '#1e64a038',
  black: '#3b3126', red: '#be2828', green: '#28733c', yellow: '#8a5a00', blue: '#1e64a0',
  magenta: '#7846b4', cyan: '#16707a', white: '#6b5a46', brightBlack: '#5a4c3a',
  brightRed: '#9a1c1c', brightGreen: '#1e5a2e', brightYellow: '#734a00', brightBlue: '#14508a',
  brightMagenta: '#60388f', brightCyan: '#105a63', brightWhite: '#3b3126',
};

const DUSK_TERMINAL_THEME = {
  background: '#1e1b18', foreground: '#e2d8c6', cursor: '#e0a85a', selectionBackground: '#e0a85a38',
  black: '#4a433a', red: '#e8786e', green: '#8cc36e', yellow: '#e8b850', blue: '#7fa8d0',
  magenta: '#be96dc', cyan: '#78c0b4', white: '#cdc2af', brightBlack: '#7a705f',
  brightRed: '#f0948a', brightGreen: '#a4d488', brightYellow: '#f0cc78', brightBlue: '#9cc0e2',
  brightMagenta: '#d0b0e8', brightCyan: '#94d2c8', brightWhite: '#f2eadb',
};

const NORD_TERMINAL_THEME = {
  background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', selectionBackground: '#88c0d040',
  black: '#3b4252', red: '#d77882', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1',
  magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#6a7690',
  brightRed: '#e0919a', brightGreen: '#b5cf9f', brightYellow: '#f2d9a3', brightBlue: '#9bb6d0',
  brightMagenta: '#c4a3bd', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
};

const DARCULA_TERMINAL_THEME = {
  background: '#2b2b2b', foreground: '#a9b7c6', cursor: '#bbbbbb', selectionBackground: '#21428399',
  black: '#555555', red: '#ff6b68', green: '#a8c023', yellow: '#d6bf55', blue: '#5394ec',
  magenta: '#ae8abe', cyan: '#299999', white: '#bbbbbb', brightBlack: '#787878',
  brightRed: '#ff8785', brightGreen: '#bdd74a', brightYellow: '#ffc66d', brightBlue: '#589df6',
  brightMagenta: '#c3a3d2', brightCyan: '#3dbcbc', brightWhite: '#ffffff',
};

const MATERIAL_TERMINAL_THEME = {
  background: '#263238', foreground: '#eeffff', cursor: '#ffcc00', selectionBackground: '#546e7a66',
  black: '#546e7a', red: '#f07178', green: '#c3e88d', yellow: '#ffcb6b', blue: '#82aaff',
  magenta: '#c792ea', cyan: '#89ddff', white: '#b0bec5', brightBlack: '#78909c',
  brightRed: '#ff5370', brightGreen: '#d1f0a5', brightYellow: '#ffe08a', brightBlue: '#a1bfff',
  brightMagenta: '#dab4f2', brightCyan: '#a9e8ff', brightWhite: '#ffffff',
};

const MONOKAI_TERMINAL_THEME = {
  background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e',
  black: '#75715e', red: '#f92672', green: '#a6e22e', yellow: '#e6db74', blue: '#66d9ef',
  magenta: '#ae81ff', cyan: '#a1efe4', white: '#cfcfc2', brightBlack: '#8f8b77',
  brightRed: '#ff5c93', brightGreen: '#bdeb4f', brightYellow: '#f4ea9a', brightBlue: '#8fe3f5',
  brightMagenta: '#c4a5ff', brightCyan: '#bcf5ee', brightWhite: '#f9f8f5',
};

const MARIANA_TERMINAL_THEME = {
  background: '#2e3842', foreground: '#d8dee9', cursor: '#f9ae58', selectionBackground: '#596673b3',
  black: '#647382', red: '#ee6a6f', green: '#a3ce9e', yellow: '#fab763', blue: '#6699cc',
  magenta: '#c594c5', cyan: '#5fb4b4', white: '#d8dee9', brightBlack: '#a6acb9',
  brightRed: '#f58b8f', brightGreen: '#b9dcb5', brightYellow: '#fcc98a', brightBlue: '#86b1da',
  brightMagenta: '#d6b0d6', brightCyan: '#7fc7c7', brightWhite: '#ffffff',
};

const BREAKERS_TERMINAL_THEME = {
  background: '#fcfdfd', foreground: '#333333', cursor: '#449999', selectionBackground: '#d8dcdfb3',
  black: '#333333', red: '#d63a44', green: '#4f8c48', yellow: '#b87a1f', blue: '#3f7fbf',
  magenta: '#8f5288', cyan: '#2f8484', white: '#6b6b6b', brightBlack: '#666666',
  brightRed: '#b8222c', brightGreen: '#3e7d38', brightYellow: '#9a6410', brightBlue: '#2f69a5',
  brightMagenta: '#774471', brightCyan: '#236b6b', brightWhite: '#333333',
};

const SOLARIZED_DARK_TERMINAL_THEME = {
  background: '#042029', foreground: '#839496', cursor: '#819090', selectionBackground: '#124455',
  black: '#586e75', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2',
  magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#657b83',
  brightRed: '#e8584f', brightGreen: '#9bb300', brightYellow: '#d0a000', brightBlue: '#4aa5e8',
  brightMagenta: '#e0589a', brightCyan: '#3fbfb5', brightWhite: '#fdf6e3',
};

const SOLARIZED_LIGHT_TERMINAL_THEME = {
  background: '#fdf6e3', foreground: '#586e75', cursor: '#073642', selectionBackground: '#d9d2b8',
  black: '#073642', red: '#dc322f', green: '#6b7d00', yellow: '#9a7400', blue: '#1f78b6',
  magenta: '#d33682', cyan: '#1f8a82', white: '#657b83', brightBlack: '#586e75',
  brightRed: '#cb4b16', brightGreen: '#5a6b00', brightYellow: '#7d5e00', brightBlue: '#1a68a0',
  brightMagenta: '#6c71c4', brightCyan: '#176b64', brightWhite: '#073642',
};

const COBALT_TERMINAL_THEME = {
  background: '#002240', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#b36539bf',
  black: '#3b5f8a', red: '#ff628c', green: '#3ad900', yellow: '#ffdd00', blue: '#0088ff',
  magenta: '#d08cff', cyan: '#5ce1e6', white: '#d6e4f5', brightBlack: '#6c8db5',
  brightRed: '#ff8aa8', brightGreen: '#6ff03a', brightYellow: '#ffee80', brightBlue: '#4da8ff',
  brightMagenta: '#e0b0ff', brightCyan: '#8cf0f3', brightWhite: '#ffffff',
};

const IDEA_CLASSIC_LIGHT_TERMINAL_THEME = {
  background: '#ffffff', foreground: '#080808', cursor: '#000000', selectionBackground: '#a6d2ff',
  black: '#000000', red: '#c7222d', green: '#4a9249', yellow: '#a46704', blue: '#2470b3',
  magenta: '#7444d4', cyan: '#077a7f', white: '#6e6e6e', brightBlack: '#808080',
  brightRed: '#db3b4b', brightGreen: '#369650', brightYellow: '#c27d04', brightBlue: '#3574f0',
  brightMagenta: '#834df0', brightCyan: '#039ba1', brightWhite: '#080808',
};

const IDEA_LIGHT_TERMINAL_THEME = {
  background: '#ffffff', foreground: '#080808', cursor: '#080808', selectionBackground: '#a6d2ff',
  black: '#27282e', red: '#db3b4b', green: '#208a3c', yellow: '#a46704', blue: '#3369d6',
  magenta: '#7444d4', cyan: '#077a7f', white: '#6c707e', brightBlack: '#818594',
  brightRed: '#ad2b38', brightGreen: '#1f7536', brightYellow: '#8a5600', brightBlue: '#315fbd',
  brightMagenta: '#643cb8', brightCyan: '#096a6e', brightWhite: '#080808',
};

const IDEA_DARK_TERMINAL_THEME = {
  background: '#1e1f22', foreground: '#bcbec4', cursor: '#ced0d6', selectionBackground: '#2e436e',
  black: '#4e5157', red: '#db5c5c', green: '#5fad65', yellow: '#f2c55c', blue: '#548af7',
  magenta: '#a571e6', cyan: '#42b1a4', white: '#bcbec4', brightBlack: '#6f737a',
  brightRed: '#e37774', brightGreen: '#73bd79', brightYellow: '#f5d273', brightBlue: '#6b9bfa',
  brightMagenta: '#b589ec', brightCyan: '#60c0b5', brightWhite: '#dfe1e5',
};

const IDEA_CONTRAST_TERMINAL_THEME = {
  background: '#131314', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#3333ff',
  black: '#808080', red: '#fa3232', green: '#54b33e', yellow: '#ffbf66', blue: '#33ccff',
  magenta: '#ff96ff', cyan: '#37cccc', white: '#ffffff', brightBlack: '#b3b3b3',
  brightRed: '#ff5a5a', brightGreen: '#6fd458', brightYellow: '#ffd08a', brightBlue: '#66d9ff',
  brightMagenta: '#ffb3ff', brightCyan: '#5fe0e0', brightWhite: '#ffffff',
};

const KIRO_DARK_TERMINAL_THEME = {
  background: '#211d25', foreground: '#f2f1f4', cursor: '#b080ff', selectionBackground: '#b080ff40',
  black: '#4a464f', red: '#ff8080', green: '#80ffb5', yellow: '#fff2b3', blue: '#8dc8fb',
  magenta: '#8e47ff', cyan: '#80f4ff', white: '#d0cdd6', brightBlack: '#938f9b',
  brightRed: '#ffa3a3', brightGreen: '#a3ffc9', brightYellow: '#fff7cc', brightBlue: '#a9d9fc',
  brightMagenta: '#b080ff', brightCyan: '#a3f8ff', brightWhite: '#ffffff',
};

const KIRO_LIGHT_TERMINAL_THEME = {
  background: '#f2f1f4', foreground: '#352f3d', cursor: '#7138cc', selectionBackground: '#7138cc33',
  black: '#352f3d', red: '#993333', green: '#367c53', yellow: '#a38400', blue: '#2d6a9f',
  magenta: '#8e47ff', cyan: '#0a7f8a', white: '#6b6573', brightBlack: '#938f9b',
  brightRed: '#7a2626', brightGreen: '#2a6342', brightYellow: '#806800', brightBlue: '#235480',
  brightMagenta: '#7138cc', brightCyan: '#086772', brightWhite: '#352f3d',
};

const TERMINAL_THEMES: Record<ThemeId, typeof DARK_TERMINAL_THEME> = {
  light: LIGHT_TERMINAL_THEME,
  dark: DARK_TERMINAL_THEME,
  bean: BEAN_TERMINAL_THEME,
  parchment: PARCHMENT_TERMINAL_THEME,
  dusk: DUSK_TERMINAL_THEME,
  nord: NORD_TERMINAL_THEME,
  darcula: DARCULA_TERMINAL_THEME,
  material: MATERIAL_TERMINAL_THEME,
  monokai: MONOKAI_TERMINAL_THEME,
  mariana: MARIANA_TERMINAL_THEME,
  breakers: BREAKERS_TERMINAL_THEME,
  'solarized-dark': SOLARIZED_DARK_TERMINAL_THEME,
  'solarized-light': SOLARIZED_LIGHT_TERMINAL_THEME,
  cobalt: COBALT_TERMINAL_THEME,
  'idea-classic-light': IDEA_CLASSIC_LIGHT_TERMINAL_THEME,
  'idea-light': IDEA_LIGHT_TERMINAL_THEME,
  'idea-dark': IDEA_DARK_TERMINAL_THEME,
  'idea-contrast': IDEA_CONTRAST_TERMINAL_THEME,
  'kiro-dark': KIRO_DARK_TERMINAL_THEME,
  'kiro-light': KIRO_LIGHT_TERMINAL_THEME,
};

/**
 * 净化终端数据流中的伪光标泄露：
 * Windows ConPTY 在将后台渲染缓冲区切片推送到客户端时，常因 60Hz 定时器边界，
 * 在局部擦除或星空粒子重绘后（如 \x1b[9;1H）、输出目标输入行光标（\x1b[11;3H）之前，
 * 误插 \x1b[?25h（即刻显示光标）。这会导致光标在输入框各处高频横移乱跳。
 * 此处移除无字符紧随定位的光标开启指令，保持隐藏状态直至真正定位到用户输入行。
 */
export function sanitizeTerminalData(data: string): string {
  let res = data.replace(/\x1b\[\?25l(\x1b\[\d+;\d+H)\x1b\[\?25h/g, '\x1b[?25l$1');
  res = res.replace(/(\x1b\[\d+;\d+H)\x1b\[\?25h(?=\s*\x1b\[0\s*q|\s*\x1b\[\?2026l)/g, '$1');
  return res;
}

export const TerminalViewport = forwardRef<TerminalViewportRef, TerminalViewportProps>(({
  theme,
  tasks,
  activeTaskId,
  fontSize = 15,
  lineHeight = 1.3,
  cursorStyle = 'bar',
  cursorBlink = true,
  emptyState,
  onPreviewFile,
}, ref) => {
  const onPreviewFileRef = useRef(onPreviewFile);
  onPreviewFileRef.current = onPreviewFile;
  const containerRef = useRef<HTMLDivElement>(null);
  const lastSizeSyncRef = useRef('');
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map());

  useEffect(() => {
    instancesRef.current.forEach(({ term }) => {
      term.options.theme = TERMINAL_THEMES[theme];
    });
  }, [theme]);

  // 搜索栏状态
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [searchResult, setSearchResult] = useState<{ index: number; count: number } | null>(null);
  const [searchInvalid, setSearchInvalid] = useState(false);
  const activeTaskIdRef = useRef(activeTaskId);
  activeTaskIdRef.current = activeTaskId;

  // 点过顶栏、侧栏按钮后焦点留在按钮上，直接打字进不了终端：此时按下可输入字符就把焦点交还当前终端。
  // 空格和回车留给按钮本身；有弹窗或菜单打开、焦点在输入框时不干预。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
      if (!(e.key === 'Process' || (e.key.length === 1 && e.key !== ' '))) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.tagName !== 'BUTTON') return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const taskId = activeTaskIdRef.current;
      if (taskId) instancesRef.current.get(taskId)?.term.focus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // 搜索栏跨任务共用：切换任务时清掉旧终端的高亮，并在新终端重新搜索当前关键字
  const prevSearchTaskRef = useRef<string | null>(activeTaskId);
  useEffect(() => {
    const prev = prevSearchTaskRef.current;
    prevSearchTaskRef.current = activeTaskId;
    if (prev === activeTaskId) return;
    if (prev) instancesRef.current.get(prev)?.searchAddon.clearDecorations();
    setSearchResult(null);
    setSearchInvalid(false);
    if (isSearchOpen && searchQuery.trim() && activeTaskId) {
      runSearch('next', searchQuery, matchCase, useRegex, false, activeTaskId);
    }
  }, [activeTaskId]);

  const getActiveSearchAddon = () => {
    if (!activeTaskId) return null;
    return instancesRef.current.get(activeTaskId)?.searchAddon || null;
  };

  // 统一执行搜索：带高亮与匹配计数；正则输入到一半不合法时不抛错，只提示。
  const runSearch = (
    direction: 'next' | 'previous',
    query: string,
    caseSensitive: boolean,
    regex: boolean,
    incremental: boolean,
    taskId: string | null = activeTaskId,
  ) => {
    const searchAddon = taskId ? instancesRef.current.get(taskId)?.searchAddon : null;
    if (!searchAddon) return;
    if (!query.trim()) {
      searchAddon.clearDecorations();
      setSearchResult(null);
      setSearchInvalid(false);
      return;
    }
    try {
      const options = { caseSensitive, regex, incremental, decorations: SEARCH_DECORATIONS };
      const found = direction === 'next' ? searchAddon.findNext(query, options) : searchAddon.findPrevious(query, options);
      setSearchInvalid(false);
      if (!found) setSearchResult({ index: -1, count: 0 });
    } catch {
      searchAddon.clearDecorations();
      setSearchInvalid(true);
      setSearchResult(null);
    }
  };

  const searchResultText = searchInvalid
    ? t('正则无效')
    : searchResult
      ? searchResult.count === 0 ? t('无结果') : searchResult.index >= 0 ? `${searchResult.index + 1}/${searchResult.count}` : `${searchResult.count}+`
      : '';

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    runSearch('next', query, matchCase, useRegex, true);
  };

  const handleToggleMatchCase = () => {
    const next = !matchCase;
    setMatchCase(next);
    runSearch('next', searchQuery, next, useRegex, true);
  };

  const handleToggleRegex = () => {
    const next = !useRegex;
    setUseRegex(next);
    runSearch('next', searchQuery, matchCase, next, true);
  };

  const handleFindNext = () => runSearch('next', searchQuery, matchCase, useRegex, false);

  const handleFindPrevious = () => runSearch('previous', searchQuery, matchCase, useRegex, false);

  const handleCloseSearch = () => {
    const searchAddon = getActiveSearchAddon();
    searchAddon?.clearDecorations();
    setIsSearchOpen(false);
    setSearchResult(null);
    setSearchInvalid(false);
    if (activeTaskId) {
      const term = instancesRef.current.get(activeTaskId)?.term;
      // 搜索用选区标记当前匹配；不清掉的话，之后第一次 Ctrl+C 会被当成复制而吞掉中断信号
      term?.clearSelection();
      term?.focus();
    }
  };

  // 清理指定终端屏幕与主进程缓冲区，避免快捷键使用过期的活动任务 ID。
  const clearTerminal = (taskId: string) => {
    const instance = instancesRef.current.get(taskId);
    if (instance) {
      // 不在终端里追加提示文字：Claude / Codex 等 CLI 自己重绘界面，多出的行会让光标位置错位。
      instance.term.clear();
      window.electronAPI?.clearSessionBuffer?.(taskId);
      instance.term.focus();
    }
  };

  const clearActiveTerminal = () => {
    if (activeTaskId) clearTerminal(activeTaskId);
  };

  // 重启指定任务的 CLI 进程，未指定时为当前活动任务
  const restartActiveTerminal = async (taskId: string | null = activeTaskId) => {
    if (!taskId) return undefined;
    const instance = instancesRef.current.get(taskId);
    if (instance) {
      instance.term.clear();
      instance.term.write(`\r\n\x1b[33m[OneAI] ${t('正在重启 CLI 会话进程...')}\x1b[0m\r\n`);
      const result = await window.electronAPI?.restartSession?.(taskId);
      if (taskId === activeTaskIdRef.current) instance.term.focus();
      return result || { success: false, error: t('重启接口不可用') };
    }
    return { success: false, error: t('终端实例不存在') };
  };

  // 导出或复制当前会话最近约 2 MiB 的文本
  const exportActiveTerminalLog = async (mode: 'copy' | 'save') => {
    if (!activeTaskId) return { success: false, error: t('无活动会话') };
    // 导出终端里实际渲染的文字。原始输出流里有 CLI 反复重绘的每一帧，直接去控制码会得到重复、错乱的文本；
    // 只有终端实例不存在时才回退到原始流。
    const instance = instancesRef.current.get(activeTaskId);
    let plainText: string;
    if (instance) {
      instance.flush();
      await new Promise<void>((resolve) => instance.term.write('', resolve));
      plainText = readTerminalText(instance.term);
    } else {
      const raw = (await window.electronAPI?.getSessionBuffer(activeTaskId)) || '';
      plainText = raw.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
    }

    if (mode === 'copy') {
      try {
        if (window.electronAPI?.writeClipboardText) {
          const copied = await window.electronAPI.writeClipboardText(plainText);
          if (!copied) return { success: false, error: t('系统剪贴板拒绝写入') };
        } else {
          await navigator.clipboard.writeText(plainText);
        }
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    } else {
      const activeTask = tasks.find((t) => t.id === activeTaskId);
      const safeTitle = (activeTask?.title || 'session').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_');
      const defaultName = `${safeTitle}-log-${Date.now()}.md`;
      const res = await window.electronAPI?.saveLogFile?.(defaultName, plainText);
      return res || { success: false, error: t('保存失败') };
    }
  };

  // 暴露给外层 Topbar 控制
  useImperativeHandle(ref, () => ({
    openSearch: () => setIsSearchOpen(true),
    closeSearch: handleCloseSearch,
    clearActiveTerminal,
    restartActiveTerminal,
    exportActiveTerminalLog,
  }));

  // 全局阻止默认拖拽行为，防止外部文件拖入非目标区域导致 Electron 窗口刷新/跳转
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent, false);
    window.addEventListener('drop', prevent, false);
    return () => {
      window.removeEventListener('dragover', prevent, false);
      window.removeEventListener('drop', prevent, false);
    };
  }, []);

  // 动态更新所有已有终端的字体大小、行高与光标样式，实时触发自适应排版
  useEffect(() => {
    instancesRef.current.forEach((instance) => {
      let changed = false;
      if (fontSize && instance.term.options.fontSize !== fontSize) {
        instance.term.options.fontSize = fontSize;
        changed = true;
      }
      if (lineHeight && instance.term.options.lineHeight !== lineHeight) {
        instance.term.options.lineHeight = lineHeight;
        changed = true;
      }
      if (cursorStyle && instance.term.options.cursorStyle !== cursorStyle) {
        instance.term.options.cursorStyle = cursorStyle;
      }
      if (cursorBlink !== undefined && instance.term.options.cursorBlink !== cursorBlink) {
        instance.term.options.cursorBlink = cursorBlink;
      }
      if (changed) {
        try {
          instance.fitAddon.fit();
        } catch {}
      }
    });
  }, [fontSize, lineHeight, cursorStyle, cursorBlink]);

  // 为每个任务维护一个独立的 xterm 实例，切换时仅更改 display: none / block
  useEffect(() => {
    if (!containerRef.current) return;

    const currentTaskIds = new Set(tasks.map((t) => t.id));

    // 1. 清理已被关闭的任务终端
    instancesRef.current.forEach((instance, id) => {
      if (!currentTaskIds.has(id)) {
        try {
          if (instance.flushTimer) clearTimeout(instance.flushTimer);
          instance.searchAddon?.dispose();
          instance.webglAddon?.dispose();
          instance.term.dispose();
          instance.container.remove();
        } catch {
          // ignore
        }
        instancesRef.current.delete(id);
      }
    });

    // 2. 按需创建：任务第一次被选中时才创建 xterm 实例（之后隐藏保活，不销毁）。
    //    启动时不为所有任务一次性创建，避免实例和 WebGL 上下文随任务数量线性增长；
    //    未创建实例期间的输出由主进程缓冲，创建时回放。
    const terminalHost = containerRef.current;
    tasks.forEach((task) => {
      if (task.id === activeTaskId && !instancesRef.current.has(task.id)) {
        const termContainer = document.createElement('div');
        termContainer.id = `terminal-${task.id}`;
        termContainer.className = 'w-full h-full overflow-hidden';
        termContainer.style.display = task.id === activeTaskId ? 'block' : 'none';
        terminalHost.appendChild(termContainer);

        const term = new Terminal({
          theme: TERMINAL_THEMES[theme],
          fontFamily: isMac ? 'Menlo, "SFMono-Regular", "Fira Code", monospace' : 'Consolas, "Cascadia Code", "Fira Code", monospace',
          fontSize,
          lineHeight,
          cursorBlink,
          cursorStyle,
          cursorInactiveStyle: 'none',
          convertEol: false,
          allowTransparency: false,
          scrollback: 5000,
          // Alt+单击默认会向 CLI 发一串方向键来「移动光标」，在自绘界面的 CLI 里会造成乱跳
          altClickMovesCursor: false,
          // 搜索高亮用到 registerDecoration，属于 xterm 的 proposed API，不开启会直接抛错
          allowProposedApi: true,
          ...(isWindows ? { windowsPty: {
            backend: 'conpty',
            buildNumber: 26200,
          } } : {}),
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        // 挂载官方搜索插件
        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
          if (activeTaskIdRef.current === task.id) setSearchResult({ index: resultIndex, count: resultCount });
        });

        term.open(termContainer);

        // WebGL 渲染在终端显示时由下方的切换逻辑按需挂载，见 MAX_WEBGL_TERMINALS
        fitAddon.fit();

        const findAnchor = IME_ANCHOR_FINDERS[task.groupId];
        if (findAnchor) attachImeAnchor(term, termContainer, findAnchor);

        // 链接需按住 Ctrl 单击才打开，避免点终端聚焦或划选时误触；悬停时给出提示
        const linkHover = {
          hover: () => { termContainer.title = isMac ? t('按住 Command 单击打开') : t('按住 Ctrl 单击打开'); },
          leave: () => { termContainer.title = ''; },
        };

        // 注册超链接识别（支持 http://、https:// 等网页地址，Ctrl+单击拉起系统默认浏览器）
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            try {
              const logical = getLogicalLine(term, bufferLineNumber);
              if (!logical) {
                callback(undefined);
                return;
              }
              const urlRegex = /(https?:\/\/[^\s<>"'`]+)/g;
              const links: any[] = [];
              let match: RegExpExecArray | null;
              while ((match = urlRegex.exec(logical.text)) !== null) {
                const url = match[0];
                const range = matchToLinkRange(logical, match.index, url.length, bufferLineNumber);
                if (!range) continue;
                links.push({
                  text: url,
                  range,
                  ...linkHover,
                  activate: (e: MouseEvent, text: string) => {
                    if (!primaryModifierPressed(e)) return;
                    if (window.electronAPI?.openExternal) {
                      window.electronAPI.openExternal(text);
                    } else {
                      window.open(text, '_blank');
                    }
                  },
                });
              }
              callback(links.length > 0 ? links : undefined);
            } catch {
              callback(undefined);
            }
          },
        });

        // 识别任务工作目录内真实存在的文件路径（绝对或相对，可带 :行号），点击在右侧预览面板打开
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const logical = getLogicalLine(term, bufferLineNumber);
            const resolve = window.electronAPI?.resolvePreviewPaths;
            if (!logical || !resolve || !task.cwd) {
              callback(undefined);
              return;
            }
            const text = logical.text;
            const pathRegex = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\b)[\w.\-\u4e00-\u9fa5\\/]*?[\w\-\u4e00-\u9fa5]\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?(?![\w/\\]|\.\w)/g;
            const found: Array<{ raw: string; file: string; line?: number; range: NonNullable<ReturnType<typeof matchToLinkRange>> }> = [];
            let match: RegExpExecArray | null;
            while ((match = pathRegex.exec(text)) !== null && found.length < 20) {
              const raw = match[0];
              const range = matchToLinkRange(logical, match.index, raw.length, bufferLineNumber);
              if (!range) continue;
              const lineMatch = raw.match(/:(\d+)$/);
              found.push({ raw, range, file: raw.replace(/:\d+$/, ''), line: lineMatch ? Number(lineMatch[1]) : undefined });
            }
            if (found.length === 0) {
              callback(undefined);
              return;
            }
            resolve(task.cwd, found.map((item) => item.file))
              .then((resolved) => {
                const links = found.flatMap((item, index) => {
                  const target = resolved[index];
                  if (!target) return [];
                  return [{
                    text: item.raw,
                    range: item.range,
                    ...linkHover,
                    activate: (e: MouseEvent) => { if (primaryModifierPressed(e)) onPreviewFileRef.current?.(task.cwd, target, item.line); },
                  }];
                });
                callback(links.length > 0 ? links : undefined);
              })
              .catch(() => callback(undefined));
          },
        });

        // 绑定键盘输入并发送到 Electron 主进程
        term.onData((data) => {
          window.electronAPI?.writeSession(task.id, data);
        });

        // 监听终端尺寸变更并同步 PTY
        term.onResize(({ cols, rows }) => {
          window.electronAPI?.resizeSession(task.id, cols, rows);
        });

        // 立即拉取并回放主进程中的已有缓冲区
        window.electronAPI?.getSessionBuffer(task.id).then((buf) => {
          if (buf) {
            term.write(sanitizeTerminalData(buf));
          }
        });

        // 点击视窗任意位置自动聚焦
        termContainer.addEventListener('click', () => {
          term.focus();
        });

        // 复制划选文本到系统剪贴板
        const handleCopy = async (): Promise<boolean> => {
          if (term.hasSelection()) {
            const selectedText = term.getSelection();
            if (selectedText) {
              try {
                if (window.electronAPI?.writeClipboardText) {
                  await window.electronAPI.writeClipboardText(selectedText);
                } else {
                  await navigator.clipboard.writeText(selectedText);
                }
              } catch {
                try {
                  await navigator.clipboard.writeText(selectedText);
                } catch {}
              }
              term.clearSelection();
              return true;
            }
          }
          return false;
        };

        const handlePaste = async () => {
          try {
            if (window.electronAPI?.readPasteContent) {
              const res = await window.electronAPI.readPasteContent();
              if (res && res.content) {
                // term.paste 会按 CLI 是否启用 bracketed paste 包裹，并把换行归一，避免多行内容被逐行提交
                term.paste(res.content);
                return;
              }
            }
          } catch {}

          // 回退到浏览器原生剪贴板 API
          try {
            const text = await navigator.clipboard.readText();
            if (text) term.paste(text);
          } catch {}
        };

        // 右键交互（对齐 Windows Terminal 黄金标准）：
        // 1. 若当前有划选文本：右键执行复制并清除划选
        // 2. 若当前无划选文本：右键从剪贴板读取内容并粘贴进终端
        termContainer.addEventListener('contextmenu', async (e) => {
          e.preventDefault();
          if (term.hasSelection()) {
            await handleCopy();
          } else {
            await handlePaste();
          }
        });

        // 终端键盘事件拦截与快捷键增强
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== 'keydown') {
            return true;
          }

          // 0. Shift+Enter 换行：xterm 对 Enter 只区分 Alt，Shift+Enter 会和 Enter 一样直接提交。
          // 改发 ESC+CR（等同 Alt+Enter），多数 CLI 把它当作输入框内换行。
          // 纯系统终端（PowerShell / cmd）不认这个序列，保持原样。
          if (task.groupId !== 'terminal' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            window.electronAPI?.writeSession(task.id, '\x1b\r');
            return false;
          }

          // 1. 搜索快捷键 Ctrl+Shift+F（Ctrl+F 留给 CLI）
          if (primaryModifierPressed(e) && e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            setIsSearchOpen(true);
            return false;
          }

          // 2. 清屏快捷键 Ctrl+Shift+K（Ctrl+K 是 readline「删到行尾」）
          if (primaryModifierPressed(e) && e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            clearTerminal(task.id);
            return false;
          }

          // 3. 复制快捷键支持：
          // - Ctrl+C（无 Shift）：若有划选文本，执行复制并阻止向 PTY 发送 SIGINT 中断信号；若无划选，放行发送中断信号
          // - Ctrl+Shift+C 或 Ctrl+Insert：终端标准复制
          if (isMac && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
            e.preventDefault();
            if (term.hasSelection()) handleCopy();
            return false;
          }
          if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
            if (term.hasSelection()) {
              handleCopy();
              return false;
            }
            return true;
          }

          if (
            (!isMac && e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) ||
            (e.ctrlKey && e.key === 'Insert')
          ) {
            handleCopy();
            return false;
          }

          // 4. 粘贴快捷键支持：
          // - Ctrl+V / Ctrl+Shift+V
          // - Shift+Insert（传统终端粘贴）
          if (
            (primaryModifierPressed(e) && (e.key === 'v' || e.key === 'V')) ||
            (e.shiftKey && e.key === 'Insert')
          ) {
            // xterm 返回 false 时不会阻止默认行为，浏览器仍会触发原生 paste 事件，
            // xterm 的粘贴监听再写入一次 PTY，导致文本重复，因此这里必须 preventDefault。
            e.preventDefault();
            handlePaste();
            return false;
          }

          return true;
        });

        // 拖拽文件/图片到终端自动转换为文件路径
        termContainer.addEventListener('dragenter', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        termContainer.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
          }
        });
        termContainer.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const files = e.dataTransfer?.files;
          if (files && files.length > 0) {
            const paths: string[] = [];
            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              let p = '';
              try {
                p = window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(file) : ((file as any).path || '');
              } catch {
                p = (file as any).path || '';
              }
              if (p) {
                paths.push(p.includes(' ') ? `"${p}"` : p);
              }
            }
            if (paths.length > 0) {
              window.electronAPI?.writeSession(task.id, paths.join(' '));
              term.focus();
            }
          }
        });

        const instance: TerminalInstance = {
          term,
          fitAddon,
          searchAddon,
          webglAddon: undefined,
          container: termContainer,
          pendingData: '',
          flushTimer: null,
          flush: () => {
            if (instance.flushTimer) {
              clearTimeout(instance.flushTimer);
              instance.flushTimer = null;
            }
            if (instance.pendingData) {
              const sanitized = sanitizeTerminalData(instance.pendingData);
              instance.pendingData = '';
              instance.term.write(sanitized);
            }
          },
        };

        instancesRef.current.set(task.id, instance);
      }
    });

    // PTY 可能晚于 xterm 实例创建。任务状态变化（尤其 starting -> running）后
    // 再同步一次真实行列，避免 Kimi 重绘输入框时按默认 120 列发生横向回卷。
    if (activeTaskId) {
      const activeInstance = instancesRef.current.get(activeTaskId);
      if (activeInstance) {
        const status = tasks.find((task) => task.id === activeTaskId)?.status;
        requestAnimationFrame(() => {
          try {
            activeInstance.fitAddon.fit();
            const { cols, rows } = activeInstance.term;
            // 其他任务的状态变化也会触发这里；尺寸和本任务状态都没变时不重复通知 PTY
            const key = `${activeTaskId}:${cols}x${rows}:${status}`;
            if (lastSizeSyncRef.current === key) return;
            lastSizeSyncRef.current = key;
            window.electronAPI?.resizeSession(activeTaskId, cols, rows);
          } catch {
            // ignore
          }
        });
      }
    }
  }, [tasks, activeTaskId]);

  // 启动失败时把原因写进终端区，避免只剩空白；同一条错误只打印一次
  const printedErrorsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    tasks.forEach((task) => {
      const instance = instancesRef.current.get(task.id);
      if (!instance) return;
      if (task.status === 'error' && task.errorMessage) {
        if (printedErrorsRef.current.get(task.id) === task.errorMessage) return;
        printedErrorsRef.current.set(task.id, task.errorMessage);
        instance.term.write(`\r\n\x1b[31m[OneAI] ${t('启动失败：{reason}', { reason: task.errorMessage ?? '' })}\x1b[0m\r\n`);
      } else if (task.status !== 'error') {
        printedErrorsRef.current.delete(task.id);
      }
    });
  }, [tasks]);

  // 最近显示过的终端，越靠前越新；用来决定哪些隐藏终端保留 WebGL
  const recentShownRef = useRef<string[]>([]);
  const attachWebgl = (instance: TerminalInstance) => {
    if (instance.webglAddon) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (instance.webglAddon === addon) instance.webglAddon = undefined;
      });
      instance.term.loadAddon(addon);
      instance.webglAddon = addon;
    } catch (e) {
      console.warn('[OneAI] WebglAddon failed to load, fallback to DOM renderer:', e);
    }
  };

  // 当活动激活任务变化时，显示对应终端，隐藏其他终端，并自动 fit 和 focus
  useEffect(() => {
    if (activeTaskId && instancesRef.current.has(activeTaskId)) {
      recentShownRef.current = [activeTaskId, ...recentShownRef.current.filter((id) => id !== activeTaskId && instancesRef.current.has(id))];
      attachWebgl(instancesRef.current.get(activeTaskId)!);
      for (const id of recentShownRef.current.slice(MAX_WEBGL_TERMINALS)) {
        const stale = instancesRef.current.get(id);
        if (stale?.webglAddon) {
          stale.webglAddon.dispose();
          stale.webglAddon = undefined;
        }
      }
    }
    instancesRef.current.forEach((instance, id) => {
      const isCurrent = id === activeTaskId;
      instance.container.style.display = isCurrent ? 'block' : 'none';

      if (isCurrent) {
        setTimeout(() => {
          try {
            instance.fitAddon.fit();
            instance.term.focus();
            instance.term.refresh(0, instance.term.rows - 1);
            const { cols, rows } = instance.term;
            window.electronAPI?.resizeSession(id, cols, rows);
          } catch {
            // ignore
          }
        }, 50);
      }
    });
  }, [activeTaskId]);

  // 监听来自 Electron 主进程的 PTY stdout 数据流，通过微帧缓冲合并写入对应终端
  useEffect(() => {
    const unsubData = window.electronAPI?.onSessionData(({ id, data }) => {
      const instance = instancesRef.current.get(id);
      if (instance) {
        instance.pendingData += data;

        const inSync =
          instance.pendingData.includes('\x1b[?2026h') && !instance.pendingData.includes('\x1b[?2026l');
        const delay = inSync ? 25 : 16;

        if (!instance.flushTimer) {
          instance.flushTimer = setTimeout(() => {
            instance.flush();
          }, delay);
        }
      }
    });

    const unsubExit = window.electronAPI?.onSessionExit(({ id, exitCode }) => {
      const instance = instancesRef.current.get(id);
      if (instance) {
        instance.term.write(
          `\r\n\x1b[90m[OneAI] ${t('终端进程已退出 (退出码: {code})。可点击顶栏的重启按钮重新启动。', { code: exitCode })}\x1b[0m\r\n`
        );
      }
    });

    return () => {
      unsubData?.();
      unsubExit?.();
      instancesRef.current.forEach((instance) => {
        if (instance.flushTimer) {
          clearTimeout(instance.flushTimer);
          instance.flushTimer = null;
        }
      });
    };
  }, []);

  // 监听视窗容器尺寸变化，自适应重算当前活动终端
  useEffect(() => {
    if (!containerRef.current) return;

    let resizeTimer: NodeJS.Timeout | null = null;
    let lastCols = 0;
    let lastRows = 0;

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (activeTaskId) {
          const instance = instancesRef.current.get(activeTaskId);
          if (instance) {
            try {
              instance.fitAddon.fit();
              const { cols, rows } = instance.term;
              if (cols !== lastCols || rows !== lastRows) {
                lastCols = cols;
                lastRows = rows;
                window.electronAPI?.resizeSession(activeTaskId, cols, rows);
              }
            } catch {
              // ignore
            }
          }
        }
      }, 100);
    });

    resizeObserver.observe(containerRef.current);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
    };
  }, [activeTaskId]);

  return (
    <main className="flex-1 h-full w-full bg-canvas relative overflow-hidden">
      {/* 终端内悬浮关键字搜索栏 */}
      <TerminalSearchBar
        isOpen={isSearchOpen}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onFindNext={handleFindNext}
        onFindPrevious={handleFindPrevious}
        onClose={handleCloseSearch}
        matchCase={matchCase}
        onToggleMatchCase={handleToggleMatchCase}
        useRegex={useRegex}
        onToggleRegex={handleToggleRegex}
        resultText={searchResultText}
      />

      {/* 留白加在外层容器上，不能加在 .xterm 上 */}
      <div ref={containerRef} className="w-full h-full overflow-hidden px-6 pt-2" style={{ display: tasks.length === 0 ? 'none' : 'block' }} />
      {/* 没有可显示的活动任务时（含任务都在隐藏分组、或未选中任何任务）显示启动引导，避免中间空白 */}
      {!tasks.some((task) => task.id === activeTaskId) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center overflow-y-auto p-6 select-none">
          {emptyState || <p className="text-sm text-fg-faint">{t('暂无运行中的 CLI 任务')}</p>}
        </div>
      )}
    </main>
  );
});

TerminalViewport.displayName = 'TerminalViewport';
