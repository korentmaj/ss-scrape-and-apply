# ss-scrape-and-apply

**Disclaimer:** Use this at your own risk. Automating logins and job applications very
likely goes against the Studentski servis terms of use, and it could get your account
flagged, suspended or banned. I take no responsibility for how you use it or for whatever
happens to your account. It is just an old personal project, shared as is.

I built this about a year ago and used it for a while to apply for student jobs through
Studentski servis. I haven't used it in a long time now since I don't really need it
anymore, so I figured I'd just put it up here. I can't promise how well it still works.
If you download it, you'll probably need to adjust and update a few things to get it
running against the current site.

All of the "CS" gigs that I have gotten in the past year were done through this tool.

A small scraper / auto-apply tool for
[studentski-servis.com](https://www.studentski-servis.com), the Slovenian student-work
portal. It opens the job listing, looks at the top few newest ads, and for each new one
either grabs the contact email or fills in the web application form. Results are written
to a Notion database and/or a local CSV.

It uses a real Chrome profile through Playwright, so you log in once and the session
is reused on later runs. This is a hobby/showcase project, not a polished product.
The selectors are tied to the current site layout and may break if the site changes.

## Requirements

- Node.js 18+ (LTS recommended)
- Chromium installed via Playwright (the setup step does this)
- A Notion integration token + database (optional, only if you use Notion output)
- A Gmail account with an App Password (optional, only for the email mailer)

## Setup

### Linux / macOS

```bash
npm install --no-audit --no-fund
npx playwright install chromium
cp .env.example .env        # then edit .env
```

On a fresh Linux machine Playwright may also need system libraries:

```bash
npx playwright install-deps chromium
```

### Windows

```powershell
npm install --no-audit --no-fund
npx playwright install chromium
Copy-Item .env.example .env   # then edit .env
```

There is a helper script for each platform:

```bash
./run_scraper.sh setup        # Linux / macOS
```

```powershell
.\run_scraper.ps1 -Mode setup  # Windows (or run_scraper.bat setup)
```

## Configuration

Two files drive the behaviour:

- **`.env`** holds your secrets and switches. Copy it from `.env.example` and fill in
  your Notion token and/or Gmail SMTP credentials. `.env` is git-ignored, keep it that way.
- **`config.json`** holds the scraper settings: the target URL, how many ads to check
  (`top_n`), the application message, the attachment file name, etc.

Put your CV in the project root as **`cv.pdf`** (or change `attachment_file` /
`email_attachment_file` in `config.json` to point at your file). The CV is git-ignored
so it never ends up in the repo.

If you use Notion, the database needs these columns:

| Column      | Type  |
|-------------|-------|
| `Name`      | Title |
| `Prijavljen`| Text  |
| `Datum`     | Text  |
| `Opis`      | Text  |

Connect your Notion integration to the database (Connections), then put the token and
database id into `.env`.

For email, enable 2-Step Verification on your Google account, generate a Gmail App
Password, and set the `SMTP_*` / `MAIL_*` values in `.env`. Keep `MAIL_DRY_RUN=true`
until you have tested it. In dry-run mode emails are logged but not actually sent.

## First run

Run in visible mode and log in manually when Chrome opens:

```bash
node scraper.js --chrome-profile --verbose
```

After you log in to Studentski servis, let the run continue. The session is saved in
the local browser profile and reused next time. Close other Chrome windows before
running.

## Daily usage

Safe test run (no real submit, no real email):

```bash
node scraper.js --chrome-profile
```

Live run (submits forms and sends emails):

```bash
node scraper.js --chrome-profile --real-submit
```

Add `--verbose` for step-by-step logs. The same modes are available through the
helper scripts, e.g. `./run_scraper.sh chrome-real-verbose` or
`.\run_scraper.ps1 -Mode chrome-real-verbose`.

## Health check

```bash
npm run self-test
```

This validates the config and, if Notion is configured, writes a single `SELF-TEST`
row to verify the connection.

## Files created at runtime

All of these are git-ignored:

- `logs/`: per-run event logs and screenshots
- `app.log`, `error.log`: general and error logs
- `jobs.csv`, `seen_jobs.json`: output and dedupe state
- `mailer_state.json`, `mailer_logs.jsonl`: mailer daily-cap and attempt logs

## Note

`scraper.py` is an older, standalone Python prototype of the same idea (config in
`config.txt`, CSV output only). The Node version (`scraper.js`) is the maintained one.

## License

GPL-3.0. See [LICENSE](LICENSE).
