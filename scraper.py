#!/usr/bin/env python3
"""Scrape top jobs and auto-handle email/apply actions on studentski-servis.com."""

from __future__ import annotations

import argparse
import csv
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import unquote, urljoin

from playwright.sync_api import Error, Locator, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


DEFAULT_TARGET_URL = (
    "https://www.studentski-servis.com/studenti/prosta-dela?kljb=&page=1&isci=1&sort=1&dm1s=1"
    "&skD%5B%5D=004&skD%5B%5D=A832&skD%5B%5D=A210&skD%5B%5D=A055&skD%5B%5D=A078"
    "&skD%5B%5D=A090&skD%5B%5D=A095&hourlyratefrom=7.73&hourlyrateto=31&hourly_rate=7.73%3B26"
)

CONFIG_TEMPLATE = """# Key=value config for scraper.py
application_message=Pozdravljeni, prilagam svoj CV.
work_schedule=40 ur na teden.
availability_message=na voljo sem kadarkoli med tednom
target_url={target_url}
top_n=5
headless=false
wait_for_login_seconds=240
"""

CSV_FIELDS = ["job_id", "email", "submitted"]


@dataclass
class Config:
    application_message: str
    work_schedule: str
    availability_message: str
    target_url: str
    top_n: int
    headless: bool
    wait_for_login_seconds: int


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    without_marks = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return without_marks.lower().strip()


def parse_bool(raw: str, default: bool) -> bool:
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "y", "on"}:
        return True
    if value in {"0", "false", "no", "n", "off"}:
        return False
    return default


def ensure_config_exists(path: Path) -> None:
    if path.exists():
        return
    path.write_text(CONFIG_TEMPLATE.format(target_url=DEFAULT_TARGET_URL), encoding="utf-8")
    print(f"[info] Created default config: {path}")


def load_config(path: Path) -> Config:
    values: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()

    return Config(
        application_message=values.get("application_message", "Pozdravljeni, prilagam svoj CV."),
        work_schedule=values.get("work_schedule", "40 ur na teden."),
        availability_message=values.get("availability_message", "na voljo sem kadarkoli med tednom"),
        target_url=values.get("target_url", DEFAULT_TARGET_URL),
        top_n=int(values.get("top_n", "5")),
        headless=parse_bool(values.get("headless"), default=False),
        wait_for_login_seconds=int(values.get("wait_for_login_seconds", "240")),
    )


def load_csv_rows(path: Path) -> Dict[str, Dict[str, str]]:
    if not path.exists():
        return {}

    rows: Dict[str, Dict[str, str]] = {}
    with path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            job_id = (row.get("job_id") or "").strip()
            if not job_id:
                continue
            rows[job_id] = {
                "job_id": job_id,
                "email": (row.get("email") or "").strip(),
                "submitted": normalize_text(row.get("submitted", "false")) == "true",
            }
    return rows


