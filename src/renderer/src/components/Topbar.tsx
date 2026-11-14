import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, ChevronRight, Search, Eraser, RotateCcw, Download, Copy, FileText, Check, PanelLeftClose, PanelLeftOpen, History, BarChart3 } from 'lucide-react';
import { InlineQuotaText } from './InlineQuotaText';
import { SystemStatsText } from './SystemStatsText';
import { QuotaData, TaskSession, CliDef } from '../types';
import { TASK_STATUS_META } from '../taskStatus';
import { BrandIcon } from './BrandIcon';
import { getLanguage, t } from '../i18n';
import { macShortcut } from '../platform';

interface TopbarProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  currentGroup: CliDef | null;
  activeTask: TaskSession | null;
  /** 当前任务使用的账号名；默认账号时缺省 */
  accountName?: string;
  /** 没有活动任务时显示的当前文件夹（新任务将在此启动）与 Git 分支 */
  emptyFolder?: { name: string; branch?: string | null };
  quota: QuotaData | null;
  clockOffsetHours?: number;
  /** 窗口最大化时是否在时钟里显示年月日（含农历）与星期，默认显示；设置 → 时间 里可关闭 */
  dateVisible?: boolean;
  onRefreshQuota: () => Promise<void>;
  onOpenSearch?: () => void;
  onClearScreen?: () => void;
  onRestartSession?: () => Promise<void>;
  onExportLogs?: (mode: 'copy' | 'save') => Promise<{ success: boolean; error?: string; canceled?: boolean }>;
  onOpenHistory?: () => void;
  onOpenUsage?: () => void;
}

// 数字日期转中文数字（1~30）
function toChineseDay(n: number): string {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (n <= 10) return digits[n];
  if (n < 20) return `十${digits[n - 10]}`;
  if (n === 20) return '二十';
  if (n < 30) return `二十${digits[n - 20]}`;
  return '三十';
}

function getLunarStr(now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'long',
      day: 'numeric',
    }).formatToParts(now);
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    const dayNum = parseInt(parts.find((p) => p.type === 'day')?.value ?? '0', 10);
    return `${month}${toChineseDay(dayNum)}日`;
  } catch {
    return '';
  }
}

