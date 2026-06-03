#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require('playwright');
const { sendEmail } = require('./mailer');
const APP_LOG_FILE = path.resolve(process.cwd(), 'app.log');
const ERROR_LOG_FILE = path.resolve(process.cwd(), 'error.log');

const DEFAULT_TARGET_URL =
  'https://www.studentski-servis.com/studenti/prosta-dela?kljb=&page=1&isci=1&sort=1&dm1s=1' +
  '&skD%5B%5D=004&skD%5B%5D=A832&skD%5B%5D=A210&skD%5B%5D=A055&skD%5B%5D=A078' +
  '&skD%5B%5D=A090&skD%5B%5D=A095&hourlyratefrom=7.73&hourlyrateto=31&hourly_rate=7.73%3B26';

const DEFAULT_EMAIL_TEXT =
  'Spoštovani,\\n\\n' +
  'Na študentskem servisu sem zasledil vaš oglas.\\n' +
  'Mislim da vaše podjetje ponuja to kaj si želim doseči v prihodnosti in bi res bil hvaležen, če bi si prosim vzeli minuto da preletite moj CV.\\n\\n' +
  'Hvala ker ste si vzeli čas.\\n\\n' +
  'Želim vam lep preostanek dneva,\\n' +
  'lep pozdrav.\\n\\n' +
  'Ime Priimek';

const CONFIG_TEMPLATE = `# Key=value config for scraper.js
application_message=Spoštovani,\n\nMislim da vaše podjetje ponuja to kaj si želim doseči v prihodnosti in bi res bil hvaležen, če bi si prosim vzeli minuto da preletite moj CV.\n\nHvala ker ste si vzeli čas.\n\nŽelim vam lep preostanek dneva,\nlep pozdrav.\n\nIme Priimek
work_schedule=40 ur na teden.
availability_message=na voljo sem kadarkoli med tednom
attachment_file=cv.pdf
target_url=${DEFAULT_TARGET_URL}
top_n=5
headless=false
wait_for_login_seconds=240
output_mode=notion
csv_path=jobs.csv
seen_jobs_path=seen_jobs.json
max_retries=2
jitter_min_ms=1000
jitter_max_ms=2500
apply_only=false
email_auto_send=true
email_subject=Prijava na študentsko delo
email_body=${DEFAULT_EMAIL_TEXT}
email_attachment_file=cv.pdf
log_retention_days=7
log_dir=logs
chrome_user_data_dir=
chrome_profile_directory=Default
enable_newest_sort=true
`;

const CONFIG_JSON_TEMPLATE = {
  application_message: 'Spoštovani,\n\nMislim da vaše podjetje ponuja to kaj si želim doseči v prihodnosti in bi res bil hvaležen, če bi si prosim vzeli minuto da preletite moj CV.\n\nHvala ker ste si vzeli čas.\n\nŽelim vam lep preostanek dneva,\nlep pozdrav.\n\nIme Priimek',
  work_schedule: '40 ur na teden.',
  availability_message: 'na voljo sem kadarkoli med tednom',
  attachment_file: 'cv.pdf',
  target_url: DEFAULT_TARGET_URL,
  top_n: 5,
  headless: false,
  wait_for_login_seconds: 240,
  output_mode: 'notion',
  csv_path: 'jobs.csv',
  seen_jobs_path: 'seen_jobs.json',
  max_retries: 2,
  jitter_min_ms: 1000,
  jitter_max_ms: 2500,
  apply_only: false,
  email_auto_send: true,
  email_subject: 'Prijava na študentsko delo',
  email_body: DEFAULT_EMAIL_TEXT,
  email_attachment_file: 'cv.pdf',
  log_retention_days: 7,
  log_dir: 'logs',
  chrome_user_data_dir: '',
  chrome_profile_directory: 'Default',
  enable_newest_sort: true
};

const CSV_FIELDS = ['job_id', 'email', 'submitted', 'date', 'title', 'description'];
const NOTION_VERSION = '2022-06-28';
const runtimeState = {
  verbose: false,
};

