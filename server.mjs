import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { OBSWebSocket } from 'obs-websocket-js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');

// OBS owns the hotkey. We create a silent media source; the keypress restarts it,
// and OBS tells us when playback starts. This app never reads the keyboard.
const TRIGGER_SOURCE = 'Shot Counter Trigger';
const TRIGGER_WAV = path.join(ROOT, 'assets', 'trigger.wav');

// one catalogue for the dashboard, the overlay and this server
const { DRINK_IDS, DEFAULT_DRINK } = await import('./public/drinks.js');

const DEFAULT_CONFIG = {
  port: 4321,
  label: 'SHOTS',
  drink: DEFAULT_DRINK,
  sound: { enabled: true, volume: 0.75 },
  resetOnStreamStart: true,
  localHotkey: { key: 'F9' },
  // shipped defaults carry no credentials; config.json holds the real ones
  obs: { enabled: true, host: '127.0.0.1', port: 4455, password: '' },
};

/* ---------------------------------------------------------------- storage */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) };
config.obs = { ...DEFAULT_CONFIG.obs, ...(config.obs || {}) };
config.sound = { ...DEFAULT_CONFIG.sound, ...(config.sound || {}) };
config.localHotkey = { ...DEFAULT_CONFIG.localHotkey, ...(config.localHotkey || {}) };
if (!DRINK_IDS.has(config.drink)) config.drink = DEFAULT_DRINK;
delete config.hotkey;

const state = { count: 0, history: [], startedAt: Date.now(), ...readJson(STATE_PATH, {}) };
if (!Array.isArray(state.history)) state.history = [];

const writeJson = (file, data) =>
  fsp.writeFile(file, JSON.stringify(data, null, 2)).catch((e) => console.error('[save]', e.message));

/* ------------------------------------------------------------------ logging */

// Repeats are noise, not information: collapse identical OBS failures into one
// line plus a periodic counter, and log client churn without dumping user agents.
const logState = { obsError: '', obsFailures: 0 };

function logObsFailure(message) {
  if (message === logState.obsError) {
    logState.obsFailures += 1;
    if (logState.obsFailures % 15 === 0) {
      console.warn(`[obs] still waiting for OBS - ${logState.obsFailures} attempts (${message})`);
    }
    return;
  }
  logState.obsError = message;
  logState.obsFailures = 1;
  console.warn(`[obs] ${message}`);
}

function logObsConnected(url, version) {
  logState.obsError = '';
  logState.obsFailures = 0;
  console.log(`[obs] connected to ${url} (OBS ${version})`);
}

/* ---------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
const triggerState = { ready: false, lastTriggerAt: 0, localAt: 0 };

function snapshot(forRequest) {
  const loopback =
    !forRequest ||
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(forRequest.socket.remoteAddress || '');
  return {
    type: 'state',
    count: state.count,
    label: config.label,
    drink: config.drink,
    sound: config.sound,
    resetOnStreamStart: config.resetOnStreamStart,
    canUndo: state.history.length > 0,
    startedAt: state.startedAt,
    overlayClients: clients.size,
    trigger: {
      source: TRIGGER_SOURCE,
      ready: triggerState.ready,
      lastTriggerAt: triggerState.lastTriggerAt,
      // obs = OBS owns the hotkey, local = the bundled agent owns it, connecting = waiting on OBS
      mode: config.obs.enabled ? (triggerState.ready ? 'obs' : 'connecting') : 'local',
      localKey: config.localHotkey.key,
      localLastPressAt: triggerState.localAt,
    },
    obs: {
      enabled: config.obs.enabled,
      host: config.obs.host,
      port: config.obs.port,
      password: loopback ? config.obs.password : '',
      connected: obsState.connected,
      streaming: obsState.streaming,
      version: obsState.version,
    },
  };
}

function broadcast() {
  const payload = JSON.stringify(snapshot(null));
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

/* ---------------------------------------------------------------- counter */

function addShot() {
  state.count += 1;
  state.history.push(Date.now());
  if (state.history.length > 1000) state.history.shift();
  writeJson(STATE_PATH, state);
  broadcast();
}

function undoShot() {
  if (!state.history.length) return;
  state.history.pop();
  state.count = Math.max(0, state.count - 1);
  writeJson(STATE_PATH, state);
  broadcast();
}

function resetCount() {
  state.count = 0;
  state.history = [];
  state.startedAt = Date.now();
  writeJson(STATE_PATH, state);
  broadcast();
}

/* ---------------------------------------------------------------- obs */

let obs = null;
let obsRetryTimer = null;
let obsAttempt = 0;
const obsState = { connected: false, streaming: false, version: null };

