'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sendEmail } = require('./mailer');

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

(async () => {
  const envPath = path.resolve(process.cwd(), '.env');
  const loaded = loadDotEnv(envPath);
  console.log(`[mailer-example] .env loaded: ${loaded}`);

  const result = await sendEmail({
    to: process.env.MAIL_TEST_TO || process.env.SMTP_USER || '',
    subject: 'SMTP test - Studentski showcase',
    text: 'This is a test email from the showcase mailer module.',
    html: '<p>This is a test email from the showcase mailer module.</p>',
    job_id: 'EXAMPLE-JOB-001',
  });

  console.log('[mailer-example] result:', JSON.stringify(result));

  if (!result.ok) process.exitCode = 1;
})();