function verboseLog(message, details) {
  if (!runtimeState.verbose) return;
  if (details === undefined) {
    console.log(`[verbose] ${message}`);
    return;
  }
  try {
    console.log(`[verbose] ${message} ${JSON.stringify(details)}`);
  } catch {
    console.log(`[verbose] ${message}`);
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseBool(raw, fallback) {
  if (raw == null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  return fallback;
}

function decodeConfigText(raw) {
  return String(raw || '').replace(/\\n/g, '\n');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      fields.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  fields.push(current);
  return fields;
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function nowCompact() {
  return nowIso().replace(/[:.]/g, '-');
}

function defaultChromeUserDataDir() {
  // Use a dedicated automation profile by default.
  // Chrome blocks remote debugging on the default user data dir.
  return path.resolve(process.cwd(), '.chrome-automation-profile');
}

function resolveMaybeAbsolutePath(baseDir, rawPath) {
  const input = String(rawPath || '').trim();
  if (!input) return '';
  if (path.isAbsolute(input)) return input;

  // Handle Windows absolute paths even if script runs from Linux/WSL.
  if (/^[A-Za-z]:[\\/]/.test(input)) {
    if (process.platform === 'win32') return input;
    const drive = input[0].toLowerCase();
    const rest = input.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
    return `/mnt/${drive}/${rest}`;
  }

  return path.resolve(baseDir, input);
}

function textToSimpleHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\n/g, '<br>');
}

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function appendJsonLog(jsonlPath, entry) {
  const line = JSON.stringify({ at: nowIso(), ...entry });
  fs.appendFileSync(jsonlPath, `${line}\n`, 'utf8');
}

function appendAppLog(message) {
  fs.appendFileSync(APP_LOG_FILE, `[${nowIso()}] ${message}\n`, 'utf8');
}

function appendErrorLog(message) {
  fs.appendFileSync(ERROR_LOG_FILE, `[${nowIso()}] ${message}\n`, 'utf8');
}

async function sleepJitter(minMs, maxMs) {
  const low = Number.isFinite(minMs) ? Math.max(0, minMs) : 0;
  const high = Number.isFinite(maxMs) ? Math.max(low, maxMs) : low;
  const delay = low + Math.floor(Math.random() * (high - low + 1));
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

function cleanupOldLogs(logDir, retentionDays, jsonlPath) {
  const days = Number.isFinite(retentionDays) ? retentionDays : 7;
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(logDir)) return;

  for (const name of fs.readdirSync(logDir)) {
    if (name === 'events.jsonl' || name === 'latest-summary.json') continue;
    const full = path.join(logDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs >= threshold) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      appendJsonLog(jsonlPath, { level: 'info', event: 'log_cleanup_removed', path: full });
    } catch (e) {
      appendJsonLog(jsonlPath, { level: 'warn', event: 'log_cleanup_failed', path: full, error: String(e.message || e) });
    }
  }
}

function ensureConfigExists(configPath) {
  if (fs.existsSync(configPath)) return;
  const isJson = configPath.endsWith('.json');
  const content = isJson ? JSON.stringify(CONFIG_JSON_TEMPLATE, null, 2) : CONFIG_TEMPLATE;
  fs.writeFileSync(configPath, content, 'utf8');
  console.log(`[info] Created default config: ${configPath}`);
}

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  let values = {};

  // Check if JSON format
  if (configPath.endsWith('.json')) {
    values = JSON.parse(raw);
  } else {
    // Parse key=value format
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      values[key] = value;
    }
  }

  // For JSON, values are already typed, for txt we need to decode/parse
  const isJson = configPath.endsWith('.json');
  
  return {
    application_message: isJson ? values.application_message || 'jaz sem maj' : decodeConfigText(values.application_message || 'jaz sem maj'),
    work_schedule: values.work_schedule || '40 ur na teden.',
    availability_message: values.availability_message || 'na voljo sem kadarkoli med tednom',
    attachment_file: values.attachment_file || 'cv.pdf',
    target_url: values.target_url || DEFAULT_TARGET_URL,
    top_n: isJson ? (values.top_n || 5) : Number.parseInt(values.top_n || '5', 10),
    headless: isJson ? (values.headless || false) : parseBool(values.headless, false),
    wait_for_login_seconds: isJson ? (values.wait_for_login_seconds || 240) : Number.parseInt(values.wait_for_login_seconds || '240', 10),
    output_mode: (process.env.SCRAPER_OUTPUT_MODE || values.output_mode || 'notion').toLowerCase(),
    notion_token: process.env.NOTION_TOKEN || values.notion_token || '',
    notion_database_id: process.env.NOTION_DATABASE_ID || values.notion_database_id || '',
    csv_path: values.csv_path || 'jobs.csv',
    seen_jobs_path: values.seen_jobs_path || 'seen_jobs.json',
    max_retries: isJson ? (values.max_retries || 2) : Number.parseInt(values.max_retries || '2', 10),
    jitter_min_ms: isJson ? (values.jitter_min_ms || 250) : Number.parseInt(values.jitter_min_ms || '250', 10),
    jitter_max_ms: isJson ? (values.jitter_max_ms || 900) : Number.parseInt(values.jitter_max_ms || '900', 10),
    apply_only: isJson ? (values.apply_only || false) : parseBool(values.apply_only || process.env.SCRAPER_APPLY_ONLY, false),
    email_auto_send: isJson ? (values.email_auto_send !== false) : parseBool(values.email_auto_send || process.env.SCRAPER_EMAIL_AUTO_SEND, true),
    email_subject: values.email_subject || process.env.SCRAPER_EMAIL_SUBJECT || 'Prijava na študentsko delo',
    email_body: isJson ? (values.email_body || DEFAULT_EMAIL_TEXT) : decodeConfigText(values.email_body || process.env.SCRAPER_EMAIL_BODY || DEFAULT_EMAIL_TEXT),
    email_attachment_file: values.email_attachment_file || process.env.SCRAPER_EMAIL_ATTACHMENT_FILE || 'cv.pdf',
    log_retention_days: isJson ? (values.log_retention_days || 7) : Number.parseInt(values.log_retention_days || '7', 10),
    log_dir: values.log_dir || 'logs',
    chrome_user_data_dir: process.env.SCRAPER_CHROME_USER_DATA_DIR || values.chrome_user_data_dir || '',
    chrome_profile_directory: process.env.SCRAPER_CHROME_PROFILE_DIRECTORY || values.chrome_profile_directory || 'Default',
    enable_newest_sort: isJson ? (values.enable_newest_sort !== false) : parseBool(values.enable_newest_sort, true),
  };
}

