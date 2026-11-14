const fs = require('node:fs');
const path = require('node:path');

/** node-pty's npm macOS prebuild may ship spawn-helper as 0644, not executable. */
function ensureExecutable(nodePtyDir) {
  let found = false;
  for (const relative of [
    'prebuilds/darwin-arm64/spawn-helper',
    'prebuilds/darwin-x64/spawn-helper',
    'build/Release/spawn-helper',
  ]) {
    const helper = path.join(nodePtyDir, relative);
    if (!fs.existsSync(helper)) continue;
    fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
    found = true;
    console.log(`[OneAI] macOS PTY helper is executable: ${helper}`);
  }
  if (!found) throw new Error(`node-pty spawn-helper not found in ${nodePtyDir}`);
}

// Electron Builder invokes this same file as an afterPack hook. Restoring the
// executable bit after copying into .app is important even if npm ci fixed it.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const nodePtyDir = path.join(
    context.appOutDir, appName, 'Contents', 'Resources',
    'app.asar.unpacked', 'node_modules', 'node-pty',
  );
  ensureExecutable(nodePtyDir);
};

// npm ci / npm install: fix the development copy before the first PTY spawn.
if (require.main === module && process.platform === 'darwin') {
  ensureExecutable(path.join(__dirname, '..', 'node_modules', 'node-pty'));
}
