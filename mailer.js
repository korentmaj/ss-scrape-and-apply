'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const nodemailer = require('nodemailer');

const DEFAULT_STATE_FILE = path.resolve(process.cwd(), 'mailer_state.json');
const DEFAULT_LOG_FILE = path.resolve(process.cwd(), 'mailer_logs.jsonl');
const HARD_DAILY_CAP = 5;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function parseBooleanStrict(name, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly 'true' or 'false'.`);
}

function parseIntegerStrict(name, value) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new Error(`${name} must be an integer.`);
  }
  return n;
}

function validateConfig(env) {
  const required = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'MAIL_FROM',
    'MAIL_DAILY_CAP',
    'MAIL_DRY_RUN',
  ];

  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const host = String(env.SMTP_HOST).trim();
  if (host.toLowerCase() !== 'smtp.gmail.com') {
    throw new Error(`SMTP_HOST must be smtp.gmail.com (got '${host}').`);
  }

  const port = parseIntegerStrict('SMTP_PORT', env.SMTP_PORT);
  if (port !== 587) {
    throw new Error(`SMTP_PORT must be 587 (got '${port}').`);
  }

  const dryRun = parseBooleanStrict('MAIL_DRY_RUN', String(env.MAIL_DRY_RUN).trim().toLowerCase());

  const configuredCap = parseIntegerStrict('MAIL_DAILY_CAP', env.MAIL_DAILY_CAP);
  if (configuredCap < 1) {
    throw new Error('MAIL_DAILY_CAP must be >= 1.');
  }

  return {
    smtpHost: host,
    smtpPort: port,
    smtpUser: String(env.SMTP_USER).trim(),
    smtpPass: String(env.SMTP_PASS),
    mailFrom: String(env.MAIL_FROM).trim(),
    dryRun,
    dailyCap: Math.min(configuredCap, HARD_DAILY_CAP),
  };
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function normalizeState(state) {
  const today = todayUtc();
  const base = {
    daily_count: 0,
    last_reset_date: today,
    sent_keys: [],
    successful_sends: [],
  };

  if (!state || typeof state !== 'object') return base;

  const normalized = {
    daily_count: Number.isFinite(state.daily_count) ? state.daily_count : 0,
    last_reset_date: typeof state.last_reset_date === 'string' ? state.last_reset_date : today,
    sent_keys: Array.isArray(state.sent_keys) ? state.sent_keys : [],
    successful_sends: Array.isArray(state.successful_sends) ? state.successful_sends : [],
  };

  if (normalized.last_reset_date !== today) {
    normalized.daily_count = 0;
    normalized.last_reset_date = today;
  }

  return normalized;
}

async function writeJsonAtomic(filePath, obj) {
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  await fs.rename(temp, filePath);
}

function dedupeKey(jobId, recipient) {
  return `${String(jobId).trim()}::${String(recipient).trim().toLowerCase()}`;
}

function validatePayload(payload) {
  const required = ['to', 'subject', 'job_id'];
  const missing = required.filter((key) => !payload || !payload[key]);
  if (missing.length) {
    throw new Error(`sendEmail missing required fields: ${missing.join(', ')}`);
  }

  if (!payload.text && !payload.html) {
    throw new Error('sendEmail requires at least one body: text or html.');
  }

  if (payload.attachments !== undefined && !Array.isArray(payload.attachments)) {
    throw new Error('sendEmail attachments must be an array when provided.');
  }
}

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: false,
    requireTLS: true,
    tls: {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    },
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
}

function buildLogger(logFile) {
  return async function log(entry) {
    const line = JSON.stringify({ timestamp: nowIso(), ...entry });
    await fs.appendFile(logFile, `${line}\n`, 'utf8');
  };
}

function createMailer(options = {}) {
  const env = options.env || process.env;
  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const logFile = options.logFile || DEFAULT_LOG_FILE;
  const log = buildLogger(logFile);

  const config = validateConfig(env);
  const transporter = createTransport(config);

  async function loadState() {
    const raw = await safeReadJson(stateFile);
    return normalizeState(raw);
  }

  async function saveState(state) {
    await writeJsonAtomic(stateFile, state);
  }

  async function sendEmail(payload) {
    try {
      validatePayload(payload);

      const state = await loadState();
      const key = dedupeKey(payload.job_id, payload.to);

      if (state.sent_keys.includes(key)) {
        await log({
          event: 'dedupe_blocked',
          job_id: payload.job_id,
          recipient: payload.to,
          reason: 'already_sent',
        });
        return { ok: false, skipped: true, reason: 'dedupe_blocked' };
      }

      if (state.daily_count >= config.dailyCap) {
        await log({
          event: 'daily_cap_blocked',
          job_id: payload.job_id,
          recipient: payload.to,
          daily_count: state.daily_count,
          daily_cap: config.dailyCap,
        });
        return { ok: false, skipped: true, reason: 'daily_cap_blocked' };
      }

      if (config.dryRun) {
        await log({
          event: 'dry_run_payload',
          job_id: payload.job_id,
          recipient: payload.to,
          subject: payload.subject,
          has_text: Boolean(payload.text),
          has_html: Boolean(payload.html),
          attachments_count: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
          from: config.mailFrom,
        });
        return { ok: true, dry_run: true, skipped: true };
      }

      const result = await transporter.sendMail({
        from: config.mailFrom,
        to: payload.to,
        subject: payload.subject,
        text: payload.text || undefined,
        html: payload.html || undefined,
        attachments: Array.isArray(payload.attachments) ? payload.attachments : undefined,
      });

      state.daily_count += 1;
      state.sent_keys.push(key);
      state.successful_sends.push({
        recipient: payload.to,
        job_id: payload.job_id,
        timestamp: nowIso(),
        smtp_response: result.response || '',
      });

      await saveState(state);

      await log({
        event: 'send_success',
        job_id: payload.job_id,
        recipient: payload.to,
        smtp_response: result.response || '',
        message_id: result.messageId || '',
        daily_count: state.daily_count,
      });

      return {
        ok: true,
        dry_run: false,
        smtp_response: result.response || '',
        message_id: result.messageId || '',
      };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      await log({
        event: 'send_failure',
        job_id: payload && payload.job_id ? payload.job_id : null,
        recipient: payload && payload.to ? payload.to : null,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  return { sendEmail };
}

let singleton = null;

async function sendEmail(payload) {
  try {
    if (!singleton) singleton = createMailer();
    return await singleton.sendEmail(payload);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    try {
      await fs.appendFile(
        DEFAULT_LOG_FILE,
        `${JSON.stringify({ timestamp: nowIso(), event: 'config_error', error: message })}\n`,
        'utf8'
      );
    } catch {
      // If logging fails here, return the config error anyway.
    }
    return { ok: false, error: message };
  }
}

module.exports = {
  createMailer,
  sendEmail,
};