function parseArgs(argv) {
  const options = {
    config: 'config.json',
    csv: null,
    profileDir: '.playwright-profile',
    headless: false,
    topN: null,
    skipLoginWait: false,
    selfTest: false,
    realSubmit: false,
    chromeProfile: false,
    chromeUserDataDir: null,
    chromeProfileDirectory: null,
    output: null,
    envFile: '.env',
    applyOnly: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' && argv[i + 1]) options.config = argv[++i];
    else if (arg === '--csv' && argv[i + 1]) options.csv = argv[++i];
    else if (arg === '--profile-dir' && argv[i + 1]) options.profileDir = argv[++i];
    else if (arg === '--top-n' && argv[i + 1]) options.topN = Number.parseInt(argv[++i], 10);
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--skip-login-wait') options.skipLoginWait = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--real-submit') options.realSubmit = true;
    else if (arg === '--chrome-profile') options.chromeProfile = true;
    else if (arg === '--chrome-user-data-dir' && argv[i + 1]) options.chromeUserDataDir = argv[++i];
    else if (arg === '--chrome-profile-directory' && argv[i + 1]) options.chromeProfileDirectory = argv[++i];
    else if (arg === '--output' && argv[i + 1]) options.output = argv[++i].toLowerCase();
    else if (arg === '--env-file' && argv[i + 1]) options.envFile = argv[++i];
    else if (arg === '--apply-only') options.applyOnly = true;
    else if (arg === '--verbose') options.verbose = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function loadSeenJobs(seenPath) {
  if (!fs.existsSync(seenPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(seenPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeenJobs(seenPath, seen) {
  fs.writeFileSync(seenPath, `${JSON.stringify(seen, null, 2)}\n`, 'utf8');
}

function loadCsvRows(csvPath) {
  if (!fs.existsSync(csvPath)) return new Map();
  const data = fs.readFileSync(csvPath, 'utf8').trim();
  if (!data) return new Map();

  const lines = data.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const idx = {
    job_id: header.indexOf('job_id'),
    email: header.indexOf('email'),
    submitted: header.indexOf('submitted'),
    date: header.indexOf('date'),
    title: header.indexOf('title'),
    description: header.indexOf('description'),
  };

  const rows = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const cols = parseCsvLine(lines[i]);
    const jobId = (cols[idx.job_id] || '').trim();
    if (!jobId) continue;

    rows.set(jobId, {
      job_id: jobId,
      email: (cols[idx.email] || '').trim(),
      submitted: normalizeText(cols[idx.submitted] || '') === 'true',
      date: (cols[idx.date] || '').trim(),
      title: (cols[idx.title] || '').trim(),
      description: (cols[idx.description] || '').trim(),
    });
  }
  return rows;
}

function saveCsvRows(csvPath, rows) {
  const lines = [CSV_FIELDS.join(',')];
  for (const row of rows.values()) {
    lines.push(
      [
        csvEscape(row.job_id || ''),
        csvEscape(row.email || ''),
        csvEscape(row.submitted ? 'true' : 'false'),
        csvEscape(row.date || ''),
        csvEscape(row.title || ''),
        csvEscape(row.description || ''),
      ].join(',')
    );
  }
  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');
}

class CsvResultStore {
  constructor(csvPath) {
    this.csvPath = csvPath;
    this.rows = loadCsvRows(csvPath);
  }

  async save(result) {
    this.rows.set(result.job_id, {
      job_id: result.job_id,
      email: result.email || '',
      submitted: Boolean(result.submitted),
      date: result.date || nowIso(),
      title: result.title || '',
      description: result.description || '',
    });
    saveCsvRows(this.csvPath, this.rows);
  }
}

class NotionResultStore {
  constructor(token, databaseId, jsonlPath) {
    this.token = token;
    this.databaseId = databaseId;
    this.jsonlPath = jsonlPath;
  }

  get enabled() {
    return Boolean(this.token && this.databaseId);
  }

  async request(endpoint, payload, method = 'POST') {
    const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notion ${method} ${endpoint} failed: ${res.status} ${body}`);
    }

    return res.json();
  }

  async validateSchema() {
    if (!this.enabled) throw new Error('Notion credentials missing (token/database_id).');
    const db = await this.request(`databases/${this.databaseId}`, null, 'GET');
    const props = db.properties || {};
    const required = [
      ['Name', 'title'],
      ['Prijavljen', 'rich_text'],
      ['Datum', 'rich_text'],
      ['Opis', 'rich_text'],
    ];
    for (const [prop, type] of required) {
      if (!props[prop]) throw new Error(`Notion DB missing property: ${prop}`);
      if (props[prop].type !== type) {
        throw new Error(`Notion property '${prop}' must be type '${type}', got '${props[prop].type}'`);
      }
    }
    return true;
  }

  async findPageByName(nameValue) {
    const payload = {
      filter: {
        property: 'Name',
        title: { equals: nameValue },
      },
      page_size: 1,
    };
    const data = await this.request(`databases/${this.databaseId}/query`, payload, 'POST');
    return data.results && data.results.length ? data.results[0] : null;
  }

  buildProperties(result) {
    const prijavljen = result.submitted ? 'true' : 'false';
    const date = result.date || nowIso();
    const opis = truncate(
      [
        result.title ? `Naslov: ${result.title}` : '',
        result.email ? `Email: ${result.email}` : '',
        result.description ? `Opis: ${result.description}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
      1800
    );

    return {
      Name: {
        title: [{ text: { content: String(result.job_id) } }],
      },
      Prijavljen: {
        rich_text: [{ text: { content: prijavljen } }],
      },
      Datum: {
        rich_text: [{ text: { content: date } }],
      },
      Opis: {
        rich_text: [{ text: { content: opis } }],
      },
    };
  }

  async save(result) {
    if (!this.enabled) throw new Error('Notion credentials missing (token/database_id).');

    const existing = await this.findPageByName(String(result.job_id));
    const properties = this.buildProperties(result);

    if (existing) {
      await this.request(`pages/${existing.id}`, { properties }, 'PATCH');
      appendJsonLog(this.jsonlPath, { level: 'info', event: 'notion_update', job_id: result.job_id });
      return;
    }

    await this.request('pages', { parent: { database_id: this.databaseId }, properties }, 'POST');
    appendJsonLog(this.jsonlPath, { level: 'info', event: 'notion_create', job_id: result.job_id });
  }

  async upsertSelfTest() {
    if (!this.enabled) throw new Error('Notion credentials missing (token/database_id).');
    const testId = 'SELF-TEST';
    const now = nowIso();
    const result = {
      job_id: testId,
      submitted: false,
      date: now,
      title: 'Notion connectivity test',
      email: '',
      description: `Self-test successful at ${now}`,
    };
    await this.save(result);
    return { ok: true, job_id: testId, at: now };
  }
}

class CombinedResultStore {
  constructor(stores) {
    this.stores = stores;
  }

  async save(result) {
    for (const store of this.stores) {
      await store.save(result);
    }
  }
}

async function dismissCookieBanner(page) {
  const selectors = [
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    "button:has-text('Sprejmi')",
    "button:has-text('Strinjam se')",
  ];

  for (const selector of selectors) {
    const loc = page.locator(selector);
    if ((await loc.count()) === 0) continue;
    try {
      if (await loc.first().isVisible({ timeout: 500 })) {
        await loc.first().click();
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // Ignore selector and continue.
    }
  }
}

async function waitForJobs(page) {
  await page.waitForSelector('article.job-item', { timeout: 30000 });
}

async function ensureNewestSort(page, jsonlPath, config) {
  if (!config.enable_newest_sort) {
    console.log('[info] Sort selection disabled in config (enable_newest_sort=false)');
    verboseLog('Sort selection skipped (disabled in config)');
    return;
  }

  const sortSelect = page.locator("select[name='sort']");
  if ((await sortSelect.count()) === 0) {
    appendJsonLog(jsonlPath, { level: 'warn', event: 'sort_select_missing' });
    verboseLog('Sort select missing');
    return;
  }

  const firstSortSelect = sortSelect.first();
  const current = await firstSortSelect.evaluate((el) => String(el.value || '')).catch(() => '');
  verboseLog('Sort current value', { current });
  if (current === '1') {
    appendJsonLog(jsonlPath, { level: 'info', event: 'sort_already_newest' });
    verboseLog('Sort already newest');
    console.log('[info] Sort already set to "novejša dela"');
    return;
  }

  console.log('[info] Setting sort to "novejša dela"...');
  await page.waitForTimeout(800);
  let method = 'select_option_force';
  try {
    await firstSortSelect.selectOption('1', { force: true, timeout: 7000 });
    await page.waitForTimeout(500);
  } catch (error) {
    method = 'dom_fallback';
    verboseLog('Sort selectOption(force) failed, using DOM fallback', { error: String(error?.message || error) });
    await firstSortSelect.evaluate((el) => {
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const form = el.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    });
    await page.waitForTimeout(500);
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(1500);
  await waitForJobs(page);
  const updated = await firstSortSelect.evaluate((el) => String(el.value || '')).catch(() => '');
  const url = page.url();
  let urlSort = '';
  try {
    urlSort = new URL(url).searchParams.get('sort') || '';
  } catch {
    urlSort = '';
  }
  const ok = updated === '1' || urlSort === '1';
  appendJsonLog(jsonlPath, {
    level: ok ? 'info' : 'warn',
    event: ok ? 'sort_set_newest' : 'sort_set_unverified',
    method,
    value_after: updated,
    url_sort: urlSort,
  });
  verboseLog('Sort ensure result', { ok, method, value_after: updated, url_sort: urlSort });
  appendAppLog('sort_set_newest');
  if (ok) {
    console.log('[info] ✓ Sort successfully set to "novejša dela"');
  } else {
    console.log('[warn] Sort may not have changed properly');
  }
}

async function needsLogin(page) {
  const selectors = [
    "button:has-text('VSTOPI IN SI POGLEJ VEČ')",
    "button:has-text('VSTOPI IN SI POGLEJ VEC')",
  ];

  for (const selector of selectors) {
    const loc = page.locator(selector);
    if ((await loc.count()) === 0) continue;
    try {
      if (await loc.first().isVisible({ timeout: 300 })) return true;
    } catch {
      // Ignore.
    }
  }
  return false;
}

async function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question('[input] After login press Enter to continue... ', () => {
      rl.close();
      resolve();
    });
  });
}

async function waitForManualLogin(page, waitSeconds) {
  if (!(await needsLogin(page))) return true;
  console.log('[warn] Login required. Log in in opened browser, then continue.');

  if (process.stdin.isTTY) {
    await waitForEnter();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissCookieBanner(page);
    await waitForJobs(page);
    return !(await needsLogin(page));
  }

  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (!(await needsLogin(page))) return true;
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissCookieBanner(page);
    await waitForJobs(page);
  }
  return !(await needsLogin(page));
}

async function firstVisibleLocator(scope, selectors) {
  for (const selector of selectors) {
    const loc = scope.locator(selector);
    const count = await loc.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = loc.nth(i);
      try {
        if (await candidate.isVisible({ timeout: 500 })) return candidate;
      } catch {
        // Ignore.
      }
    }
  }
  return null;
}

