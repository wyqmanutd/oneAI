import pty from 'node-pty';

// Run on an Apple Silicon macOS host before packaging. This checks the native
// addon and that an interactive login shell can execute a command with args.
if (process.platform !== 'darwin') {
  console.log('macOS PTY smoke test: skipped (not macOS)');
} else {
  await new Promise((resolve, reject) => {
    let output = '';
    let finished = false;
    const term = pty.spawn('/bin/zsh', [
      '-l', '-i', '-c', 'printf "ONEAI_MAC_PTY_OK:%s\\n" "two words"',
    ], {
      name: 'xterm-256color', cols: 80, rows: 24,
      cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' },
    });
    const timer = setTimeout(() => {
      term.kill();
      if (!finished) {
        finished = true;
        reject(new Error('macOS PTY smoke test timed out'));
      }
    }, 15000);
    term.onData((chunk) => { output += chunk; });
    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (exitCode === 0 && output.includes('ONEAI_MAC_PTY_OK:two words')) resolve();
      else reject(new Error(`macOS PTY smoke test failed (exit ${exitCode}): ${output}`));
    });
  });
  console.log('macOS PTY smoke test: OK');
}
