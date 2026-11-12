/**
 * Installs the OBS hotkey binding for the shot counter.
 *
 * OBS has no API to create a hotkey binding (obs-websocket can only *trigger*
 * one), so the binding is written into the scene collection file while OBS is
 * closed. OBS reads it on next launch.
 *
 * Safe by design: refuses to run if OBS is open, always writes a timestamped
 * backup first, and only touches the "Shot Counter Trigger" source's
 * MediaSource.Restart entry.
 *
 *   node setup-hotkey.mjs                 # patch (OBS must be closed)
 *   node setup-hotkey.mjs --key OBS_KEY_F8
 *   node setup-hotkey.mjs --dry-run
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_NAME = 'Shot Counter Trigger';
const HOTKEY_NAME = 'MediaSource.Restart';
const DEFAULT_KEY = 'OBS_KEY_INSERT';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const keyId = flagValue('--key', DEFAULT_KEY);

if (!/^OBS_KEY_[A-Z0-9_]+$/.test(keyId)) {
  console.error(`[setup] "${keyId}" is not an OBS key id (expected something like OBS_KEY_INSERT).`);
  process.exit(1);
}

/* OBS holds the websocket port while it runs, and it rewrites the scene
   collection on exit - so the file must only be edited while OBS is closed. */
function obsPortOpen(host = '127.0.0.1', port = 4455, timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const obsRoot = path.join(process.env.APPDATA || '', 'obs-studio');
const scenesDir = path.join(obsRoot, 'basic', 'scenes');

if (!fs.existsSync(scenesDir)) {
  console.error(`[setup] could not find OBS scenes folder at ${scenesDir}`);
  process.exit(1);
}

const collections = fs
  .readdirSync(scenesDir)
  .filter((f) => f.toLowerCase().endsWith('.json'))
  .map((f) => {
    const full = path.join(scenesDir, f);
    return { full, name: f, mtime: fs.statSync(full).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (!collections.length) {
  console.error('[setup] no scene collection files found.');
  process.exit(1);
}

const target = collections[0];
if (collections.length > 1) {
  console.log(`[setup] ${collections.length} scene collections found, using the most recent: ${target.name}`);
}

const raw = fs.readFileSync(target.full, 'utf8');
let collection;
try {
  collection = JSON.parse(raw);
} catch (error) {
  console.error(`[setup] ${target.name} is not valid JSON, refusing to touch it: ${error.message}`);
  process.exit(1);
}

const source = (collection.sources || []).find((s) => s.name === SOURCE_NAME);
if (!source) {
  console.error(
    `[setup] no source named "${SOURCE_NAME}" in ${target.name}.\n` +
      '        Start the shot counter server once (npm start) with OBS open so it creates that source, then run this again.'
  );
  process.exit(1);
}

source.hotkeys = source.hotkeys || {};
const existing = Array.isArray(source.hotkeys[HOTKEY_NAME]) ? source.hotkeys[HOTKEY_NAME] : [];
const alreadyBound = existing.some((binding) => binding && binding.key === keyId);

console.log(`[setup] scene collection : ${target.name}`);
console.log(`[setup] source           : ${SOURCE_NAME}`);
console.log(`[setup] current bindings : ${existing.length ? JSON.stringify(existing) : '(none)'}`);

if (alreadyBound) {
  console.log(`[setup] already bound to ${keyId} - nothing to do.`);
  process.exit(0);
}

source.hotkeys[HOTKEY_NAME] = [...existing, { key: keyId }];
const next = `${JSON.stringify(collection, null, 4)}\n`;

if (dryRun) {
  console.log(`[setup] dry run - would bind ${HOTKEY_NAME} to ${keyId}.`);
  process.exit(0);
}

const backupDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backup');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `${target.name}.${stamp}.bak`);
fs.copyFileSync(target.full, backupPath);
console.log(`[setup] backup written   : ${backupPath}`);

const obsWasOpen = await obsPortOpen();
if (obsWasOpen) {
  console.error(
    '[setup] OBS is still running - close it completely and run this again (it rewrites the file on exit,\n' +
      '        so the binding would be lost). Nothing was changed.'
  );
  process.exit(1);
}

fs.writeFileSync(target.full, next, 'utf8');

// verify what OBS will load
const check = JSON.parse(fs.readFileSync(target.full, 'utf8'));
const bound = check.sources.find((s) => s.name === SOURCE_NAME)?.hotkeys?.[HOTKEY_NAME];
const ok = Array.isArray(bound) && bound.some((b) => b && b.key === keyId);
console.log(`[setup] ${ok ? 'SUCCESS' : 'FAILED'} - ${HOTKEY_NAME} on "${SOURCE_NAME}" -> ${JSON.stringify(bound)}`);
console.log('[setup] Start OBS now; the binding loads automatically.');
process.exit(ok ? 0 : 1);