async function fillFirst(page, selectors, value, required = false) {
  const loc = await firstVisibleLocator(page, selectors);
  if (!loc) {
    if (required) throw new Error(`Missing required field: ${selectors.join(' | ')}`);
    return false;
  }
  await loc.fill(value);
  return true;
}

async function extractJobMeta(article) {
  const titleNodes = article.locator('h5');
  const titleCount = await titleNodes.count();
  const titleParts = [];
  for (let i = 0; i < titleCount; i += 1) {
    const t = (await titleNodes.nth(i).innerText().catch(() => '')).trim();
    if (t) titleParts.push(t);
  }
  const description = (await article.locator('p.description').first().innerText().catch(() => '')).trim();
  return {
    title: titleParts.join(' | '),
    description,
  };
}

async function extractEmailFromArticle(article) {
  const anchors = article.locator("a[href^='mailto:']");
  if ((await anchors.count()) > 0) {
    const href = (await anchors.first().getAttribute('href')) || '';
    const match = href.match(/mailto:([^?]+)/i);
    return match ? decodeURIComponent(match[1].trim()) : '';
  }

  const html = await article.innerHTML();
  const match = html.match(/mailto:([^"'?]+)/i);
  return match ? decodeURIComponent(match[1].trim()) : '';
}

async function findEmailAction(article) {
  const items = article.locator('button, a');
  const count = await items.count();
  for (let i = 0; i < count; i += 1) {
    const el = items.nth(i);
    const text = normalizeText(await el.innerText({ timeout: 300 }).catch(() => ''));
    if ((text.includes('prikazi') || text.includes('pokazi')) && (text.includes('mail') || text.includes('email'))) {
      return el;
    }
  }
  return null;
}

async function findApplyAction(article) {
  const classMatch = article.locator('a.d-block.px-0.mt-2');
  if ((await classMatch.count()) > 0) return classMatch.first();

  const items = article.locator('button, a');
  const count = await items.count();
  for (let i = 0; i < count; i += 1) {
    const el = items.nth(i);
    const text = normalizeText(await el.innerText({ timeout: 300 }).catch(() => ''));
    if ((text.includes('prijava') && text.includes('delo')) || (text.includes('prijavi') && text.includes('delo'))) {
      return el;
    }
  }
  return null;
}

async function hasAttachedFile(page, attachmentPath) {
  const attachmentName = path.basename(attachmentPath);
  if ((await page.locator(`text=${attachmentName}`).count()) > 0) return true;
  if ((await page.locator('text=/pripet|nalo[žz]en|dodana priloga/i').count()) > 0) return true;

  const checkpoint = await firstVisibleLocator(page, [
    "xpath=/html/body/main/div/section/div[2]/div/form/div[11]/div/div//*[contains(@class,'checkpoint') and (contains(@class,'active') or contains(@class,'checked'))]",
    "xpath=/html/body/main/div/section/div[2]/div/form/div[11]/div/div//*[contains(@class,'check')]",
    "xpath=/html/body/main/div/section/div[2]/div/form/div[11]/div/div//*[contains(@class,'success')]",
  ]);
  if (checkpoint) return true;

  const fileInputs = page.locator("form input[type='file']");
  const inputCount = await fileInputs.count();
  for (let i = 0; i < inputCount; i += 1) {
    try {
      const fileCount = await fileInputs.nth(i).evaluate((el) => el.files?.length || 0);
      if (fileCount > 0) return true;
      const inputValue = await fileInputs.nth(i).inputValue().catch(() => '');
      if (inputValue && normalizeText(inputValue).includes(normalizeText(attachmentName))) return true;
    } catch {
      // Ignore.
    }
  }

  return false;
}

async function uploadCvAttachment(page, attachmentPath) {
  const exists = await fsp.access(attachmentPath, fs.constants.R_OK).then(() => true).catch(() => false);
  if (!exists) {
    console.log(`[warn] Attachment file missing: ${attachmentPath}`);
    return false;
  }

  if (await hasAttachedFile(page, attachmentPath)) return true;

  // Primary upload path requested by user: click label in div[11].
  const uploadLabel = await firstVisibleLocator(page, [
    'xpath=/html/body/main/div/section/div[2]/div/form/div[11]/div/div/label',
    "label[for*='file']",
  ]);

  if (!uploadLabel) {
    appendErrorLog('cv_upload_label_missing xpath=/html/body/main/div/section/div[2]/div/form/div[11]/div/div/label');
    return false;
  }

  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 4000 }),
      uploadLabel.click(),
    ]);
    await chooser.setFiles(attachmentPath);
    await page.waitForTimeout(700);
  } catch {
    // Fallback to direct input set only if label flow does not open chooser.
    const fileInputs = page.locator("xpath=/html/body/main/div/section/div[2]/div/form/div[11]//input[@type='file']");
    const count = await fileInputs.count();
    for (let i = 0; i < count; i += 1) {
      try {
        await fileInputs.nth(i).setInputFiles(attachmentPath);
        await page.waitForTimeout(700);
        if (await hasAttachedFile(page, attachmentPath)) return true;
      } catch {
        // Continue fallback loop.
      }
    }
  }

  return hasAttachedFile(page, attachmentPath);
}

