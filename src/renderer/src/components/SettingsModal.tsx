import React, { useState } from 'react';
import { Clock, Keyboard, LucideIcon, Minus, Monitor, Moon, Palette, Plus, RotateCcw, Settings, SlidersHorizontal, SquareTerminal, Sun, TerminalSquare, Users } from 'lucide-react';
import { Account, AppSettings, CustomCli } from '../types';
import { THEME_OPTIONS } from '../themes';
import { Modal } from './Modal';
import { LANGUAGES, T, dateLocale, t } from '../i18n';
import { isMac, macShortcut } from '../platform';
import { AccountsSettings } from './AccountsSettings';
import { CliSettings } from './CliSettings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  onResetDefault: () => void;
  /** 设置 → 账号 → 登录：由 App 在该账号环境下新开终端任务运行登录命令 */
  onLoginAccount: (account: Account) => void;
  /** 设置 → CLI：内置与自动检测到的 CLI、检测结果（null 为尚未检测完成）、自定义 CLI 的增删改与重新检测 */
  fallbackKnownClis: Array<{ id: string; name: string; command: string }>;
  installed: Record<string, boolean> | null;
  onCustomClisChange: (customClis: CustomCli[]) => void;
  onRedetectClis: () => void;
}

type TabId = 'appearance' | 'terminal' | 'general' | 'accounts' | 'clis' | 'time' | 'shortcuts';

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: T('外观'), icon: Palette },
  { id: 'time', label: T('时间'), icon: Clock },
  { id: 'terminal', label: T('终端'), icon: TerminalSquare },
  { id: 'accounts', label: T('账号'), icon: Users },
  { id: 'clis', label: 'CLI', icon: SquareTerminal },
  { id: 'general', label: T('提醒'), icon: SlidersHorizontal },
  { id: 'shortcuts', label: T('快捷键'), icon: Keyboard },
];

const FONT_PRESETS = [13, 14, 15, 16, 18, 20];
const LINE_HEIGHTS = [
  { label: T('紧凑'), val: 1.2 },
  { label: T('标准'), val: 1.3 },
  { label: T('宽松'), val: 1.45 },
  { label: T('大行高'), val: 1.6 },
];

const UI_SCALES: { id: AppSettings['uiScale']; name: string; desc: string; pct: string }[] = [
  { id: 'compact', name: T('紧凑'), desc: T('信息密集'), pct: '90%' },
  { id: 'standard', name: T('标准'), desc: T('经典尺寸'), pct: '100%' },
  { id: 'comfortable', name: T('舒适（推荐）'), desc: T('清晰护眼'), pct: '110%' },
  { id: 'large', name: T('大号'), desc: T('适合 2K/4K'), pct: '125%' },
];

const CURSOR_STYLES: { id: AppSettings['terminalCursorStyle']; name: string; desc: string; icon: string }[] = [
  { id: 'bar', name: T('竖线（推荐）'), desc: T('不遮挡字符'), icon: '│' },
  { id: 'block', name: T('方块'), desc: T('经典实心方块'), icon: '█' },
  { id: 'underline', name: T('下划线'), desc: T('底部横线'), icon: '▁' },
];

const SHORTCUTS: { title: string; items: [string, string][] }[] = [
  {
    title: T('任务与界面'),
    items: [
      ['Ctrl + Tab / Ctrl + Shift + Tab', T('切换到下一个 / 上一个任务')],
      ['Ctrl + 1 … 9', T('切换到第 N 个任务')],
      ['Ctrl + Shift + T', T('沿用当前任务的 CLI，在当前文件夹一键新建任务')],
      ['Ctrl + Shift + N', T('新建任务并自定义名称、命令与目录')],
      ['Ctrl + Shift + W', T('关闭当前任务')],
      ['Alt + ↑ / ↓', T('焦点在侧栏任务或文件夹手柄上时调整顺序')],
      [T('鼠标中键'), T('关闭侧栏中的任务')],
      ['Ctrl + Shift + B', T('折叠或展开左侧导航栏')],
      ['Ctrl + Shift + H', T('打开历史会话')],
      ['Ctrl + Shift + U', T('打开本周用量')],
      ['Ctrl + ,', T('打开设置')],
      [T('F2 / 双击任务'), T('重命名任务')],
    ],
  },
  {
    title: T('终端'),
    items: [
      ['Ctrl + Shift + F', T('搜索终端内容')],
      ['Ctrl + Shift + K', T('清空屏幕与历史缓存')],
      ['Shift + Enter', T('在 AI CLI 输入框内换行')],
      [T('Ctrl + 单击'), T('打开终端里的网址或文件路径')],
      ['Ctrl + + / - / 0', T('放大 / 缩小 / 还原终端字号')],
      ['Ctrl + C', T('有选中文本时复制，否则中断命令')],
      [T('Ctrl + V / 右键'), T('粘贴文本或图片路径')],
    ],
  },
];