function scheduleObsRetry() {
  clearTimeout(obsRetryTimer);
  obsRetryTimer = setTimeout(connectObs, 4000);
}

// one press can produce more than one signal (an OBS event plus the local agent,
// or two OBS events), so every hotkey path goes through one guard
let lastTriggerAt = 0;
function triggerShot(reason) {
  const now = Date.now();
  if (now - lastTriggerAt < 250) {
    console.log(`[trigger] duplicate suppressed (${reason})`);
    return;
  }
  lastTriggerAt = now;
  triggerState.lastTriggerAt = now;
  console.log(`[trigger] ${reason}`);
  addShot();
}

function registerTrigger(reason) {
  triggerShot(reason);
}

async function ensureTriggerSource() {
  if (!obs || !obsState.connected) return;
  try {
    const { inputs } = await obs.call('GetInputList');
    const exists = inputs.some((i) => i.inputName === TRIGGER_SOURCE);

    if (!exists) {
      if (!fs.existsSync(TRIGGER_WAV)) {
        console.warn('[trigger] missing asset', TRIGGER_WAV);
        return;
      }
      const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
      await obs.call('CreateInput', {
        sceneName: currentProgramSceneName,
        inputName: TRIGGER_SOURCE,
        inputKind: 'ffmpeg_source',
        inputSettings: {
          is_local_file: true,
          local_file: TRIGGER_WAV,
          looping: false,
          restart_on_activate: false,
          clear_on_media_end: false,
          close_when_inactive: false,
        },
        sceneItemEnabled: true,
      });
      console.log(`[trigger] created "${TRIGGER_SOURCE}" in scene "${currentProgramSceneName}"`);
    }

    await obs.call('SetInputMute', { inputName: TRIGGER_SOURCE, inputMuted: true }).catch(() => {});

    // park it off-canvas; it is audio-only and silent
    try {
      const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
      const { sceneItemId } = await obs.call('GetSceneItemId', {
        sceneName: currentProgramSceneName,
        sourceName: TRIGGER_SOURCE,
      });
      await obs.call('SetSceneItemTransform', {
        sceneName: currentProgramSceneName,
        sceneItemId,
        sceneItemTransform: { positionX: -4000, positionY: -4000, scaleX: 0.01, scaleY: 0.01 },
      });
    } catch {}

    if (!triggerState.ready) {
      triggerState.ready = true;
      broadcast();
    }
  } catch (error) {
    console.warn('[trigger] setup failed:', error.message || error);
  }
}

async function connectObs() {
  const attempt = ++obsAttempt;
  clearTimeout(obsRetryTimer);

  // offline mode: no OBS at all, the local hotkey agent is the trigger
  if (!config.obs.enabled) {
    if (obs) {
      try {
        await obs.disconnect();
      } catch {}
      obs = null;
    }
    obsState.connected = false;
    obsState.streaming = false;
    obsState.version = null;
    triggerState.ready = false;
    if (!obsState.disabledLogged) {
      obsState.disabledLogged = true;
      console.log('[obs] disabled - running offline with the local hotkey agent');
    }
    broadcast();
    return;
  }
  obsState.disabledLogged = false;

  if (obs) {
    try {
      await obs.disconnect();
    } catch {}
    obs = null;
  }

  const client = new OBSWebSocket();
  const url = `ws://${config.obs.host}:${config.obs.port}`;

  client.on('ConnectionClosed', () => {
    if (attempt !== obsAttempt) return;
    obsState.connected = false;
    obsState.streaming = false;
    triggerState.ready = false;
    broadcast();
    scheduleObsRetry();
  });

  client.on('StreamStateChanged', (event) => {
    if (attempt !== obsAttempt) return;
    obsState.streaming = Boolean(event.outputActive);
    if (obsState.streaming && config.resetOnStreamStart) resetCount();
    broadcast();
  });

  // the hotkey restarts our silent media source; OBS reports playback starting
  client.on('MediaInputPlaybackStarted', (event) => {
    if (event.inputName === TRIGGER_SOURCE) registerTrigger('hotkey (playback started)');
  });
  client.on('MediaInputActionTriggered', (event) => {
    if (event.inputName === TRIGGER_SOURCE) registerTrigger('hotkey (media action)');
  });

  try {
    await client.connect(url, config.obs.password || undefined);
    if (attempt !== obsAttempt) {
      client.disconnect().catch(() => {});
      return;
    }
    obs = client;
    const version = await client.call('GetVersion');
    const stream = await client.call('GetStreamStatus');
    obsState.connected = true;
    obsState.streaming = Boolean(stream.outputActive);
    obsState.version = version.obsVersion;
    logObsConnected(url, version.obsVersion);
    broadcast();
    await ensureTriggerSource();
  } catch (error) {
    if (attempt !== obsAttempt) return;
    obsState.connected = false;
    obsState.streaming = false;
    obsState.version = null;
    triggerState.ready = false;
    logObsFailure(`${url} -> ${error.message || error.code || error}`);
    broadcast();
    scheduleObsRetry();
  }
}