def save_csv_rows(path: Path, rows: Dict[str, Dict[str, str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in rows.values():
            writer.writerow(
                {
                    "job_id": row.get("job_id", ""),
                    "email": row.get("email", ""),
                    "submitted": "true" if bool(row.get("submitted")) else "false",
                }
            )


def dismiss_cookie_banner(page: Page) -> None:
    selectors = [
        "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
        "button:has-text('Sprejmi')",
        "button:has-text('Strinjam se')",
    ]
    for selector in selectors:
        loc = page.locator(selector)
        if loc.count() == 0:
            continue
        try:
            if loc.first.is_visible(timeout=500):
                loc.first.click()
                page.wait_for_timeout(600)
                return
        except Error:
            continue


def wait_for_jobs(page: Page, timeout_ms: int = 30_000) -> None:
    page.wait_for_selector("article.job-item", timeout=timeout_ms)


def needs_login(page: Page) -> bool:
    text_candidates = [
        "button:has-text('VSTOPI IN SI POGLEJ VEČ')",
        "button:has-text('VSTOPI IN SI POGLEJ VEC')",
    ]
    for selector in text_candidates:
        loc = page.locator(selector)
        if loc.count() > 0:
            try:
                if loc.first.is_visible(timeout=300):
                    return True
            except Error:
                pass

    buttons = page.locator("article.job-item button")
    limit = min(buttons.count(), 10)
    for idx in range(limit):
        txt = normalize_text(buttons.nth(idx).inner_text(timeout=300))
        if "vstopi" in txt and "poglej" in txt:
            return True
    return False


def wait_for_manual_login(page: Page, wait_seconds: int) -> bool:
    if not needs_login(page):
        return True

    print("[warn] Login is required to reveal contact/apply buttons.")
    print("[warn] Log in inside the opened browser profile, then press Enter.")

    if sys.stdin.isatty():
        try:
            input("[input] After login press Enter to continue... ")
        except EOFError:
            pass
        page.reload(wait_until="domcontentloaded")
        dismiss_cookie_banner(page)
        wait_for_jobs(page)
        return not needs_login(page)

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if not needs_login(page):
            return True
        time.sleep(3)
        page.reload(wait_until="domcontentloaded")
        dismiss_cookie_banner(page)
        wait_for_jobs(page)

    return not needs_login(page)


def first_visible_locator(page: Page, selectors: List[str]) -> Optional[Locator]:
    for selector in selectors:
        loc = page.locator(selector)
        count = loc.count()
        for idx in range(count):
            candidate = loc.nth(idx)
            try:
                if candidate.is_visible(timeout=500):
                    return candidate
            except Error:
                continue
    return None


def fill_first(page: Page, selectors: List[str], value: str, required: bool = False) -> bool:
    loc = first_visible_locator(page, selectors)
    if not loc:
        if required:
            raise RuntimeError(f"Could not find required input for selectors: {selectors}")
        return False
    loc.fill(value)
    return True


def extract_email_from_article(article: Locator) -> str:
    anchors = article.locator("a[href^='mailto:']")
    if anchors.count() > 0:
        href = anchors.first.get_attribute("href") or ""
        match = re.search(r"mailto:([^?]+)", href, flags=re.IGNORECASE)
        return unquote(match.group(1).strip()) if match else ""

    html = article.inner_html()
    match = re.search(r"mailto:([^\"'?]+)", html, flags=re.IGNORECASE)
    return unquote(match.group(1).strip()) if match else ""


def find_email_action(article: Locator) -> Optional[Locator]:
    items = article.locator("button, a")
    count = items.count()
    for idx in range(count):
        el = items.nth(idx)
        text = normalize_text(el.inner_text(timeout=300))
        if ("prikazi" in text or "pokazi" in text) and ("mail" in text or "email" in text):
            return el
    return None


def find_apply_action(article: Locator) -> Optional[Locator]:
    class_match = article.locator("a.d-block.px-0.mt-2")
    if class_match.count() > 0:
        return class_match.first

    items = article.locator("button, a")
    count = items.count()
    for idx in range(count):
        el = items.nth(idx)
        text = normalize_text(el.inner_text(timeout=300))
        if ("prijava" in text and "delo" in text) or ("prijavi" in text and "delo" in text):
            return el
    return None


def ensure_attachments_ready(page: Page) -> bool:
    button = first_visible_locator(
        page,
        [
            "xpath=/html/body/main/div/section/div[2]/div/form/div[10]/div/div/button",
            "form div button:has-text('Prilog')",
            "form div button:has-text('CV')",
        ],
    )
    if button:
        return True

    switch = first_visible_locator(
        page,
        [
            "xpath=/html/body/main/div/section/div[2]/div/form/div[10]/div/div/div[1]/div/input",
            "input[type='checkbox'][name*='prilog']",
            "input[type='checkbox'][id*='prilog']",
        ],
    )
    if not switch:
        return False

    try:
        checked = switch.is_checked()
    except Error:
        checked = False

    if not checked:
        switch.click(force=True)
        page.wait_for_timeout(800)

    button = first_visible_locator(
        page,
        [
            "xpath=/html/body/main/div/section/div[2]/div/form/div[10]/div/div/button",
            "form div button:has-text('Prilog')",
            "form div button:has-text('CV')",
        ],
    )
    return button is not None


def submit_application(page: Page, dry_run: bool) -> bool:
    if dry_run:
        print("[dry-run] Submission skipped.")
        return False

    submit_btn = first_visible_locator(
        page,
        [
            "xpath=/html/body/main/div/section/div[2]/div/form/button",
            "form button[type='submit']",
            "form button:has-text('Prijav')",
            "form button:has-text('Oddaj')",
        ],
    )
    if not submit_btn:
        return False

    before_url = page.url
    submit_btn.click()
    page.wait_for_timeout(2500)

    errors = page.locator(".alert-danger, .invalid-feedback, .is-invalid")
    if errors.count() > 0:
        return False

    success_hint = page.locator("text=/uspe[sš]no|hvala|oddana/i")
    if success_hint.count() > 0:
        return True

    return page.url != before_url or True


def open_apply_page(list_page: Page, action: Locator) -> Optional[Page]:
    href = action.get_attribute("href")

    if href:
        app_page = list_page.context.new_page()
        app_page.goto(urljoin("https://www.studentski-servis.com", href), wait_until="domcontentloaded")
        return app_page

    try:
        with list_page.context.expect_page(timeout=7000) as event:
            action.click()
        app_page = event.value
        app_page.wait_for_load_state("domcontentloaded")
        return app_page
    except PlaywrightTimeoutError:
        return None


def apply_for_job(list_page: Page, action: Locator, config: Config, dry_run: bool) -> bool:
    app_page = open_apply_page(list_page, action)
    if not app_page:
        print("[warn] Could not open application page.")
        return False

    try:
        app_page.wait_for_timeout(800)
        dismiss_cookie_banner(app_page)

        extra_section = first_visible_locator(
            app_page,
            [
                "xpath=/html/body/main/div/section/div[2]/div/form/h3[2]",
                "h3.mb-0.mt-4",
            ],
        )

        if extra_section:
            fill_first(
                app_page,
                [
                    "xpath=//*[@id='input-field-opt4']",
                    "#input-field-opt4",
                    "input[placeholder*='Kako lahko dela']",
                ],
                config.work_schedule,
                required=False,
            )
            fill_first(
                app_page,
                [
                    "xpath=/html/body/main/div/section/div[2]/div/form/div[7]/div/textarea",
                    "textarea[placeholder*='Kdaj si na voljo']",
                    "textarea[placeholder*='Kdaj si na voljo za delo']",
                ],
                config.availability_message,
                required=False,
            )

        fill_first(
            app_page,
            [
                "xpath=/html/body/main/div/section/div[2]/div/form/div[8]/div/textarea",
                "textarea[name='besedilo_prijave']",
            ],
            config.application_message,
            required=True,
        )

        attachments_ready = ensure_attachments_ready(app_page)
        if not attachments_ready:
            print("[warn] Attachment switch/button not ready.")

        return submit_application(app_page, dry_run=dry_run)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] Application flow failed: {exc}")
        return False
    finally:
        app_page.close()


def process_job(page: Page, article: Locator, job_id: str, config: Config, dry_run: bool) -> Dict[str, str]:
    result = {
        "job_id": job_id,
        "email": "",
        "submitted": False,
    }

    email_action = find_email_action(article)
    if email_action:
        if dry_run:
            print(f"[dry-run] Job {job_id}: email action detected.")
        else:
            email_action.click()
            page.wait_for_timeout(1200)
        result["email"] = extract_email_from_article(article)
        result["submitted"] = False
        return result

    apply_action = find_apply_action(article)
    if apply_action:
        result["submitted"] = apply_for_job(page, apply_action, config, dry_run=dry_run)
        return result

    # Fallback if mailto is already visible without clicking the button.
    result["email"] = extract_email_from_article(article)
    return result


def get_top_job_ids(page: Page, top_n: int) -> List[str]:
    jobs = page.locator("article.job-item")
    count = min(jobs.count(), top_n)
    ids: List[str] = []
    for idx in range(count):
        job_id = jobs.nth(idx).get_attribute("data-jobid")
        if job_id:
            ids.append(job_id.strip())
    return ids


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Studentski servis scraper + auto apply")
    parser.add_argument("--config", default="config.txt", help="Path to config file")
    parser.add_argument("--csv", default="jobs.csv", help="Path to output CSV")
    parser.add_argument("--profile-dir", default=".playwright-profile", help="Persistent browser profile dir")
    parser.add_argument("--headless", action="store_true", help="Force headless mode")
    parser.add_argument("--dry-run", action="store_true", help="Do not submit applications")
    parser.add_argument("--top-n", type=int, default=None, help="Override top jobs to inspect")
    parser.add_argument("--skip-login-wait", action="store_true", help="Do not wait for manual login")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    config_path = Path(args.config)
    csv_path = Path(args.csv)
    profile_dir = Path(args.profile_dir)

    ensure_config_exists(config_path)
    config = load_config(config_path)

    if args.top_n:
        config.top_n = args.top_n
    if args.headless:
        config.headless = True

    rows = load_csv_rows(csv_path)

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=config.headless,
            viewport={"width": 1440, "height": 1000},
        )
        page = context.pages[0] if context.pages else context.new_page()

        page.goto(config.target_url, wait_until="domcontentloaded")
        dismiss_cookie_banner(page)
        wait_for_jobs(page)

        if needs_login(page) and not args.skip_login_wait:
            logged_in = wait_for_manual_login(page, config.wait_for_login_seconds)
            if not logged_in:
                print("[warn] Still not logged in. Email/apply actions might not be available.")

        job_ids = get_top_job_ids(page, config.top_n)
        new_job_ids = [job_id for job_id in job_ids if job_id not in rows]

        print(f"[info] Top {len(job_ids)} job IDs: {', '.join(job_ids) if job_ids else '-'}")
        print(f"[info] New job IDs this run: {', '.join(new_job_ids) if new_job_ids else 'none'}")

        articles = page.locator("article.job-item")

        for idx, job_id in enumerate(job_ids):
            if job_id not in new_job_ids:
                continue

            article = articles.nth(idx)
            article.scroll_into_view_if_needed()

            try:
                row = process_job(page, article, job_id, config, dry_run=args.dry_run)
            except Exception as exc:  # noqa: BLE001
                print(f"[error] Job {job_id} failed: {exc}")
                row = {"job_id": job_id, "email": "", "submitted": False}

            rows[job_id] = row
            print(
                f"[info] Processed {job_id}: "
                f"email={'yes' if row['email'] else 'no'}, submitted={row['submitted']}"
            )

        save_csv_rows(csv_path, rows)
        print(f"[info] CSV updated: {csv_path}")

        context.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