async function submitApplication(page, dryRun) {
  if (dryRun) {
    console.log('[dry-run] Submission skipped.');
    return false;
  }

  const submitButton = await firstVisibleLocator(page, [
    'xpath=/html/body/main/div/section/div[2]/div/form/button',
  ]);
  if (!submitButton) {
    throw new Error('Submit button missing at xpath=/html/body/main/div/section/div[2]/div/form/button');
  }

  const before = page.url();
  await submitButton.click({ force: true });
  await page.waitForTimeout(2500);

  const hasErrors = (await page.locator('.alert-danger, .invalid-feedback, .is-invalid').count()) > 0;
  const hasSuccess = (await page.locator('text=/uspe[sš]no|hvala|oddana/i').count()) > 0;
  const urlChanged = page.url() !== before;
  const hasValidationHint = (await page.locator('text=/obvezn|napaka/i').count()) > 0;

  if (hasErrors || hasValidationHint) return false;
  if (hasSuccess) return true;
  if (urlChanged) return true;
  return false;
}

async function openApplyPage(listPage, action) {
  const href = await action.getAttribute('href');
  verboseLog('Open apply page action', { has_href: Boolean(href) });

  if (href) {
    const appPage = await listPage.context().newPage();
    await appPage.goto(new URL(href, 'https://www.studentski-servis.com').toString(), { waitUntil: 'domcontentloaded' });
    return appPage;
  }

  try {
    const [appPage] = await Promise.all([
      listPage.context().waitForEvent('page', { timeout: 7000 }),
      action.click(),
    ]);
    await appPage.waitForLoadState('domcontentloaded');
    return appPage;
  } catch {
    return null;
  }
}

async function applyForJob(listPage, action, config, dryRun, evidenceDir, jsonlPath, jobId) {
  const appPage = await openApplyPage(listPage, action);
  if (!appPage) throw new Error('Could not open application page.');

  try {
    verboseLog('Apply flow opened', { job_id: jobId, dry_run: dryRun });
    await appPage.waitForTimeout(1500);
    await dismissCookieBanner(appPage);
    await appPage.waitForTimeout(800);

    await fillFirst(
      appPage,
      [
        'xpath=/html/body/main/div/section/div[2]/div/form/div[8]/div/textarea',
        "textarea[name='besedilo_prijave']",
      ],
      config.application_message,
      true
    );

    const extraSection = await firstVisibleLocator(appPage, [
      'xpath=/html/body/main/div/section/div[2]/div/form/h3[2]',
      'h3.mb-0.mt-4',
    ]);

    if (extraSection) {
      verboseLog('Apply flow has extra section', { job_id: jobId });
      await fillFirst(
        appPage,
        [
          "xpath=//*[@id='input-field-opt4']",
          '#input-field-opt4',
          "input[placeholder*='Kako lahko dela']",
        ],
        config.work_schedule,
        false
      );

      await fillFirst(
        appPage,
        [
          'xpath=/html/body/main/div/section/div[2]/div/form/div[7]/div/textarea',
          "textarea[placeholder*='Kdaj si na voljo']",
          "textarea[placeholder*='Kdaj si na voljo za delo']",
        ],
        config.availability_message,
        false
      );
    }

    const attached = await uploadCvAttachment(appPage, config.attachment_path);
    verboseLog('Apply attachment status', { job_id: jobId, attached });
    if (!attached) throw new Error('CV attachment not confirmed on the form.');

    if (evidenceDir) {
      await appPage.screenshot({ path: path.join(evidenceDir, 'application-page.png'), fullPage: true }).catch(() => {});
      const html = await appPage.content().catch(() => '');
      if (html) fs.writeFileSync(path.join(evidenceDir, 'application-page.html'), html, 'utf8');
    }

    const submitted = await submitApplication(appPage, dryRun);
    verboseLog('Apply submit result', { job_id: jobId, submitted, dry_run: dryRun });
    if (!dryRun && !submitted) {
      appendJsonLog(jsonlPath, { level: 'critical', event: 'submit_unconfirmed', job_id: jobId });
    }
    return submitted;
  } catch (err) {
    if (String(err?.message || err).includes('Missing required field')) {
      appendJsonLog(jsonlPath, {
        level: 'critical',
        event: 'selector_health_failed',
        job_id: jobId,
        error: String(err?.message || err),
      });
      if (evidenceDir) {
        await appPage
          .screenshot({ path: path.join(evidenceDir, 'selector-health-failure.png'), fullPage: true })
          .catch(() => {});
      }
    }
    throw err;
  } finally {
    await appPage.close();
  }
}

