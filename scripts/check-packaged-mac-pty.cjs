const path = require('node:path');

// Invoked with ELECTRON_RUN_AS_NODE=1 and the packaged Electron executable.
// Loading through app.asar exercises the same native addon/helper resolution
// path used by the installed application (not the development node_modules).
const packagePath = path.join(
  process.cwd(), 'release', 'mac-arm64', 'OneAI.app', 'Contents',
  'Resources', 'app.asar', 'node_modules', 'node-pty',
);
const pty = require(packagePath);

new Promise((resolve, reject) => {
  let output = '';
  let finished = false;
  const term = pty.spawn('/bin/zsh', [
    '-l', '-i', '-c', 'printf "ONEAI_PACKAGED_PTY_OK:%s\\n" "two words"',
  ], {
    name: 'xterm-256color', cols: 80, rows: 24,
    cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' },
  });
  const timer = setTimeout(() => {
    term.kill();
    if (!finished) {
      finished = true;
      reject(new Error('Packaged macOS PTY timed out'));
    }
  }, 15000);
  term.onData((chunk) => { output += chunk; });
  term.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (finished) return;
    finished = true;
    if (exitCode === 0 && output.includes('ONEAI_PACKAGED_PTY_OK:two words')) resolve();
    else reject(new Error(`Packaged macOS PTY failed (exit ${exitCode}): ${output}`));
  });
}).then(() => console.log('Packaged Electron ARM64 PTY: OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
