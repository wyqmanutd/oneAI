import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** The user's interactive shell, rather than a Windows-only executable. */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/** Quote a shell executable path when it is embedded in a shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Finder/Spotlight apps do not necessarily inherit the PATH that Terminal gets
 * from the user's login shell. Read it once before detecting or launching CLIs.
 * Keep the original PATH and common installation directories as fallbacks.
 */
export async function initializeMacPath(): Promise<void> {
  if (process.platform !== 'darwin') return;

  const existing = process.env.PATH || '';
  const home = os.homedir();
  const common = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/local/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
  ];

  const loginPath = await new Promise<string>((resolve) => {
    execFile(defaultShell(), ['-l', '-c', 'printf "__ONEAI_PATH__%s\\n" "$PATH"'], {
      timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8',
    }, (_error, stdout) => {
      const match = stdout?.match(/__ONEAI_PATH__(.*)/g)?.at(-1);
      resolve(match ? match.slice('__ONEAI_PATH__'.length).trim() : '');
    });
  });

  const segments = [loginPath, existing, ...common]
    .flatMap((item) => item.split(path.delimiter))
    .filter(Boolean);
  process.env.PATH = [...new Set(segments)].join(path.delimiter);
}