const Section: React.FC<{ title: string; hint?: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, hint, aside, children }) => (
  <section className="space-y-2.5">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-ui font-semibold text-fg">
        {title}
        {hint && <span className="ml-2 text-xs font-normal text-fg-faint">{hint}</span>}
      </h3>
      {aside}
    </div>
    {children}
  </section>
);

const Switch: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-control-hover'}`}
  >
    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
  </button>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onResetDefault,
  onLoginAccount,
  fallbackKnownClis,
  installed,
  onCustomClisChange,
  onRedetectClis,
}) => {
  const [tab, setTab] = useState<TabId>('appearance');
  const update = (patch: Partial<AppSettings>) => onUpdateSettings({ ...settings, ...patch });
  const setFontSize = (size: number) => update({ terminalFontSize: Math.max(12, Math.min(24, size)) });
  const clockOffset = Number.isFinite(settings.clockOffsetHours) ? settings.clockOffsetHours : 0;
  const reminderHours = Number.isFinite(settings.workReminderHours) ? settings.workReminderHours : 1;
  const setReminderHours = (hours: number) => update({ workReminderHours: Number.isFinite(hours) ? Math.max(1, Math.min(12, Math.trunc(hours))) : 1 });
  const setClockOffset =(hours: number) => update({ clockOffsetHours: Number.isFinite(hours) ? Math.max(-24, Math.min(24, Math.trunc(hours))) : 0 });
  const optionClass = (active: boolean) => (active ? 'option-active' : 'option');
  const row = 'flex items-center justify-between gap-3 rounded-md border border-line bg-muted px-3 py-2.5 text-ui text-fg-muted';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      titleId="settings-modal-title"
      title={t('设置')}
      icon={<Settings size={16} className="text-accent" />}
      widthClass="max-w-2xl"
      bare
      footer={(
        <>
          <button
            type="button"
            onClick={onResetDefault}
            className="mr-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            title={t('还原为：主题随系统、终端 15px、竖线光标、舒适缩放；账号与自定义 CLI 保留')}
          >
            <RotateCcw size={12} />
            <span>{t('恢复默认设置')}</span>
          </button>
          <button type="button" onClick={onClose} className="btn-primary px-5">{t('完成')}</button>
        </>
      )}
    >
      <div className="flex h-[60vh] min-h-0 select-none">
        <div role="tablist" aria-label={t('设置分类')} aria-orientation="vertical" className="w-36 shrink-0 space-y-0.5 border-r border-line bg-surface p-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-ui transition-colors ${tab === id ? 'bg-selected font-medium text-fg' : 'text-fg-subtle hover:bg-hover hover:text-fg'}`}
            >
              <Icon size={14} />
              {t(label)}
            </button>
          ))}
        </div>

        <div role="tabpanel" className="min-w-0 flex-1 space-y-6 overflow-y-auto p-5">
          {tab === 'appearance' && (
            <>
              <Section title={t('语言')} hint="Language">
                <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('界面语言')}>
                  {LANGUAGES.map(({ id, label: name }) => (
                    <button key={id} type="button" aria-pressed={settings.language === id}
                      onClick={() => update({ language: id })}
                      className={`flex items-center justify-center gap-1.5 py-2 ${optionClass(settings.language === id)}`}>
                      {name}
                    </button>
                  ))}
                </div>
              </Section>

              <Section title={t('主题')}>
                <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('主题色')}>
                  {([
                    { id: 'system', label: t('随系统'), icon: Monitor },
                    { id: 'light', label: t('浅色'), icon: Sun },
                    { id: 'dark', label: t('深色'), icon: Moon },
                  ] as const).map(({ id, label, icon: Icon }) => (
                    <button key={id} type="button" aria-pressed={settings.theme === id}
                      onClick={() => update({ theme: id })}
                      className={`flex items-center justify-center gap-1.5 py-2 ${optionClass(settings.theme === id)}`}>
                      <Icon size={14} />{label}
                    </button>
                  ))}
                </div>
                {([
                  { group: 'eyecare', title: t('护眼配色'), label: t('护眼主题色'), cols: 'grid-cols-4' },
                  { group: 'editor', title: t('编辑器配色（Sublime Text、JetBrains 等风格）'), label: t('编辑器配色主题'), cols: 'grid-cols-3' },
                ] as const).map(({ group, title, label, cols }) => (
                  <React.Fragment key={group}>
                    <div className="pt-1 text-xs text-fg-faint">{title}</div>
                    <div className={`grid ${cols} gap-2`} role="group" aria-label={label}>
                      {THEME_OPTIONS.filter((option) => option.group === group).map(({ id, label: name, swatch }) => (
                        <button key={id} type="button" aria-pressed={settings.theme === id}
                          onClick={() => update({ theme: id })}
                          className={`flex items-center justify-center gap-1.5 py-2 ${optionClass(settings.theme === id)}`}>
                          <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-line-strong"
                            style={{ background: `linear-gradient(135deg, ${swatch[0]} 50%, ${swatch[1]} 50%)` }} />
                          <span className="min-w-0 truncate">{name}</span>
                        </button>
                      ))}
                    </div>
                  </React.Fragment>
                ))}
              </Section>

              <Section title={t('界面缩放')} hint={t('侧栏、顶栏与弹窗的文字和元素大小')}>
                <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('界面全局字体与元素缩放')}>
                  {UI_SCALES.map((scale) => (
                    <button
                      key={scale.id}
                      type="button"
                      aria-pressed={settings.uiScale === scale.id}
                      onClick={() => update({ uiScale: scale.id })}
                      className={`flex items-center justify-between p-2.5 text-left ${optionClass(settings.uiScale === scale.id)}`}
                    >
                      <span>
                        <span className="block text-ui font-medium text-fg">{t(scale.name)}</span>
                        <span className="block text-2xs font-normal text-fg-faint">{t(scale.desc)}</span>
                      </span>
                      <span className="font-mono text-xs font-bold">{scale.pct}</span>
                    </button>
                  ))}
                </div>
              </Section>
            </>
          )}

          {tab === 'terminal' && (
            <>
              <Section
                title={t('字体大小')}
                hint={macShortcut(t('Ctrl + / - 亦可缩放'))}
                aside={<span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-xs font-bold text-accent">{settings.terminalFontSize}px</span>}
              >
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => setFontSize(settings.terminalFontSize - 1)} className="icon-btn border border-line-strong bg-muted" title={t('缩小字体')} aria-label={t('缩小字体')}>
                    <Minus size={13} />
                  </button>
                  <input
                    type="range"
                    min="12"
                    max="24"
                    step="1"
                    aria-label={t('终端字体大小')}
                    value={settings.terminalFontSize}
                    onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
                    className="slim flex-1"
                  />
                  <button type="button" onClick={() => setFontSize(settings.terminalFontSize + 1)} className="icon-btn border border-line-strong bg-muted" title={t('放大字体')} aria-label={t('放大字体')}>
                    <Plus size={13} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  {FONT_PRESETS.map((size) => (
                    <button key={size} type="button" onClick={() => setFontSize(size)}
                      className={`flex-1 py-1 font-mono ${optionClass(settings.terminalFontSize === size)}`}>
                      {size}px
                    </button>
                  ))}
                </div>
                <div className="overflow-hidden rounded-md border border-line bg-canvas p-3">
                  <div className="mb-1 text-2xs text-fg-faint">{t('效果预览')}</div>
                  <div
                    style={{
                      fontSize: `${settings.terminalFontSize}px`,
                      lineHeight: settings.terminalLineHeight,
                      fontFamily: 'Consolas, "Fira Code", monospace',
                    }}
                    className="select-text text-fg-muted"
                  >
                    <span className="text-accent">&gt;</span> const ai = new CLI(&apos;Kimi&apos;);
                    <br />
                    <span className="text-fg-faint">&gt;</span> <span className="text-warning">await</span> ai.complete(&apos;Hello OneAI&apos;);
                  </div>
                </div>
              </Section>

              <Section title={t('行高')}>
                <div className="grid grid-cols-4 gap-2" role="group" aria-label={t('终端行高')}>
                  {LINE_HEIGHTS.map((item) => {
                    const active = Math.abs(settings.terminalLineHeight - item.val) < 0.05;
                    return (
                      <button key={item.val} type="button" aria-pressed={active} onClick={() => update({ terminalLineHeight: item.val })}
                        className={`px-2 py-1.5 text-center ${optionClass(active)}`}>
                        {t(item.label)} <span className="font-mono opacity-70">{item.val}</span>
                      </button>
                    );
                  })}
                </div>
              </Section>

              <Section title={t('光标')}>
                <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('终端光标样式')}>
                  {CURSOR_STYLES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={settings.terminalCursorStyle === item.id}
                      onClick={() => update({ terminalCursorStyle: item.id })}
                      className={`flex items-center gap-2.5 p-2 text-left ${optionClass(settings.terminalCursorStyle === item.id)}`}
                    >
                      <span className="w-4 text-center font-mono text-base text-accent" aria-hidden="true">{item.icon}</span>
                      <span>
                        <span className="block text-xs font-medium text-fg">{t(item.name)}</span>
                        <span className="block text-2xs font-normal text-fg-faint">{t(item.desc)}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <div className={row}>
                  <span>{t('光标闪烁')}</span>
                  <Switch label={t('光标闪烁')} checked={settings.terminalCursorBlink} onChange={(checked) => update({ terminalCursorBlink: checked })} />
                </div>
              </Section>

              <Section title={t('文件预览')} hint={macShortcut(t('Ctrl + 单击终端里的文件路径打开'))}>
                <div className={row}>
                  <span>
                    <span className="block">{t('显示代码缩略图（minimap）')}</span>
                    <span className="block text-xs text-fg-faint">{t('预览文本文件时，在右侧显示类似 VS Code 的缩略图，点击或拖动即可快速滚动')}</span>
                  </span>
                  <Switch label={t('显示文件预览小地图')} checked={settings.previewMinimap !== false} onChange={(checked) => update({ previewMinimap: checked })} />
                </div>
              </Section>
            </>
          )}

          {tab === 'general' && (
            <>
              <Section title={t('工作时长提醒')}>
                <div className={row}>
                  <span>
                    <span className="block">{t('提醒时长')}</span>
                    <span className="block text-xs text-fg-faint">{t('从打开应用起算，默认 1 小时；可填 1 到 12 的整数')}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => setReminderHours(reminderHours - 1)} disabled={reminderHours <= 1} className="icon-btn border border-line-strong bg-canvas" title={t('减少 1 小时')} aria-label={t('提醒时长减少 1 小时')}>
                      <Minus size={13} />
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      step={1}
                      aria-label={t('工作时长提醒的小时数')}
                      value={reminderHours}
                      onChange={(e) => setReminderHours(e.target.value === '' ? 1 : Number(e.target.value))}
                      className="input w-16 select-text text-center font-mono"
                    />
                    <button type="button" onClick={() => setReminderHours(reminderHours + 1)} disabled={reminderHours >= 12} className="icon-btn border border-line-strong bg-canvas" title={t('增加 1 小时')} aria-label={t('提醒时长增加 1 小时')}>
                      <Plus size={13} />
                    </button>
                    <span className="text-xs text-fg-faint">{t('小时')}</span>
                  </span>
                </div>
                <div className={row}>
                  <span>
                    <span className="block">{t('到时语音播报')}</span>
                    <span className="block text-xs text-fg-faint">{t('关闭后仍会显示提醒弹框')}</span>
                  </span>
                  <Switch label={t('到时语音播报')} checked={settings.voiceReminderEnabled} onChange={(checked) => update({ voiceReminderEnabled: checked })} />
                </div>
              </Section>

              <Section title={t('音乐播放器')}>
                <div className={row}>
                  <span>
                    <span className="block">{t('显示音乐播放器')}</span>
                    <span className="block text-xs text-fg-faint">{t('关闭后侧栏底部不再显示播放器，正在播放的音乐会停止')}</span>
                  </span>
                  <Switch label={t('显示音乐播放器')} checked={settings.musicPlayerVisible} onChange={(checked) => update({ musicPlayerVisible: checked })} />
                </div>
                <div className={row}>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={settings.musicDirectory || t('系统「音乐」目录')}>
                    {settings.musicDirectory || t('系统「音乐」目录（默认）')}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      const dir = await window.electronAPI?.selectMusicDirectory?.(settings.musicDirectory);
                      if (dir) update({ musicDirectory: dir });
                    }}
                    className="btn-secondary px-2.5 py-1 text-xs"
                  >
                    {t('选择目录')}
                  </button>
                  {settings.musicDirectory && (
                    <button type="button" onClick={() => update({ musicDirectory: '' })} className="btn-secondary px-2.5 py-1 text-xs">
                      {t('恢复默认')}
                    </button>
                  )}
                </div>
                <p className="text-xs text-fg-faint">{t('扫描所选目录下的 mp3 / wav / ogg / m4a / flac / aac / opus 文件，不含子目录；找到音乐后播放器显示在侧栏底部。')}</p>
              </Section>
            </>
          )}

          {tab === 'accounts' && (
            <AccountsSettings
              isActive={isOpen && tab === 'accounts'}
              accounts={settings.accounts}
              onChange={(accounts) => update({ accounts })}
              onLogin={onLoginAccount}
            />
          )}

          {tab === 'clis' && (
            <CliSettings
              fallbackKnownClis={fallbackKnownClis}
              customClis={settings.customClis}
              installed={installed}
              onChange={onCustomClisChange}
              onRedetect={onRedetectClis}
            />
          )}

          {tab === 'time' && (
            <Section title={t('顶栏时钟')} hint={t('在系统时间上增加的小时数')}>
              <div className={row}>
                <span>
                  <span className="block">{t('增加小时数')}</span>
                  <span className="block text-xs text-fg-faint">{t('默认 0，显示系统时间；可填 -24 到 24 的整数')}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={() => setClockOffset(clockOffset - 1)} disabled={clockOffset <= -24} className="icon-btn border border-line-strong bg-canvas" title={t('减少 1 小时')} aria-label={t('减少 1 小时')}>
                    <Minus size={13} />
                  </button>
                  <input
                    type="number"
                    min={-24}
                    max={24}
                    step={1}
                    aria-label={t('顶栏时钟增加的小时数')}
                    value={clockOffset}
                    onChange={(e) => setClockOffset(e.target.value === '' ? 0 : Number(e.target.value))}
                    className="input w-16 select-text text-center font-mono"
                  />
                  <button type="button" onClick={() => setClockOffset(clockOffset + 1)} disabled={clockOffset >= 24} className="icon-btn border border-line-strong bg-canvas" title={t('增加 1 小时')} aria-label={t('增加 1 小时')}>
                    <Plus size={13} />
                  </button>
                  <span className="text-xs text-fg-faint">{t('小时')}</span>
                </span>
              </div>
              <div className={row}>
                <span>
                  <span className="block">{t('显示年月日')}</span>
                  <span className="block text-xs text-fg-faint">{t('窗口最大化时，顶栏时钟显示年月日（简体中文界面含农历）与星期；关闭后只显示时间')}</span>
                </span>
                <Switch label={t('显示年月日')} checked={settings.topbarDateVisible !== false} onChange={(checked) => update({ topbarDateVisible: checked })} />
              </div>
              <p className="text-xs text-fg-faint">
                {t('当前顶栏显示：{time}', { time: new Date(Date.now() + clockOffset * 3600_000).toLocaleString(dateLocale(), { hour12: false }) })}
                {clockOffset !== 0 && t('（系统时间 {sign}{n} 小时）', { sign: clockOffset > 0 ? '+' : '', n: clockOffset })}
              </p>
            </Section>
          )}

          {tab === 'shortcuts' && SHORTCUTS.map((group) => (
            <Section key={group.title} title={t(group.title)}>
              <dl className="divide-y divide-line overflow-hidden rounded-md border border-line">
                {group.items.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center justify-between gap-4 bg-muted px-3 py-2">
                    <dt className="text-ui text-fg-muted">{isMac && keys === 'Ctrl + C' ? t('复制选中文本；Ctrl+C 中断命令') : t(desc)}</dt>
                    <dd className="shrink-0 rounded border border-line-strong bg-canvas px-1.5 py-0.5 font-mono text-xs text-fg-subtle">{isMac && keys.startsWith('Ctrl + Tab') ? t(keys) : macShortcut(t(keys))}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          ))}
        </div>
      </div>
    </Modal>
  );
};