// offsetHours：顶栏时间相对系统时间增加的小时数，在设置的「时间」栏目中配置
function getFormattedTime(maximized: boolean, offsetHours: number, dateVisible: boolean): string {
  const now = new Date(Date.now() + (Number.isFinite(offsetHours) ? offsetHours : 0) * 60 * 60 * 1000);
  const weekdays = [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')];
  const Y = now.getFullYear();
  const M = String(now.getMonth() + 1).padStart(2, '0');
  const D = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  if (!maximized || !dateVisible) return `${h}:${m}:${s}`;
  const w = weekdays[now.getDay()];
  // 农历只在简体中文界面显示
  const lunar = getLanguage() === 'zh-CN' ? getLunarStr(now) : '';
  const lunarPart = lunar ? `（${lunar}）` : '';
  return `${Y}-${M}-${D}${lunarPart} ${h}:${m}:${s} ${t('（{weekday}）', { weekday: w })}`;
}

export const Topbar: React.FC<TopbarProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  currentGroup,
  activeTask,
  accountName,
  emptyFolder,
  quota,
  clockOffsetHours = 0,
  dateVisible = true,
  onRefreshQuota,
  onOpenSearch,
  onClearScreen,
  onRestartSession,
  onExportLogs,
  onOpenHistory,
  onOpenUsage,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [currentTime, setCurrentTime] = useState<string>(() => getFormattedTime(false, clockOffsetHours, dateVisible));
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [action, setAction] = useState<{ text: string; ok: boolean } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const actionTimerRef = useRef(0);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.electronAPI.onWindowMaximizedChange(setIsMaximized);
    window.electronAPI.isWindowMaximized().then((maximized) => {
      if (active) setIsMaximized(maximized);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // 每秒更新时钟，窗口状态或时间偏移变化时立即刷新
  useEffect(() => {
    setCurrentTime(getFormattedTime(isMaximized, clockOffsetHours, dateVisible));
    const timer = setInterval(() => {
      setCurrentTime(getFormattedTime(isMaximized, clockOffsetHours, dateVisible));
    }, 1000);
    return () => clearInterval(timer);
  }, [isMaximized, clockOffsetHours, dateVisible]);

  // 点击外部或按 Esc 关闭导出下拉菜单
  useEffect(() => {
    if (!isExportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsExportMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExportMenuOpen]);

  useEffect(() => () => window.clearTimeout(actionTimerRef.current), []);

  const showAction = (text: string, ok: boolean) => {
    setAction({ text, ok });
    window.clearTimeout(actionTimerRef.current);
    actionTimerRef.current = window.setTimeout(() => setAction(null), 2500);
  };

  const handleCopyLogs = async () => {
    setIsExportMenuOpen(false);
    const result = await onExportLogs?.('copy');
    if (result?.success) showAction(t('会话文本已复制'), true);
    else showAction(t('复制失败：{reason}', { reason: result?.error || t('操作未完成') }), false);
  };

  const handleSaveLogs = async () => {
    setIsExportMenuOpen(false);
    const result = await onExportLogs?.('save');
    if (result?.success) showAction(t('日志已保存'), true);
    else if (!result?.canceled) showAction(t('保存失败：{reason}', { reason: result?.error || t('操作未完成') }), false);
  };

  const status = activeTask ? TASK_STATUS_META[activeTask.status] : null;
  const menuItem = 'flex w-full items-center gap-2 px-3 py-2 text-left text-fg-muted transition-colors hover:bg-hover hover:text-fg';

  return (
    <header className="topbar relative z-10 flex h-11 shrink-0 select-none items-center gap-2 border-b border-line bg-panel px-2.5">
      {/* 左侧：侧栏开关、会话面包屑与终端工具；面包屑在空间不足时自动截断 */}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-ui text-fg-muted">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={isSidebarCollapsed ? t('展开左侧导航栏') : t('折叠左侧导航栏')}
          aria-expanded={!isSidebarCollapsed}
          aria-controls="oneai-sidebar"
          title={macShortcut(`${isSidebarCollapsed ? t('展开左侧导航栏') : t('折叠左侧导航栏')} (Ctrl+Shift+B)`)}
          className="icon-btn"
        >
          {isSidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        <div className="h-4 w-px shrink-0 bg-line-strong" />
        {currentGroup ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <BrandIcon icon={currentGroup.icon} size={16} />
            <span className="topbar-group-name shrink-0 font-medium text-fg">{currentGroup.name}</span>
            {activeTask && status && (
              <>
                <ChevronRight size={13} className="topbar-group-name shrink-0 text-fg-faint" />
                <span className="min-w-0 max-w-[18rem] truncate text-fg-muted" title={activeTask.title}>
                  {activeTask.title}
                </span>
                {accountName && (
                  <span className="topbar-account max-w-[7rem] shrink-0 truncate rounded border border-line-strong px-1.5 py-px text-2xs text-fg-subtle" title={t('账号：{name}', { name: accountName })}>
                    {accountName}
                  </span>
                )}
                <span
                  className={`ml-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs ${status.badge}`}
                  title={status.hint}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
                  <span className="topbar-status-label">{status.label}</span>
                </span>
              </>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5 text-fg-faint">
            <FolderOpen size={14} className="shrink-0 text-accent" />
            <span className="truncate font-medium text-fg-muted" data-empty-folder>{emptyFolder?.name ?? t('无活动终端会话')}</span>
            {emptyFolder?.branch && <span className="shrink-0 rounded-full border border-violet/30 bg-violet/10 px-1.5 text-2xs text-violet">{emptyFolder.branch}</span>}
            {emptyFolder && <span className="truncate">{t('· 选择 CLI 开始任务')}</span>}
          </div>
        )}

        {/* 终端工具 */}
        {activeTask && (
          <div id="oneai-terminal-tools" role="group" aria-label={t('终端工具')} className="flex shrink-0 items-center gap-0.5 border-l border-line pl-2">
            <button type="button" onClick={onOpenSearch} title={macShortcut(t('在终端中搜索关键词 (Ctrl+Shift+F)'))} aria-label={t('在终端中搜索')} className="icon-btn">
              <Search size={15} />
            </button>
            <button type="button" onClick={onClearScreen} title={macShortcut(t('清空当前屏幕与历史缓存 (Ctrl+Shift+K)'))} aria-label={t('清空屏幕')} className="icon-btn">
              <Eraser size={15} />
            </button>
            <button
              type="button"
              onClick={onRestartSession}
              title={activeTask.status === 'stopped' || activeTask.status === 'error' ? t('启动当前终端') : activeTask.status === 'starting' ? t('终端正在启动') : t('重启当前终端（保持当前目录与配置）')}
              aria-label={t('重启终端')}
              disabled={activeTask.status === 'starting'}
              className="icon-btn enabled:hover:text-warning"
            >
              <RotateCcw size={15} />
            </button>

            <div className="relative" ref={exportMenuRef}>
              <button
                type="button"
                onClick={() => setIsExportMenuOpen((v) => !v)}
                title={t('导出或复制会话日志')}
                aria-label={t('导出或复制会话日志')}
                aria-haspopup="menu"
                aria-expanded={isExportMenuOpen}
                className={`icon-btn ${isExportMenuOpen ? 'bg-hover text-fg' : ''}`}
              >
                {action?.ok ? <Check size={15} className="text-success" /> : <Download size={15} />}
              </button>

              {isExportMenuOpen && (
                <div role="menu" className="absolute left-0 z-50 mt-1.5 w-48 overflow-hidden rounded-lg border border-line-strong bg-elevated py-1 text-xs shadow-xl">
                  <button type="button" role="menuitem" autoFocus onClick={handleCopyLogs} className={menuItem}>
                    <Copy size={13} className="text-fg-subtle" />
                    <span>{t('复制最近会话文本')}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={handleSaveLogs} className={menuItem}>
                    <FileText size={13} className="text-fg-subtle" />
                    <span>{t('另存为日志文件…')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {action && (
          <span role="status" className={`min-w-0 truncate text-2xs ${action.ok ? 'text-success' : 'text-danger'}`} title={action.text}>
            {action.text}
          </span>
        )}
      </div>

      {/* 时钟：空间不足时由 .topbar-clock 收起 */}
      <div id="oneai-topbar-clock" className="topbar-clock pointer-events-none shrink-0 px-1.5 font-mono text-xs font-medium tabular-nums tracking-wide text-fg-subtle">
        {currentTime}
      </div>

      {/* 右侧：单行横排纯文字大模型配额（无弹窗、无浮窗）；没有活动终端的空页面不显示额度与刷新按钮 */}
      {activeTask && (
        <div id="oneai-topbar-quota" className="flex shrink-0 items-center whitespace-nowrap border-l border-line pl-2.5">
          <InlineQuotaText quota={quota} onRefresh={onRefreshQuota} />
        </div>
      )}

      {/* 整机 CPU / 内存 / 网速：与活动终端无关，始终显示；空间不足时由 .topbar-sys-* 依次收起 */}
      <SystemStatsText />

      {onOpenUsage && (
        <button
          type="button"
          onClick={onOpenUsage}
          aria-label={t('查看本周用量')}
          title={macShortcut(t('本周各模型用量与每日使用频次 (Ctrl+Shift+U)'))}
          className="icon-btn"
        >
          <BarChart3 size={16} />
        </button>
      )}

      {onOpenHistory && (
        <button
          type="button"
          onClick={onOpenHistory}
          aria-label={t('查看历史会话')}
          title={macShortcut(t('查看所有 CLI 的历史会话 (Ctrl+Shift+H)'))}
          className="icon-btn"
        >
          <History size={16} />
        </button>
      )}
    </header>
  );
};
