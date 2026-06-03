#!/usr/bin/env node
'use strict';

/*
 * gui-server.js
 *
 * A tiny, dependency-free control panel for ss-scrape-and-apply.
 *
 * It serves a single web page (gui/index.html) on http://127.0.0.1:8731 and
 * exposes a small JSON API that lets a non-technical user:
 *   - upload a CV (saved as cv.pdf),
 *   - edit the application message and a few settings,
 *   - start a SAFE test run, a REAL run, or a connection self-test,
 *   - watch the live log and a short result summary.
 *
 * Everything runs locally. The server only listens on 127.0.0.1 (loopback),
 * so it is not reachable from the network. It uses only Node built-ins so it
 * needs no extra npm packages of its own.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const BASE_PORT = Number.parseInt(process.env.GUI_PORT || '8731', 10);

const CONFIG_PATH = path.join(ROOT, 'config.json');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const CV_PATH = path.join(ROOT, 'cv.pdf');
const INDEX_PATH = path.join(ROOT, 'gui', 'index.html');
const SUMMARY_PATH = path.join(ROOT, 'logs', 'latest-summary.json');
const SCRAPER_PATH = path.join(ROOT, 'scraper.js');

// Config fields the GUI is allowed to read/write. Everything else in
// config.json is left untouched.
const EDITABLE_CONFIG = [
  'application_message',
  'email_subject',
  'email_body',
  'work_schedule',
  'availability_message',
  'top_n',
  'output_mode',
  'email_auto_send',
  'apply_only',
];

// .env keys the GUI exposes. Secret keys are masked in responses.
const ENV_KEYS = [
  'NOTION_TOKEN',
  'NOTION_DATABASE_ID',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'MAIL_DAILY_CAP',
  'MAIL_DRY_RUN',
];
const SECRET_ENV_KEYS = new Set(['NOTION_TOKEN', 'SMTP_PASS']);

// ---------------------------------------------------------------------------
// Run state (only one scraper run at a time)
// ---------------------------------------------------------------------------
const run = {
  child: null,
  mode: null,
  startedAt: null,
};

const MAX_BUFFER_LINES = 600;
const logBuffer = []; // recent log lines, replayed to new SSE clients
const sseClients = new Set();

function pushLog(line, level) {
  const entry = { t: Date.now(), line: String(line), level: level || 'log' };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_LINES) logBuffer.shift();
  broadcast('log', entry);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // Client went away; it will be cleaned up on 'close'.
    }
  }
}

// ---------------------------------------------------------------------------
// Config / .env helpers
// ---------------------------------------------------------------------------
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(obj) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function parseEnv(text) {
  const map = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

function readEnvMap() {
  let text = '';
  if (fs.existsSync(ENV_PATH)) text = fs.readFileSync(ENV_PATH, 'utf8');
  else if (fs.existsSync(ENV_EXAMPLE_PATH)) text = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  return parseEnv(text);
}

// Rewrite .env preserving unknown keys/comments, updating only provided keys.
function writeEnvUpdates(updates) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  } else if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    lines = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8').split(/\r?\n/);
  }

  const seen = new Set();
  const out = lines.map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) return raw;
    const key = line.slice(0, line.indexOf('=')).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return raw;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }

  // Trim trailing blank lines, keep one final newline.
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  fs.writeFileSync(ENV_PATH, `${out.join('\n')}\n`, 'utf8');
}

function readSummary() {
  try {
    return JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function buildState() {
  const cfg = readConfig();
  const env = readEnvMap();

  const config = {};
  for (const key of EDITABLE_CONFIG) config[key] = cfg[key];
  if (config.output_mode == null) config.output_mode = 'csv';
  if (config.top_n == null) config.top_n = 5;

  const envOut = {};
  for (const key of ENV_KEYS) {
    if (SECRET_ENV_KEYS.has(key)) {
      envOut[`${key}__set`] = Boolean(env[key]);
    } else {
      envOut[key] = env[key] || '';
    }
  }

  const notionConfigured = Boolean(env.NOTION_TOKEN && env.NOTION_DATABASE_ID);
  const smtpConfigured = Boolean(env.SMTP_USER && env.SMTP_PASS);

  return {
    ready: {
      nodeModules: fs.existsSync(path.join(ROOT, 'node_modules')),
      playwright: fs.existsSync(path.join(ROOT, 'node_modules', 'playwright')),
    },
    cvPresent: fs.existsSync(CV_PATH),
    running: Boolean(run.child),
    runMode: run.mode,
    config,
    env: envOut,
    flags: {
      notionConfigured,
      smtpConfigured,
      mailDryRun: String(env.MAIL_DRY_RUN || 'true').toLowerCase() !== 'false',
    },
    lastSummary: readSummary(),
  };
}

// ---------------------------------------------------------------------------
// Running the scraper
// ---------------------------------------------------------------------------
function argsForMode(mode) {
  // We use Playwright's bundled Chromium (no --chrome-profile), so Google
  // Chrome is not required. The login session persists in .playwright-profile.
  if (mode === 'selftest') return ['scraper.js', '--self-test', '--verbose'];
  if (mode === 'live') return ['scraper.js', '--real-submit', '--verbose'];
  // default: safe test run (dry-run)
  return ['scraper.js', '--verbose'];
}

function startRun(mode) {
  if (run.child) return { ok: false, error: 'A run is already in progress.' };
  if (!fs.existsSync(SCRAPER_PATH)) return { ok: false, error: 'scraper.js not found.' };

  const args = argsForMode(mode);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    windowsHide: false,
  });

  run.child = child;
  run.mode = mode;
  run.startedAt = Date.now();

  const label =
    mode === 'live' ? 'PRAVI ZAGON (oddaja prijav)' : mode === 'selftest' ? 'Preverjanje povezave (self-test)' : 'Testni zagon (varno, brez oddaje)';
  pushLog(`─── ${label} ───`, 'info');
  if (mode !== 'selftest') {
    pushLog('Ko se odpre brskalnik, se prijavi v Studentski servis (samo prvic), nato pocakaj.', 'info');
  }
  broadcast('status', { running: true, mode });

  let stdoutRest = '';
  let stderrRest = '';

  const onChunk = (buf, restRef, level) => {
    const text = restRef.value + buf.toString('utf8');
    const parts = text.split(/\r?\n/);
    restRef.value = parts.pop();
    for (const line of parts) pushLog(line, level);
  };

  const stdoutRef = { value: stdoutRest };
  const stderrRef = { value: stderrRest };
  child.stdout.on('data', (b) => onChunk(b, stdoutRef, 'log'));
  child.stderr.on('data', (b) => onChunk(b, stderrRef, 'err'));

  child.on('error', (err) => {
    pushLog(`Napaka pri zagonu: ${err.message}`, 'err');
  });

  child.on('close', (code) => {
    if (stdoutRef.value.trim()) pushLog(stdoutRef.value, 'log');
    if (stderrRef.value.trim()) pushLog(stderrRef.value, 'err');
    run.child = null;
    run.mode = null;
    const ok = code === 0;
    pushLog(ok ? '✓ Koncano.' : `✗ Zakljuceno z napako (koda ${code}). Poglej dnevnik zgoraj.`, ok ? 'info' : 'err');
    broadcast('status', { running: false, mode, code });
    broadcast('summary', readSummary());
  });

  return { ok: true };
}

function stopRun() {
  if (!run.child) return { ok: true, stopped: false };
  const child = run.child;
  pushLog('Ustavljam...', 'info');
  try {
    if (process.platform === 'win32') {
      // Kill the whole process tree so the spawned browser closes too.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    pushLog(`Napaka pri ustavljanju: ${e.message}`, 'err');
  }
  return { ok: true, stopped: true };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limitBytes) {
  const buf = await readBody(req, limitBytes || 1_000_000);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      let html;
      try {
        html = fs.readFileSync(INDEX_PATH);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('gui/index.html manjka.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      // Replay recent log lines so a reconnecting page shows history.
      for (const entry of logBuffer) {
        res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      res.write(`event: status\ndata: ${JSON.stringify({ running: Boolean(run.child), mode: run.mode })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readJsonBody(req);
      const cfg = readConfig();

      if (body.config && typeof body.config === 'object') {
        for (const key of EDITABLE_CONFIG) {
          if (!(key in body.config)) continue;
          let v = body.config[key];
          if (key === 'top_n') v = Math.max(1, Math.min(20, Number.parseInt(v, 10) || 5));
          if (key === 'email_auto_send' || key === 'apply_only') v = Boolean(v);
          cfg[key] = v;
        }
        // CV is always saved as cv.pdf, keep attachments pointed at it.
        cfg.attachment_file = 'cv.pdf';
        cfg.email_attachment_file = 'cv.pdf';
        writeConfig(cfg);
      }

      if (body.env && typeof body.env === 'object') {
        const updates = {};
        for (const key of ENV_KEYS) {
          if (!(key in body.env)) continue;
          const v = body.env[key];
          // For secret fields, an empty string means "leave unchanged".
          if (SECRET_ENV_KEYS.has(key) && (v === '' || v == null)) continue;
          updates[key] = String(v);
        }
        if (Object.keys(updates).length) writeEnvUpdates(updates);
      }

      sendJson(res, 200, buildState());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cv') {
      const body = await readJsonBody(req, 25_000_000); // up to ~25 MB
      const b64 = String(body.dataBase64 || '').split(',').pop();
      if (!b64) return sendJson(res, 400, { ok: false, error: 'Ni datoteke.' });
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return sendJson(res, 400, { ok: false, error: 'Prazna datoteka.' });
      if (buf.length > 20_000_000) return sendJson(res, 400, { ok: false, error: 'Datoteka je prevelika (max 20 MB).' });
      fs.writeFileSync(CV_PATH, buf);
      pushLog(`CV nalozen (${(buf.length / 1024).toFixed(0)} KB).`, 'info');
      sendJson(res, 200, { ok: true, size: buf.length });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/run') {
      const body = await readJsonBody(req);
      const mode = body.mode === 'live' ? 'live' : body.mode === 'selftest' ? 'selftest' : 'test';
      const result = startRun(mode);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/stop') {
      sendJson(res, 200, stopRun());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function openBrowser(targetUrl) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', targetUrl], { windowsHide: true, detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [targetUrl], { detached: true }).unref();
    } else {
      spawn('xdg-open', [targetUrl], { detached: true }).unref();
    }
  } catch {
    /* user can open it manually */
  }
}

function listenWithFallback(port, attemptsLeft) {
  const server = http.createServer(handle);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listenWithFallback(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[fatal] Could not start server: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const u = `http://${HOST}:${port}`;
    console.log('');
    console.log('  ================================================================');
    console.log('   Studentski servis - nadzorna plosca / control panel');
    console.log('  ================================================================');
    console.log(`   Odprto v brskalniku:  ${u}`);
    console.log('   Ce se stran ne odpre sama, odpri zgornji naslov rocno.');
    console.log('   To okno pusti ODPRTO, dokler uporabljas program.');
    console.log('  ================================================================');
    console.log('');
    if (process.env.GUI_NO_OPEN !== '1') openBrowser(u);
  });
}

listenWithFallback(BASE_PORT, 10);
