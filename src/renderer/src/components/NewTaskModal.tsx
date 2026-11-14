import React, { useState } from 'react';
import { FolderOpen, Play } from 'lucide-react';
import { Account, CliDef, TaskSession } from '../types';
import { folderName, nextTaskTitle, tasksInFolder } from '../workspaceState';
import { BrandIcon } from './BrandIcon';
import { Modal } from './Modal';
import { t } from '../i18n';
import { isMac } from '../platform';

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 可选的 CLI（本机已安装的） */
  clis: CliDef[];
  /** 打开时预选的 CLI */
  initialCliId?: string;
  /** 新任务默认的工作目录，即在哪个文件夹上点的「+」 */
  folderPath: string;
  /** 用于生成默认任务名（取该文件夹里已有的「Task N」） */
  tasks: TaskSession[];
  /** 配置了多账号的 CLI 可在弹窗中选择账号；accountId 缺省为默认账号 */
  accounts?: Account[];
  onCreate: (cliId: string, title: string, command: string, cwd: string, accountId?: string) => Promise<{ success: boolean; error?: string }>;
}

export const NewTaskModal: React.FC<NewTaskModalProps> = ({
  isOpen,
  onClose,
  clis,
  initialCliId,
  folderPath,
  tasks,
  accounts = [],
  onCreate,
}) => {
  const [cliId, setCliId] = useState('');
  const [title, setTitle] = useState('');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 打开时初始化预设值
  React.useEffect(() => {
    if (!isOpen) return;
    const cli = clis.find((item) => item.id === initialCliId) ?? clis[0];
    setCliId(cli?.id ?? '');
    setTitle(nextTaskTitle(tasksInFolder(tasks, folderPath)));
    setCommand(cli?.defaultCommand ?? '');
    setCwd(folderPath);
    setAccountId('');
    setError('');
  }, [isOpen, initialCliId, folderPath]);

  const cli = clis.find((item) => item.id === cliId);
  if (!isOpen || !cli) return null;
  const cliAccounts = accounts.filter((account) => account.cliId === cli.id);

  const changeCli = (id: string) => {
    const next = clis.find((item) => item.id === id);
    if (!next) return;
    setCliId(id);
    setCommand(next.defaultCommand);
    setAccountId('');
  };

  const handleChooseDirectory = async () => {
    try {
      const selected = await window.electronAPI?.selectWorkspaceDirectory?.(cwd || folderPath);
      if (selected) {
        setCwd(selected);
        setError('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('无法选择工作目录'));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setError('');
    try {
      const result = await onCreate(cli.id, title.trim(), command.trim(), cwd.trim(), accountId || undefined);
      if (result.success) onClose();
      else setError(result.error || t('终端启动失败，请检查工作目录和启动命令。'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('终端启动失败'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const label = 'mb-1.5 block text-xs font-medium text-fg-muted';
  const hint = 'mt-1.5 text-xs text-fg-faint';

  return (
    <Modal
      isOpen
      onClose={onClose}
      closeDisabled={isSubmitting}
      titleId="new-task-modal-title"
      title={t('新建任务 · {folder}', { folder: folderName(folderPath) })}
      icon={<BrandIcon icon={cli.icon} size={18} />}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={isSubmitting} className="btn-secondary">{t('取消')}</button>
          <button type="submit" form="new-task-form" disabled={isSubmitting || !title.trim()} className="btn-primary">
            <Play size={12} fill="currentColor" />
            <span>{isSubmitting ? t('正在启动…') : t('启动任务')}</span>
          </button>
        </>
      )}
    >
      <form id="new-task-form" onSubmit={handleSubmit} className="space-y-4">
        {error && <div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
        {clis.length > 1 && (
          <div>
            <label htmlFor="new-task-cli" className={label}>CLI</label>
            <select id="new-task-cli" value={cli.id} onChange={(e) => changeCli(e.target.value)} className="input">
              {clis.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="new-task-title" className={label}>{t('任务名称')}</label>
          <input
            id="new-task-title"
            type="text"
            autoFocus
            value={title}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setTitle(e.target.value)}
            className="input"
            placeholder={t('例如：Auth Refactor')}
            required
          />
        </div>

        {cliAccounts.length > 0 && (
          <div>
            <label htmlFor="new-task-account" className={label}>{t('账号')}</label>
            <select id="new-task-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="input">
              <option value="">{t('默认账号')}</option>
              {cliAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <p className={hint}>{t('账号使用各自独立的配置目录；首次使用请先在「设置 → 账号」中登录。')}</p>
          </div>
        )}

        <div>
          <label htmlFor="new-task-command" className={label}>{t('启动命令')}</label>
          <input
            id="new-task-command"
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="input font-mono"
            placeholder={isMac ? t('例如：/bin/zsh') : t('例如：powershell.exe')}
          />
          <p className={hint}>{isMac ? t('留空则启动系统的默认交互式 Shell。') : t('留空则启动系统的交互式 PowerShell。')}</p>
        </div>

        <div>
          <label htmlFor="new-task-cwd" className={label}>{t('工作目录')}</label>
          <div className="flex gap-2">
            <input
              id="new-task-cwd"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              className="input min-w-0 flex-1 font-mono"
              placeholder={folderPath}
            />
            <button
              type="button"
              onClick={handleChooseDirectory}
              disabled={isSubmitting}
              className="btn-secondary"
              title={t('为此任务选择工作目录')}
            >
              <FolderOpen size={14} />
              <span>{t('选择文件夹')}</span>
            </button>
          </div>
          <p className={hint}>{t('改成其他目录时，任务会出现在对应的文件夹下。')}</p>
        </div>
      </form>
    </Modal>
  );
};
