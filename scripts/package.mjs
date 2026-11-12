// Builds a self contained, offline-ready zip of the app in dist/.
// Everything it needs at runtime is inside the zip except Node.js itself.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage');

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const ZIP = path.join(DIST, 'shot-counter-' + version + '.zip');

const SHIP = [
  'server.mjs',
  'setup-hotkey.mjs',
  'setup-local-hotkey.mjs',
  'start.bat',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'config.example.json',
  'public',
  'assets',
  'tools',
];

const SKIP_DIRS = new Set(['.git', 'node_modules/.cache']);

async function copy(source, target) {
  const stat = await fsp.stat(source);
  if (stat.isDirectory()) {
    const name = path.basename(source);
    if (SKIP_DIRS.has(name)) return;
    await fsp.mkdir(target, { recursive: true });
    for (const entry of await fsp.readdir(source)) {
      await copy(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  await fsp.copyFile(source, target);
}

await fsp.rm(DIST, { recursive: true, force: true });
await fsp.mkdir(STAGE, { recursive: true });

for (const item of SHIP) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) {
    console.warn('skip missing ' + item);
    continue;
  }
  await copy(from, path.join(STAGE, item));
}

// runtime dependencies only: ws and obs-websocket-js
const modules = path.join(ROOT, 'node_modules');
if (fs.existsSync(modules)) {
  await copy(modules, path.join(STAGE, 'node_modules'));
} else {
  console.warn('node_modules missing, run npm install first');
}

// the packaged copy starts offline: no OBS required until the user opts in
await fsp.writeFile(
  path.join(STAGE, 'config.json'),
  JSON.stringify(
    {
      port: 4321,
      label: 'SHOTS',
      drink: 'soju',
      sound: { enabled: true, volume: 0.75 },
      resetOnStreamStart: true,
      localHotkey: { key: 'Insert' },
      obs: { enabled: false, host: '127.0.0.1', port: 4455, password: '' },
    },
    null,
    2
  )
);

await fsp.writeFile(
  path.join(STAGE, 'START-HERE.txt'),
  [
    'Shot Counter ' + version,
    '',
    '1. Install Node.js 20 or newer (nodejs.org). This is the only thing you need.',
    '2. Double click setup-local-hotkey.bat once, to build the offline hotkey agent.',
    '3. Double click start.bat.',
    '4. Open http://localhost:4321/ for the dashboard, or http://localhost:4321/window',
    '   for the overlay on a second monitor.',
    '',
    'No internet, no OBS and no account are required. Everything runs on this PC.',
    '',
    'Using OBS instead of the local agent? Run setup-hotkey.bat while OBS is closed,',
    'then check "OBS" in the dashboard.',
    '',
  ].join('\r\n')
);

await fsp.writeFile(
  path.join(STAGE, 'setup-local-hotkey.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\nnode setup-local-hotkey.mjs\r\npause >nul\r\n'
);
await fsp.writeFile(
  path.join(STAGE, 'setup-hotkey.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\nnode setup-hotkey.mjs\r\npause >nul\r\n'
);

if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    'Compress-Archive -Path "' + STAGE + '\\*" -DestinationPath "' + ZIP + '" -Force',
  ]);
} else {
  execFileSync('zip', ['-r', '-q', ZIP, '.'], { cwd: STAGE });
}

const size = fs.statSync(ZIP).size;
console.log('Package built: ' + path.relative(ROOT, ZIP) + ' (' + (size / 1024 / 1024).toFixed(1) + ' MB)');
console.log('Contents staged in ' + path.relative(ROOT, STAGE));
