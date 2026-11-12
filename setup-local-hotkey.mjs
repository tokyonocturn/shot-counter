// Builds the small native hotkey agent used by the offline (no OBS) mode.
//
// The agent is compiled from source on your machine with the .NET Framework
// compiler that ships with Windows. Nothing is downloaded, no keyboard hook is
// involved, and the app itself never compiles anything at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(ROOT, 'tools', 'local-hotkey.cs');
const OUT_DIR = path.join(ROOT, 'bin');
const OUT = path.join(OUT_DIR, 'shot-counter-hotkey.exe');
const CONFIG = path.join(ROOT, 'config.json');

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function compiler() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const args = process.argv.slice(2);
const keyArg = args.indexOf('--key');
const key = keyArg >= 0 && args[keyArg + 1] ? args[keyArg + 1] : null;

if (!fs.existsSync(SOURCE)) {
  fail('Missing tools/local-hotkey.cs');
} else {
  const csc = compiler();
  if (!csc) {
    fail('No .NET Framework compiler found. Offline mode needs csc.exe, which is part of Windows.');
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    try {
      execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/out:' + OUT, SOURCE], { stdio: 'inherit' });
      const size = fs.statSync(OUT).size;
      console.log('\nBuilt ' + path.relative(ROOT, OUT) + ' (' + Math.round(size / 1024) + ' KB)');
      console.log('It only calls RegisterHotKey and posts a single HTTP line when the key is pressed:');
      console.log('no hooks, no polling, no key logging.');
    } catch (error) {
      fail('Compile failed: ' + (error.message || error));
    }
  }
}

// remember the key so the panel and start script agree with the agent
if (key) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {}
  config.localHotkey = { ...(config.localHotkey || {}), key };
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  console.log('Saved localHotkey.key = ' + key + ' to config.json');
}

if (!process.exitCode) {
  console.log('\nNext:');
  console.log('  npm run local-hotkey   (start the agent, or just use start.bat)');
  console.log('  open http://localhost:4321/ and turn on "Run without OBS"');
}