/* ---------------------------------------------------------------- http */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};
const PAGES = {
  '/': 'index.html',
  '/overlay': 'overlay.html',
  '/overlay/': 'overlay.html',
  '/window': 'window.html',
  '/window/': 'window.html',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (route === '/api/state') return sendJson(res, 200, snapshot(req));

  if (route === '/api/shot' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.source === 'local-hotkey') {
      triggerState.localAt = Date.now();
      triggerShot('local hotkey');
    } else {
      addShot();
    }
    return sendJson(res, 200, { ok: true, count: state.count });
  }
  if (route === '/api/undo' && req.method === 'POST') {
    undoShot();
    return sendJson(res, 200, { ok: true, count: state.count });
  }
  if (route === '/api/reset' && req.method === 'POST') {
    resetCount();
    return sendJson(res, 200, { ok: true, count: state.count });
  }

  if (route === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);

    if (typeof body.label === 'string') config.label = body.label.slice(0, 24) || 'SHOTS';
    if (DRINK_IDS.has(body.drink)) config.drink = body.drink;
    if (typeof body.resetOnStreamStart === 'boolean') config.resetOnStreamStart = body.resetOnStreamStart;

    if (body.sound && typeof body.sound === 'object') {
      if (typeof body.sound.enabled === 'boolean') config.sound.enabled = body.sound.enabled;
      const volume = Number(body.sound.volume);
      if (Number.isFinite(volume)) config.sound.volume = Math.max(0, Math.min(1, volume));
    }

    let obsChanged = false;
    if (body.obs && typeof body.obs === 'object') {
      if (typeof body.obs.host === 'string' && body.obs.host.trim()) {
        config.obs.host = body.obs.host.trim();
        obsChanged = true;
      }
      const port = Number(body.obs.port);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        config.obs.port = port;
        obsChanged = true;
      }
      if (typeof body.obs.password === 'string') {
        config.obs.password = body.obs.password;
        obsChanged = true;
      }
      // offline mode switch: false means "do not look for OBS at all"
      if (typeof body.obs.enabled === 'boolean' && body.obs.enabled !== config.obs.enabled) {
        config.obs.enabled = body.obs.enabled;
        obsChanged = true;
      }
    }

    if (body.localHotkey && typeof body.localHotkey === 'object' && typeof body.localHotkey.key === 'string') {
      config.localHotkey.key = body.localHotkey.key.slice(0, 24);
    }

    await writeJson(CONFIG_PATH, config);
    if (obsChanged) connectObs();
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/obs/reconnect' && req.method === 'POST') {
    connectObs();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/obs/trigger-setup' && req.method === 'POST') {
    await ensureTriggerSource();
    return sendJson(res, 200, { ok: true, ready: triggerState.ready, source: TRIGGER_SOURCE });
  }

  // static
  const page = PAGES[route];
  const file = page
    ? path.join(PUBLIC_DIR, page)
    : path.join(PUBLIC_DIR, path.normalize(route).replace(/^(\.\.[/\\])+/, ''));

  if (file.startsWith(PUBLIC_DIR)) {
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      return res.end(data);
    } catch {}
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const client = url.searchParams.get('client') === 'overlay' ? 'overlay' : 'dashboard';
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    console.log(`[ws] ${client} connected (${clients.size} open)`);
    ws.send(JSON.stringify(snapshot(req)));
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] ${client} left (${clients.size} open)`);
    });
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'audio') return;
        // only surface sound the Wayland/X11-less CEF actually played
        if (message.state !== 'running') {
          console.log(`[sound] skipped ${message.kind || 'pour'} (audio context ${message.state})`);
          return;
        }
        console.log(
          `[sound] ${message.kind || 'pour'} ${message.drink || config.drink} · count=${message.count} queued=${message.queued}`
        );
      } catch {}
    });
  });
});

/* ---------------------------------------------------------------- boot */

const PORT = Number(config.port) || 4321;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Shot counter running:
  control  http://localhost:${PORT}/
  overlay  http://localhost:${PORT}/overlay   (add this as an OBS Browser Source)

No keyboard hooks are used. The hotkey is handled by OBS itself:
  OBS > Settings > Hotkeys > "Restart playback of ${TRIGGER_SOURCE}"  ->  bind Insert`);
});

connectObs();

const shutdown = () => {
  if (obs) obs.disconnect().catch(() => {});
  for (const ws of clients) ws.terminate();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