async function sendEmailForJob(recipient, jobId, config, dryRun, jsonlPath) {
  verboseLog('Email flow start', { job_id: jobId, recipient, dry_run: dryRun });
  if (!config.email_auto_send) {
    appendJsonLog(jsonlPath, { level: 'info', event: 'email_auto_send_disabled', job_id: jobId, recipient });
    appendAppLog(`email_auto_send_disabled job_id=${jobId} recipient=${recipient}`);
    return { ok: false, skipped: true, reason: 'email_auto_send_disabled' };
  }

  if (dryRun) {
    appendJsonLog(jsonlPath, { level: 'info', event: 'email_skipped_dry_run', job_id: jobId, recipient });
    appendAppLog(`email_skipped_dry_run job_id=${jobId} recipient=${recipient}`);
    return { ok: true, skipped: true, reason: 'scraper_dry_run' };
  }

  const attachmentPath = config.email_attachment_path;
  const attachmentExists = await fsp.access(attachmentPath, fs.constants.R_OK).then(() => true).catch(() => false);
  if (!attachmentExists) {
    const error = `Email attachment not found: ${attachmentPath}`;
    appendJsonLog(jsonlPath, { level: 'critical', event: 'email_attachment_missing', job_id: jobId, recipient, error });
    appendErrorLog(`email_attachment_missing job_id=${jobId} recipient=${recipient} error="${error}"`);
    return { ok: false, error };
  }

  const result = await sendEmail({
    to: recipient,
    subject: config.email_subject,
    text: config.email_body,
    html: textToSimpleHtml(config.email_body),
    job_id: jobId,
    attachments: [
      {
        filename: path.basename(attachmentPath),
        path: attachmentPath,
      },
    ],
  });

  appendJsonLog(jsonlPath, {
    level: result.ok ? 'info' : 'error',
    event: result.ok ? 'email_send_result' : 'email_send_failed',
    job_id: jobId,
    recipient,
    result,
  });
  if (result.ok) {
    appendAppLog(`email_send_result_ok job_id=${jobId} recipient=${recipient}`);
  } else {
    appendErrorLog(`email_send_failed job_id=${jobId} recipient=${recipient} error="${result.error || 'unknown'}"`);
  }

  return result;
}

async function processJob(page, article, jobId, config, dryRun, evidenceDir, jsonlPath) {
  const meta = await extractJobMeta(article);
  const result = {
    job_id: jobId,
    email: '',
    submitted: false,
    date: nowIso(),
    title: meta.title,
    description: meta.description,
  };

  if (evidenceDir) {
    await article.screenshot({ path: path.join(evidenceDir, 'article.png') }).catch(() => {});
    const articleHtml = await article.innerHTML().catch(() => '');
    if (articleHtml) fs.writeFileSync(path.join(evidenceDir, 'article.html'), articleHtml, 'utf8');
  }

  const emailAction = await findEmailAction(article);
  if (emailAction && !config.apply_only) {
    verboseLog('Job route=email', { job_id: jobId });
    await emailAction.click().catch(() => {});
    await page.waitForTimeout(1200);
    result.email = await extractEmailFromArticle(article);
    result.submitted = false;
    if (result.email) {
      const mailResult = await sendEmailForJob(result.email, jobId, config, dryRun, jsonlPath);
      result.submitted = Boolean(mailResult.ok && !mailResult.skipped);
      result.description = `${result.description} | Email send: ${mailResult.ok ? 'ok' : mailResult.reason || 'failed'}`.trim();
    }
    await sleepJitter(config.jitter_min_ms, config.jitter_max_ms);
    return result;
  }

  const applyAction = await findApplyAction(article);
  if (applyAction) {
    verboseLog('Job route=apply', { job_id: jobId });
    result.submitted = await applyForJob(page, applyAction, config, dryRun, evidenceDir, jsonlPath, jobId);
    await sleepJitter(config.jitter_min_ms, config.jitter_max_ms);
    return result;
  }

  if (!config.apply_only) result.email = await extractEmailFromArticle(article);
  return result;
}

async function processJobWithRetry(page, article, jobId, config, dryRun, maxRetries, logDir, jsonlPath) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const evidenceDir = path.join(logDir, `${jobId}-${Date.now()}-attempt-${attempt}`);
    ensureDirSync(evidenceDir);

    try {
      verboseLog('Job attempt', { job_id: jobId, attempt, max_attempts: maxRetries + 1 });
      appendJsonLog(jsonlPath, { level: 'info', event: 'job_attempt', job_id: jobId, attempt });
      const row = await processJob(page, article, jobId, config, dryRun, evidenceDir, jsonlPath);
      appendJsonLog(jsonlPath, {
        level: 'info',
        event: 'job_success',
        job_id: jobId,
        attempt,
        submitted: row.submitted,
        email: Boolean(row.email),
      });
      return row;
    } catch (err) {
      lastError = err;
      verboseLog('Job attempt failed', { job_id: jobId, attempt, error: String(err?.message || err) });
      appendJsonLog(jsonlPath, {
        level: 'error',
        event: 'job_retry',
        job_id: jobId,
        attempt,
        error: String(err?.message || err),
      });
      if (attempt <= maxRetries) await page.waitForTimeout(1200);
    }
  }

  throw lastError || new Error('Unknown job processing error');
}

