import React, { useEffect, useState } from 'react';
import { Pencil, Plus, RotateCw, Trash2 } from 'lucide-react';
import { CustomCli } from '../types';
import { newCustomCliId, validateCustomCli } from '../customClis';
import { t } from '../i18n';
import { isMac } from '../platform';

interface KnownCli {
  id: string;
  name: string;
  command: string;
}

interface CliSettingsProps {
  /** 主进程里已知 CLI 清单的备用值（读取失败或非 Electron 预览时使用） */
  fallbackKnownClis: KnownCli[];
  customClis: CustomCli[];
  /** 已检测到的 CLI；null 表示检测尚未完成 */
  installed: Record<string, boolean> | null;
  onChange: (customClis: CustomCli[]) => void;
  onRedetect: () => void;
}

interface Draft {
  id?: string;
  name: string;
  command: string;
}

const label = 'mb-1.5 block text-xs font-medium text-fg-muted';

function InstalledBadge({ installed, id }: { installed: Record<string, boolean> | null; id: string }) {
  if (!installed) return <span className="shrink-0 text-xs text-fg-faint">{t('检测中…')}</span>;
  return installed[id]
    ? <span className="shrink-0 text-xs text-success">{t('已安装')}</span>
    : <span className="shrink-0 text-xs text-warning">{t('未检测到')}</span>;
}

/** 设置 → CLI：查看自动检测结果，并添加自己的 CLI（名称 + 启动命令） */
export const CliSettings: React.FC<CliSettingsProps> = ({ fallbackKnownClis, customClis, installed, onChange, onRedetect }) => {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 已知 CLI 清单来自主进程（known-clis.json），不在界面里写死
  const [knownClis, setKnownClis] = useState<KnownCli[]>(fallbackKnownClis);
  useEffect(() => {
    let active = true;
    window.electronAPI?.listKnownClis?.().then((list) => { if (active && Array.isArray(list) && list.length > 0) setKnownClis(list); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const save = () => {
    if (!draft) return;
    const problem = validateCustomCli(draft, customClis.filter((cli) => cli.id !== draft.id), knownClis.map((cli) => cli.name));
    if (problem) {
      setError(problem);
      return;
    }
    const saved: CustomCli = { id: draft.id ?? newCustomCliId(), name: draft.name.trim(), command: draft.command.trim() };
    onChange(draft.id ? customClis.map((cli) => (cli.id === saved.id ? saved : cli)) : [...customClis, saved]);
    setDraft(null);
    setError('');
  };

  return (
    <>
      <section className="space-y-2.5" aria-label={t('自动检测的 CLI')}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ui font-semibold text-fg">
            {t('自动检测')}
            <span className="ml-2 text-xs font-normal text-fg-faint">{t('按 PATH 查找命令，启动时检测一次')}</span>
          </h3>
          <button type="button" onClick={onRedetect} className="btn-secondary px-2.5 py-1 text-xs" title={t('重新检测已安装的 CLI，新装 CLI 后点这里即可，不必重启')}>
            <RotateCw size={12} />{t('重新检测')}
          </button>
        </div>
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
          {knownClis.map((cli) => (
            <li key={cli.id} data-cli-id={cli.id} className="flex items-center justify-between gap-3 bg-muted px-3 py-2 text-ui text-fg-muted">
              <span className="min-w-0">
                <span className="block truncate text-fg">{cli.name}</span>
                <span className="block truncate font-mono text-xs text-fg-faint">{cli.command}</span>
              </span>
              <InstalledBadge installed={installed} id={cli.id} />
            </li>
          ))}
        </ul>
        <p className="text-xs leading-relaxed text-fg-faint">
          {t('以上是 OneAI 已知的 CLI，安装后会自动出现在新建菜单里。不在其中的 CLI，请在下方添加。')}
        </p>
      </section>

      <section className="space-y-2.5" aria-label={t('自定义 CLI')}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ui font-semibold text-fg">
            {t('自定义 CLI')}
            <span className="ml-2 text-xs font-normal text-fg-faint">{t('名称 + 启动命令')}</span>
          </h3>
          <button type="button" onClick={() => { setDraft({ name: '', command: '' }); setError(''); }} disabled={Boolean(draft && !draft.id)} className="btn-secondary px-2.5 py-1 text-xs">
            <Plus size={12} />{t('添加 CLI')}
          </button>
        </div>

        {customClis.length === 0 && !draft && (
          <p className="rounded-md border border-dashed border-line px-3 py-3 text-xs leading-relaxed text-fg-faint">
            {t('还没有自定义 CLI。添加后它会和内置 CLI 一样出现在文件夹「+」菜单里，使用通用终端图标；额度、任务摘要、历史会话与用量统计只对内置的 CLI 提供。')}
          </p>
        )}

        {customClis.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
            {customClis.map((cli) => (
              <li key={cli.id} data-custom-cli-id={cli.id} className="flex items-center justify-between gap-3 bg-muted px-3 py-2 text-ui text-fg-muted">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg">{cli.name}</span>
                    <InstalledBadge installed={installed} id={cli.id} />
                  </span>
                  <span className="block truncate font-mono text-xs text-fg-faint" title={cli.command}>{cli.command}</span>
                </span>
                {confirmDeleteId === cli.id ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs text-danger">{t('会关闭并移除它的所有任务')}</span>
                    <button type="button" onClick={() => { onChange(customClis.filter((item) => item.id !== cli.id)); setConfirmDeleteId(null); }} className="btn-danger px-2.5 py-1 text-xs">{t('确认删除')}</button>
                    <button type="button" onClick={() => setConfirmDeleteId(null)} className="btn-secondary px-2.5 py-1 text-xs">{t('取消')}</button>
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => { setDraft({ id: cli.id, name: cli.name, command: cli.command }); setError(''); }} className="icon-btn" title={t('编辑')} aria-label={t('编辑 {name}', { name: cli.name })}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteId(cli.id)} className="icon-btn enabled:hover:text-danger" title={t('删除')} aria-label={t('删除 {name}', { name: cli.name })}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {draft && (
          <form
            aria-label={draft.id ? t('编辑自定义 CLI') : t('添加自定义 CLI')}
            onSubmit={(e) => { e.preventDefault(); save(); }}
            className="space-y-3 rounded-md border border-accent/40 bg-canvas p-3"
          >
            {error && <div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
            <div>
              <label htmlFor="custom-cli-name" className={label}>{t('CLI 名称')}</label>
              <input id="custom-cli-name" autoFocus className="input select-text" value={draft.name} placeholder={t('例如：我的 Agent')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="custom-cli-command" className={label}>{t('启动命令')}</label>
              <input id="custom-cli-command" className="input select-text font-mono" value={draft.command} placeholder="mycli --model fast"
                onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
              <p className="mt-1.5 text-xs text-fg-faint">
                {isMac
                  ? t('可带参数，在新任务的登录 Shell 中运行；命令必须在 PATH 中，也可以写完整路径。未找到命令时它不会出现在新建菜单里。')
                  : t('可带参数，在新任务的终端（PowerShell）里原样执行，需要这个命令已在 PATH 中；也可以写完整路径，路径有空格时加引号。未找到命令时它不会出现在新建菜单里。')}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setDraft(null); setError(''); }} className="btn-secondary">{t('取消')}</button>
              <button type="submit" className="btn-primary">{t('保存')}</button>
            </div>
          </form>
        )}
      </section>
    </>
  );
};