async function getTopJobIds(page, topN) {
  const jobs = page.locator('article.job-item');
  const count = Math.min(await jobs.count(), topN);
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = await jobs.nth(i).getAttribute('data-jobid');
    if (id) ids.push(id.trim());
  }
  return ids;
}

function buildStore(config, args, jsonlPath) {
  const output = args.output || config.output_mode;
  const stores = [];

  if (output === 'csv' || output === 'both') {
    stores.push(new CsvResultStore(config.csv_path));
  }

  if (output === 'notion' || output === 'both') {
    stores.push(new NotionResultStore(config.notion_token, config.notion_database_id, jsonlPath));
  }

  if (!stores.length) throw new Error(`Unsupported output mode: ${output}`);
  if (stores.length === 1) return stores[0];
  return new CombinedResultStore(stores);
}

function createSummary() {
  return {
    run_started_at: nowIso(),
    run_finished_at: null,
    dry_run: true,
    launch_mode: '',
    output_mode: '',
    top_jobs_count: 0,
    new_jobs_count: 0,
    processed_jobs: 0,
    applied_count: 0,
    email_count: 0,
    failed_count: 0,
    skipped_old_count: 0,
    errors: [],
  };
}

function writeSummary(logDir, summary) {
  const runFile = path.join(logDir, `summary-${nowCompact()}.json`);
  const latestFile = path.join(logDir, 'latest-summary.json');
  fs.writeFileSync(runFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(latestFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

function acquireRunLock(lockPath) {
  const content = JSON.stringify({ pid: process.pid, at: nowIso() }, null, 2);
  fs.writeFileSync(lockPath, content, { encoding: 'utf8', flag: 'wx' });
}

function releaseRunLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // Ignore unlock errors.
  }
}

function buildLaunchConfig(config, args) {
  if (!args.chromeProfile) {
    return {
      userDataDir: path.resolve(args.profileDir),
      launchOptions: {
        headless: config.headless,
        viewport: { width: 1440, height: 1000 },
      },
      mode: 'playwright-profile',
    };
  }

  const userDataDir = path.resolve(
    args.chromeUserDataDir || config.chrome_user_data_dir || defaultChromeUserDataDir()
  );
  const profileDirectory = args.chromeProfileDirectory || config.chrome_profile_directory || 'Default';

  return {
    userDataDir,
    launchOptions: {
      channel: 'chrome',
      headless: config.headless,
      viewport: { width: 1440, height: 1000 },
      args: [`--profile-directory=${profileDirectory}`],
    },
    mode: `chrome-profile:${profileDirectory}`,
  };
}

(async () => {
  let lockPathToRelease = null;
  let contextToClose = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    runtimeState.verbose = args.verbose;
    const dryRun = !args.realSubmit;
    const envPath = path.resolve(args.envFile);
    const envLoaded = loadDotEnv(envPath);

    const configPath = path.resolve(args.config);
    ensureConfigExists(configPath);

    const config = loadConfig(configPath);
    if (args.topN) config.top_n = args.topN;
    if (args.headless) config.headless = true;
    if (args.csv) config.csv_path = args.csv;
    if (args.applyOnly) config.apply_only = true;

    config.csv_path = path.resolve(path.dirname(configPath), config.csv_path);
    config.seen_jobs_path = path.resolve(path.dirname(configPath), config.seen_jobs_path);
    config.log_dir = path.resolve(path.dirname(configPath), config.log_dir);
    config.attachment_path = resolveMaybeAbsolutePath(path.dirname(configPath), config.attachment_file);
    config.email_attachment_path = resolveMaybeAbsolutePath(path.dirname(configPath), config.email_attachment_file);

    ensureDirSync(config.log_dir);
    const jsonlPath = path.join(config.log_dir, 'events.jsonl');
    cleanupOldLogs(config.log_dir, config.log_retention_days, jsonlPath);
    appendJsonLog(jsonlPath, { level: 'info', event: 'run_start', dry_run: dryRun });
    appendAppLog(`run_start dry_run=${dryRun}`);
    const summary = createSummary();
    summary.dry_run = dryRun;
    summary.output_mode = args.output || config.output_mode;

    const seenJobs = loadSeenJobs(config.seen_jobs_path);
    const resultStore = buildStore(config, args, jsonlPath);
    const lockPath = path.join(config.log_dir, '.run.lock');

    if (args.selfTest) {
      console.log(`[self-test] Env file: ${envPath} (loaded=${envLoaded})`);
      console.log(`[self-test] Config loaded: ${configPath}`);
      console.log(`[self-test] Dry-run default: ${dryRun}`);
      console.log(`[self-test] Output mode: ${args.output || config.output_mode}`);
      console.log(`[self-test] Attachment: ${config.attachment_path} (exists=${fs.existsSync(config.attachment_path)})`);
      console.log(`[self-test] Email auto-send: ${config.email_auto_send}`);
      console.log(
        `[self-test] Email attachment: ${config.email_attachment_path} (exists=${fs.existsSync(config.email_attachment_path)})`
      );
      console.log(`[self-test] Seen jobs file: ${config.seen_jobs_path}`);
      console.log(`[self-test] Seen jobs count: ${Object.keys(seenJobs).length}`);
      const notionConfigured = Boolean(config.notion_token && config.notion_database_id);
      console.log(`[self-test] Notion configured: ${notionConfigured}`);
      if (notionConfigured) {
        try {
          const notionTest = new NotionResultStore(config.notion_token, config.notion_database_id, jsonlPath);
          await notionTest.validateSchema();
          console.log('[self-test] Notion schema: OK');
          const testRes = await notionTest.upsertSelfTest();
          console.log(`[self-test] Notion write: OK (Name=${testRes.job_id}, at=${testRes.at})`);
        } catch (e) {
          console.log(`[self-test] Notion write: FAILED (${e.message})`);
          throw e;
        }
      }
      appendJsonLog(jsonlPath, { level: 'info', event: 'self_test_done' });
      appendAppLog('self_test_done');
      return;
    }

    try {
      acquireRunLock(lockPath);
    } catch {
      throw new Error(`Another run seems active (.run.lock exists at ${lockPath}).`);
    }
    lockPathToRelease = lockPath;

    const launch = buildLaunchConfig(config, args);
    console.log(`[info] Launch mode: ${launch.mode}`);
    console.log(`[info] Submit mode: ${dryRun ? 'DRY-RUN (safe)' : 'REAL SUBMIT'}`);
    if (runtimeState.verbose) console.log('[info] Verbose mode: ON');
    appendAppLog(`launch mode=${launch.mode} submit_mode=${dryRun ? 'dry-run' : 'real-submit'}`);
    verboseLog('Resolved run paths', {
      config_path: configPath,
      csv_path: config.csv_path,
      seen_jobs_path: config.seen_jobs_path,
      log_dir: config.log_dir,
      attachment_path: config.attachment_path,
      email_attachment_path: config.email_attachment_path,
      env_file: envPath,
      env_loaded: envLoaded,
    });
    summary.launch_mode = launch.mode;

    let context;
    try {
      context = await chromium.launchPersistentContext(launch.userDataDir, launch.launchOptions);
    } catch (e) {
      if (args.chromeProfile) {
        throw new Error(
          `Failed to open Chrome profile. Close all Chrome windows and retry. Root error: ${e.message}`
        );
      }
      throw e;
    }
    contextToClose = context;

    // Always use a fresh controlled tab. Existing profile tabs may contain
    // startup pages/extensions and can cause about:blank confusion.
    const page = await context.newPage();
    verboseLog('Browser launched', { mode: launch.mode, user_data_dir: launch.userDataDir });
    const stores = resultStore instanceof CombinedResultStore ? resultStore.stores : [resultStore];
    for (const store of stores) {
      if (store instanceof NotionResultStore && store.enabled) {
        await store.validateSchema();
        appendJsonLog(jsonlPath, { level: 'info', event: 'notion_schema_ok' });
      }
    }

    try {
      verboseLog('Navigating to target URL', { url: config.target_url });
      await page.goto(config.target_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      throw new Error(`Failed to open target_url. Check config target_url and network. Root error: ${e.message}`);
    }
    await page.waitForTimeout(1000);
    await dismissCookieBanner(page);
    await page.waitForTimeout(800);
    await waitForJobs(page);
    await page.waitForTimeout(1000);
    await ensureNewestSort(page, jsonlPath, config);
    await page.waitForTimeout(1500);

    if ((await needsLogin(page)) && !args.skipLoginWait) {
      const loggedIn = await waitForManualLogin(page, config.wait_for_login_seconds);
      if (!loggedIn) {
        appendJsonLog(jsonlPath, { level: 'warn', event: 'not_logged_in' });
        appendErrorLog('not_logged_in warning: actions may be unavailable');
        console.log('[warn] Still not logged in; email/apply actions may be unavailable.');
      } else {
        await ensureNewestSort(page, jsonlPath, config);
      }
    }

    const jobIds = await getTopJobIds(page, config.top_n);
    const newJobIds = jobIds.filter((id) => !seenJobs[id]);
    summary.top_jobs_count = jobIds.length;
    summary.new_jobs_count = newJobIds.length;
    summary.skipped_old_count = jobIds.length - newJobIds.length;

    console.log(`[info] Top ${jobIds.length}: ${jobIds.join(', ') || '-'}`);
    console.log(`[info] New in top list: ${newJobIds.join(', ') || 'none'}`);
    verboseLog('Job list resolved', { top_n: config.top_n, total_found: jobIds.length, new_found: newJobIds.length });

    const articles = page.locator('article.job-item');

    for (let i = 0; i < jobIds.length; i += 1) {
      const jobId = jobIds[i];
      const now = nowIso();

      if (!seenJobs[jobId]) {
        seenJobs[jobId] = { first_seen_at: now, last_seen_at: now };
      } else {
        seenJobs[jobId].last_seen_at = now;
      }

      if (!newJobIds.includes(jobId)) continue;

      const article = articles.nth(i);
      await article.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      verboseLog('Processing job', { job_id: jobId, index: i });

      let result;
      try {
        result = await processJobWithRetry(
          page,
          article,
          jobId,
          config,
          dryRun,
          Math.max(0, config.max_retries),
          config.log_dir,
          jsonlPath
        );
      } catch (e) {
        appendJsonLog(jsonlPath, { level: 'error', event: 'job_failed', job_id: jobId, error: String(e.message || e) });
        appendErrorLog(`job_failed job_id=${jobId} error="${String(e.message || e)}"`);
        summary.failed_count += 1;
        summary.errors.push({ job_id: jobId, error: String(e.message || e) });
        result = {
          job_id: jobId,
          email: '',
          submitted: false,
          date: nowIso(),
          title: '',
          description: `Failed: ${e.message || e}`,
        };
      }

      await resultStore.save(result);
      summary.processed_jobs += 1;
      if (result.submitted) summary.applied_count += 1;
      if (result.email) summary.email_count += 1;
      seenJobs[jobId].last_result = {
        at: nowIso(),
        submitted: result.submitted,
        email: result.email || '',
      };

      console.log(`[info] ${jobId}: email=${result.email ? 'yes' : 'no'} submitted=${result.submitted}`);
      appendAppLog(`job_processed job_id=${jobId} email=${result.email ? 'yes' : 'no'} submitted=${result.submitted}`);
      await sleepJitter(config.jitter_min_ms, config.jitter_max_ms);
    }

    saveSeenJobs(config.seen_jobs_path, seenJobs);
    summary.run_finished_at = nowIso();
    writeSummary(config.log_dir, summary);
    appendJsonLog(jsonlPath, { level: 'info', event: 'run_done', processed_new_jobs: newJobIds.length });
    appendAppLog(`run_done processed_new_jobs=${newJobIds.length}`);

  } catch (error) {
    console.error(`[fatal] ${error.message}`);
    if (runtimeState.verbose && error?.stack) console.error(error.stack);
    appendErrorLog(`fatal error="${error.message}"`);
    process.exitCode = 1;
  } finally {
    if (contextToClose) {
      try {
        await contextToClose.close();
      } catch {
        // Ignore close errors on shutdown.
      }
    }
    if (lockPathToRelease) releaseRunLock(lockPathToRelease);
  }
})();
