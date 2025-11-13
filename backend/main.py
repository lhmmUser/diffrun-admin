from fastapi import Query
from typing import Optional, List
from app.routers.cloudprinter_produce_webhook import router as cp_produce_router
from dateutil import parser
from fastapi import FastAPI, BackgroundTasks, Response, Query, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from dotenv import load_dotenv
import os
from fastapi.encoders import jsonable_encoder
from typing import Any, Dict, List, Optional, Union, Literal, Tuple
from datetime import datetime, time, timedelta, timezone
import requests
import hashlib
import PyPDF2
import io
import smtplib
from email.message import EmailMessage
import logging
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field, ConfigDict
from contextlib import asynccontextmanager
from apscheduler.schedulers.background import BackgroundScheduler
import boto3
import csv
from fastapi.responses import FileResponse, StreamingResponse
import tempfile
from dateutil import parser
from app.routers.reconcile import router as vlookup_router
from app.routers.reconcile import _auto_reconcile_and_sign_once
from app.routers.razorpay_export import router as razorpay_router
from app.routers.cloudprinter_webhook import router as cloudprinter_router
import pandas as pd
from botocore.exceptions import BotoCoreError, ClientError
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
import pytz
from io import BytesIO
from typing import Tuple
from zoneinfo import ZoneInfo
import re
import json
import httpx
import html
import asyncio
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, NoCredentialsError, PartialCredentialsError
from pymongo.collection import Collection
from calendar import monthrange
import gspread
from google.oauth2.service_account import Credentials as _GoogleCredentials
from decimal import Decimal
from bson import ObjectId
from datetime import datetime, date
from zoneinfo import ZoneInfo
from datetime import datetime
from app.routers.shiprocket_webhook import router as shiprocket_router


IST_TZ = pytz.timezone("Asia/Kolkata")
API_BASE = os.getenv("NEXT_PUBLIC_API_BASE_URL", "http://127.0.0.1:5000")
# Setup logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger = logging.getLogger("xlsx_cron")

load_dotenv()

EMAIL_USER = os.getenv("EMAIL_ADDRESS")
EMAIL_PASS = os.getenv("EMAIL_PASSWORD")
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
EMAIL_FROM = os.getenv("EMAIL_FROM", EMAIL_USER)
EMAIL_TO_RAW = os.getenv("EMAIL_TO", "")
EMAIL_TO = [e.strip() for e in EMAIL_TO_RAW.split(",") if e.strip()]
SMTP_USER = os.getenv("SMTP_USER", EMAIL_USER)
SMTP_PASS = os.getenv("SMTP_PASS", EMAIL_PASS)
NUDGE_MIN_WORKFLOWS = int(os.getenv("NUDGE_MIN_WORKFLOWS", "13"))

MONGO_URI_df = os.getenv("MONGO_URI_df")
client_df = MongoClient(MONGO_URI_df)
df_db = client_df["df-db"]
collection_df = df_db["user-data"]

MONGO_URI_YIPPEE = os.getenv("MONGO_URI_YIPPEE")
client_yippee = MongoClient(MONGO_URI_YIPPEE)
yippee_db = client_yippee["yippee-db"]
collection_yippee = yippee_db["user-data"]

MONGO_URI = os.getenv("MONGO_URI")
if not MONGO_URI:
    raise RuntimeError("MONGO_URI not set")

client = MongoClient(MONGO_URI, tz_aware=True)
db = client["candyman"]
shipping_collection = db["shipping_details"]

scheduler = BackgroundScheduler(timezone=IST_TZ)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        if not scheduler.running:
            scheduler.start()

        # capture the running loop for thread-safe submission
        loop = asyncio.get_running_loop()

        def _kick_auto_reconcile():
            # schedule the coroutine on the FastAPI event loop
            asyncio.run_coroutine_threadsafe(_auto_reconcile_and_sign_once(), loop)

        # every 5 minutes
        scheduler.add_job(
            _kick_auto_reconcile,
            trigger=CronTrigger(minute="*/5", timezone=IST_TZ),
            id="auto_reconcile_every_5m",
            replace_existing=True,
            coalesce=True,
            max_instances=1,
        )

        # your existing jobs stay unchanged
        scheduler.add_job(
            _run_export_and_email,
            trigger=CronTrigger(hour="0,3,6,9,12,15,18,21", minute="0", timezone=IST_TZ),
            id="xlsx_export_fixed_ist_times",
            replace_existing=True,
            coalesce=True,
            max_instances=1,
        )

        scheduler.add_job(
            run_feedback_emails_job,
            trigger=CronTrigger(hour="10", minute="0", timezone=IST_TZ),
            id="feedback_emails_job",
            replace_existing=True,
            coalesce=True,
            max_instances=1,
        )

    except Exception:
        logger.exception("Failed to start APScheduler in lifespan")

    yield

    try:
        if scheduler.running:
            scheduler.shutdown(wait=False)
    except Exception:
        logger.exception("Failed to stop APScheduler in lifespan")

app = FastAPI(lifespan=lifespan)
app.include_router(vlookup_router)
app.include_router(razorpay_router)
app.include_router(cloudprinter_router)

app.include_router(cp_produce_router)
app.include_router(shiprocket_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="../public"), name="static")

# Country code mapping
COUNTRY_CODES = {
    "India": "IN",
    "United States": "US",
    "United Kingdom": "GB",
    # Add more countries as needed
}

IST = timezone(timedelta(hours=5, minutes=30))


def _to_naive_utc(x):
    if isinstance(x, datetime):
        # convert tz-aware -> naive UTC; leave others unchanged
        return x.astimezone(timezone.utc).replace(tzinfo=None) if x.tzinfo else x
    return x


@app.get("/health")
def health_check():
    return {"status": "ok"}


def split_full_name(full_name: str) -> tuple[str, str]:
    """Split a full name into first name and last name."""
    if not full_name:
        return ("", "")

    parts = full_name.strip().split()
    if len(parts) == 1:
        return (parts[0], "")
    return (" ".join(parts[:-1]), parts[-1])


def format_date(date_input: any) -> str:

    if not date_input:
        return ""
    try:
        # If it's a MongoDB date object (Python datetime)
        if isinstance(date_input, datetime):
            dt = date_input
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")

            return formatted
        # If it's a MongoDB extended JSON
        if isinstance(date_input, dict):
            if '$date' in date_input and '$numberLong' in date_input['$date']:
                timestamp = int(date_input['$date']['$numberLong']) / 1000
                dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
                formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")

                return formatted
            elif 'date' in date_input:
                timestamp = int(date_input['date']['$numberLong']) / \
                    1000 if '$numberLong' in date_input['date'] else int(
                        date_input['date']) / 1000
                dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
                formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")

                return formatted
        # If it's an ISO string
        elif isinstance(date_input, str):
            if date_input.strip() == "":
                return ""
            dt = datetime.fromisoformat(date_input.replace('Z', '+00:00'))
            formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")

            return formatted
        else:
            print(f"[DEBUG] Unknown date format")
            return ""
    except Exception as e:
        print(f"[DEBUG] Error formatting date: {e}")
        return ""


def format_processed_date(value):
    try:
        if not value:
            logger.warning("🟡 No date_value provided")
            return ""

        if isinstance(value, datetime):
            return value.strftime("%d-%m-%Y %H:%M")

        if isinstance(value, str):
            try:
                # Handle both with and without 'Z'
                if value.endswith("Z"):
                    dt = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
                else:
                    dt = datetime.fromisoformat(value)
                return dt.strftime("%d-%m-%Y %H:%M")
            except Exception as e:
                logger.warning(
                    f"⚠️ Could not parse string datetime: {value} | Error: {e}")
                return value  # Return original if parsing fails

        logger.warning(
            f"⚠️ Unknown type for processed_at: {type(value)} -> {value}")
        return str(value)

    except Exception as e:
        logger.error(f"🔥 Failed to format processed_at: {value} | Error: {e}")
        return ""


def _send_html_email(
    to_email: Union[str, List[str], None],
    subject: str,
    html_body: str
) -> None:
    email_user = (os.getenv("EMAIL_ADDRESS") or "").strip()
    email_pass = (os.getenv("EMAIL_PASSWORD") or "").strip()
    if not email_user or not email_pass:
        raise RuntimeError("EMAIL_ADDRESS/EMAIL_PASSWORD not configured")

    # Normalize recipients
    if to_email is None:
        recipients = EMAIL_TO[:]  # from env
    elif isinstance(to_email, list):
        recipients = [e.strip() for e in to_email if e and e.strip()]
    else:  # string
        recipients = [e.strip() for e in to_email.split(",") if e.strip()]

    if not recipients:
        raise RuntimeError(
            "No recipients found. Configure EMAIL_TO in .env or pass a recipient.")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Diffrun <{email_user}>"
    msg["To"] = ", ".join(recipients)
    msg.set_content("This message contains HTML.")
    msg.add_alternative(html_body, subtype="html")

    # Send to all recipients
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(email_user, email_pass)
        # send_message uses the headers for recipients; passing explicitly is extra safe:
        smtp.sendmail(email_user, recipients, msg.as_string())


def _now_ist():
    return datetime.now(IST_TZ)


def _ist_midnight(dt_ist: datetime) -> datetime:
    return dt_ist.replace(hour=0, minute=0, second=0, microsecond=0)


VLOOKUP_PATH = "/reconcile/vlookup-payment-to-orders/auto"
DETAILS_PATH = "/reconcile/na-payment-details"


def _hourly_reconcile_and_email():
    IST = ZoneInfo(os.getenv("RECONCILE_TZ", "Asia/Kolkata"))
    now_ist = datetime.now(IST)

    # Same window the UI uses: [yesterday 00:00 → today 23:59:59] IST
    y_date = now_ist.date() - timedelta(days=1)
    t_date = now_ist.date()
    from_date = y_date.strftime("%Y-%m-%d")
    to_date = t_date.strftime("%Y-%m-%d")

    logger.info(
        "[RECONCILE-HOURLY] Calling vlookup for IST window %s → %s", from_date, to_date)

    # 1) Pull summary + NA payment IDs via the same UI endpoint
    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(
                f"{API_BASE}{VLOOKUP_PATH}",
                params={
                    "from_date": from_date,
                    "to_date": to_date,
                    "na_status": "captured",
                    "max_fetch": 200000,
                },
            )
            logger.info("[RECONCILE-HOURLY] vlookup GET %s -> %s",
                        resp.request.url, resp.status_code)
            resp.raise_for_status()
            lookup_json = resp.json()
    except Exception as e:
        logger.exception("[RECONCILE-HOURLY] vlookup API failed: %s", e)
        return

    summary = lookup_json.get("summary", {}) or {}
    na_ids = lookup_json.get("na_payment_ids", []) or []
    na_count = int(summary.get("na_count", len(na_ids)))
    window = summary.get("date_window", {}) or {}
    wnd_from = window.get("from_date", from_date)
    wnd_to = window.get("to_date", to_date)

    # ✅ Only email if there are NA IDs
    if not na_ids:
        logger.info(
            "[RECONCILE-HOURLY] No NA payment IDs in window (%s → %s) — skipping email.", wnd_from, wnd_to)
        return

    logger.info("[RECONCILE-HOURLY] NA count: %d — preparing email.", na_count)

    # 2) Enrich those NA IDs just like the UI (email, created_at, amount, paid, preview_url, job_id, etc.)
    details_items = []
    try:
        with httpx.Client(timeout=60.0) as client:
            dresp = client.post(
                f"{API_BASE}{DETAILS_PATH}",
                json={"ids": na_ids},
                headers={"Content-Type": "application/json"},
            )
            logger.info("[RECONCILE-HOURLY] details POST %s -> %s",
                        dresp.request.url, dresp.status_code)
            dresp.raise_for_status()
            djson = dresp.json() or {}
            details_items = djson.get("items", []) or []
    except Exception as e:
        logger.exception("[RECONCILE-HOURLY] details API failed: %s", e)
        # We still send the email, but with just the IDs table if enrichment failed.

    # 3) Render a compact HTML table with the requested columns
    subject = f"[Reconcile] NA payments: {na_count} (IST {wnd_from} → {wnd_to})"
    html_body = _render_na_table(
        title="Razorpay NA Reconciliation",
        wnd_from=wnd_from,
        wnd_to=wnd_to,
        rows=details_items,
    )

    logger.info("[RECONCILE-HOURLY] Sending email: %s", subject)
    try:
        _send_html_email(EMAIL_TO, subject, html_body)
        logger.info("[RECONCILE-HOURLY] Email sent successfully")
    except Exception as e:
        logger.exception("[RECONCILE-HOURLY] Email send failed: %s", e)


def _render_na_table(title: str, wnd_from: str, wnd_to: str, rows: list[dict]) -> str:
    """Render an HTML table with: Payment ID, Email, Payment Date, Amount, Paid, Preview, Job ID."""
    def safe(v):  # basic escape
        return html.escape(str(v)) if v is not None else "—"

    header = f"""
    <h2 style="margin:0 0 8px 0;font-family:Arial,sans-serif">{safe(title)}</h2>
    <div style="font-family:Arial,sans-serif;font-size:13px;margin:0 0 12px 0">
      <strong>Window (IST):</strong> {safe(wnd_from)} → {safe(wnd_to)}
    </div>
    """

    if not rows:
        return header + '<p style="font-family:Arial,sans-serif">No NA payment details.</p>'

    # Build table rows
    tr_html = []
    for r in rows:
        pid = r.get("id") or r.get("payment_id") or "—"
        email = r.get("email") or "—"
        dt = r.get("created_at") or "—"
        amt = r.get("amount_display") or "—"
        paid = r.get("paid")
        paid_str = "true" if paid is True else (
            "false" if paid is False else "—")
        prev = r.get("preview_url") or ""
        job = r.get("job_id") or "—"

        prev_link = f'<a href="{html.escape(prev)}" target="_blank">preview</a>' if prev else "—"

        tr_html.append(f"""
          <tr>
            <td style="padding:6px 8px;border:1px solid #e5e7eb;font-family:Consolas,Menlo,monospace">{safe(pid)}</td>
            <td style="padding:6px 8px;border:1px solid #e5e7eb">{safe(email)}</td>
            <td style="padding:6px 8px;border:1px solid #e5e7eb">{safe(dt)}</td>
            <td style="padding:6px 8px;border:1px solid #e5e7eb">{safe(amt)}</td>
            <td style="padding:6px 8px;border:1px solid #e5e7eb">{safe(paid_str)}</td>
            <td style="padding:6px 8px;border:1px solid #e5e7eb">{prev_link}</td>
            <td style="padding:6px 8px;border:1px solid #e5e7eb;font-family:Consolas,Menlo,monospace">{safe(job)}</td>
          </tr>
        """)

    table = f"""
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px">
      <thead>
        <tr style="background:#f9fafb">
          <th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Payment ID</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Email</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Payment Date</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Amount</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Paid</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Preview</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Job ID</th>
        </tr>
      </thead>
      <tbody>
        {''.join(tr_html)}
      </tbody>
    </table>
    """

    return header + table


JOBS_CREATED_AT_FIELD = "created_at"
TZ_IST = ZoneInfo("Asia/Kolkata")
UTC = timezone.utc
RangeKey = Literal["1d", "1w", "1m", "6m", "this_month"]  # NEW value
PREVIEW_URL_FIELD = "preview_url"
PAID_FIELD = "paid"


def _now_ist() -> datetime:
    return datetime.now(tz=TZ_IST)


def _ist_midnight(dt_ist: datetime) -> datetime:
    return dt_ist.replace(hour=0, minute=0, second=0, microsecond=0)

# NEW: parse YYYY-MM-DD to IST-midnight


def _parse_ymd_ist(d: str) -> datetime:
    try:
        y, m, dd = map(int, d.split("-"))
        return datetime(y, m, dd, tzinfo=TZ_IST)
    except Exception:
        raise HTTPException(
            status_code=400, detail=f"Invalid date: {d}. Use YYYY-MM-DD")

# NEW: build periods for a custom day-window [start_ymd, end_ymd_inclusive]


def _periods_custom(start_date: str, end_date: str) -> Tuple[datetime, datetime, datetime, datetime, str]:
    start_ist = _ist_midnight(_parse_ymd_ist(start_date))
    # inclusive end_date → exclusive next midnight
    end_ist = _ist_midnight(_parse_ymd_ist(end_date)) + timedelta(days=1)
    if end_ist <= start_ist:
        raise HTTPException(
            status_code=400, detail="start_date must be before or equal to end_date")

    # previous window: immediately preceding the current window, same length
    span_days = (end_ist - start_ist).days
    prev_end_ist = start_ist
    prev_start_ist = prev_end_ist - timedelta(days=span_days)

    return (
        start_ist.astimezone(UTC),
        end_ist.astimezone(UTC),
        prev_start_ist.astimezone(UTC),
        prev_end_ist.astimezone(UTC),
        "day",
    )


def _periods(range_key: RangeKey, _now_utc_ignored: datetime) -> Tuple[datetime, datetime, datetime, datetime, str]:
    now_ist = _now_ist()

    if range_key == "1d":
        end_curr_ist = now_ist.replace(
            minute=0, second=0, microsecond=0) + timedelta(hours=1)
        start_curr_ist = end_curr_ist - timedelta(hours=24)
        end_prev_ist = end_curr_ist - timedelta(days=7)
        start_prev_ist = start_curr_ist - timedelta(days=7)
        gran = "hour"

    elif range_key == "this_month":
        # current: [1st of this month 00:00 IST, 1st of next month 00:00 IST)
        first_curr = _ist_midnight(now_ist).replace(day=1)
        # compute 1st of next month
        if first_curr.month == 12:
            first_next = first_curr.replace(year=first_curr.year + 1, month=1)
        else:
            first_next = first_curr.replace(month=first_curr.month + 1)
        start_curr_ist = first_curr
        end_curr_ist = first_next

        # previous: [1st of prev month 00:00 IST, 1st of this month 00:00 IST)
        if first_curr.month == 1:
            first_prev = first_curr.replace(year=first_curr.year - 1, month=12)
        else:
            first_prev = first_curr.replace(month=first_curr.month - 1)
        start_prev_ist = first_prev
        end_prev_ist = first_curr

        gran = "day"

    else:
        end_curr_ist = _ist_midnight(
            now_ist) + timedelta(days=1)  # next IST midnight
        span = {"1w": 7, "1m": 30, "6m": 182}.get(range_key)
        if not span:
            raise HTTPException(status_code=400, detail="invalid range")
        start_curr_ist = end_curr_ist - timedelta(days=span)
        end_prev_ist = start_curr_ist
        start_prev_ist = end_prev_ist - timedelta(days=span)
        gran = "day"

    return (
        start_curr_ist.astimezone(UTC),
        end_curr_ist.astimezone(UTC),
        start_prev_ist.astimezone(UTC),
        end_prev_ist.astimezone(UTC),
        gran,
    )


def _labels_for(range_key: RangeKey, start_utc: datetime, end_utc: datetime) -> List[str]:
    if range_key == "1d":
        labels = []
        cur = start_utc.astimezone(TZ_IST)
        for _ in range(24):
            labels.append(cur.strftime("%Y-%m-%d %H:00"))
            cur += timedelta(hours=1)
        return labels
    out = []
    cur = start_utc.astimezone(TZ_IST)
    end = end_utc.astimezone(TZ_IST)
    while cur < end:
        out.append(cur.strftime("%Y-%m-%d"))
        cur += timedelta(days=1)
    return out


def _fetch_counts(
    col: Collection,
    start_utc: datetime,
    end_utc: datetime,
    exclude_codes: List[str],
    granularity: str,
    loc_match: dict,                      # <-- NEW
) -> Dict[str, int]:
    discount_ne = [{"discount_code": {"$ne": code}} for code in exclude_codes]
    base_match = {
        "paid": True,
        "order_id": {"$regex": r"^#\d+$"},
        "processed_at": {"$exists": True, "$ne": None},
    }

    # merge AND conditions safely
    ands = []
    if discount_ne:
        ands.extend(discount_ne)
    if loc_match:
        ands.append(loc_match)
    if ands:
        base_match["$and"] = ands

    pipeline = [
        {"$match": base_match},
        {"$addFields": {"processed_dt": {"$toDate": "$processed_at"}}},
        {"$match": {"processed_dt": {"$gte": start_utc, "$lt": end_utc}}},
        {
            "$group": {
                "_id": {
                    "$dateToString": {
                        "format": "%Y-%m-%d %H:00" if granularity == "hour" else "%Y-%m-%d",
                        "date": "$processed_dt",
                        "timezone": "Asia/Kolkata",
                    }
                },
                "count": {"$sum": 1},
            }
        },
        {"$sort": {"_id": 1}},
    ]
    rows = list(col.aggregate(pipeline))
    return {r["_id"]: int(r["count"]) for r in rows}


def _align_prev_to_curr_by_index(curr_len: int, prev_series: List[int]) -> List[int]:
    """
    Make prev series the same length as current labels:
    - if prev shorter (e.g., 30 vs 31), pad with 0 at the end
    - if prev longer, truncate
    """
    if len(prev_series) == curr_len:
        return prev_series
    if len(prev_series) > curr_len:
        return prev_series[:curr_len]
    return prev_series + [0] * (curr_len - len(prev_series))

# --- Country / LOC filter helper --------------------------------------------


def _build_loc_match(loc: str) -> dict:
    """
    Business rule:
      - If loc == 'IN': include docs where locale/LOC is exactly 'IN' OR empty/missing/None.
      - Else: include only exact matches for the provided loc (case-insensitive safe).
    We support either field name: 'locale' or 'LOC'.
    """
    loc = (loc or "IN").upper()

    # Match either field name
    loc_eq = {"$or": [{"locale": loc}, {"LOC": loc}]}

    if loc == "IN":
        empty_or_missing = {
            "$or": [
                {"locale": {"$exists": False}},
                {"locale": None},
                {"locale": ""},
                {"LOC": {"$exists": False}},
                {"LOC": None},
                {"LOC": ""},
            ]
        }
        return {"$or": [loc_eq, empty_or_missing]}
    else:
        return loc_eq


@app.get("/stats/orders")
def stats_orders(
    range: RangeKey = Query(
        "1w", description="1d | 1w | 1m | 6m | this_month"),
    start_date: Optional[str] = Query(
        None, description="YYYY-MM-DD (only when using custom)"),
    end_date: Optional[str] = Query(
        None, description="YYYY-MM-DD (only when using custom)"),
    exclude_codes: List[str] = Query(["TEST", "LHMM", "COLLAB", "REJECTED"]),
    loc: str = Query(
        "IN", description="Country code; IN includes empty/missing"),
):
    now_utc = datetime.now(tz=UTC)
    if start_date and end_date:
        curr_start_utc, curr_end_utc, prev_start_utc, prev_end_utc, gran = _periods_custom(
            start_date, end_date)
    else:
        curr_start_utc, curr_end_utc, prev_start_utc, prev_end_utc, gran = _periods(
            range, now_utc)

    labels = _labels_for("1d" if gran == "hour" else range,
                         curr_start_utc, curr_end_utc)
    prev_labels = _labels_for(
        "1d" if gran == "hour" else range, prev_start_utc, prev_end_utc)

    loc_match = _build_loc_match(loc)

    curr_map = _fetch_counts(
        orders_collection, curr_start_utc, curr_end_utc, exclude_codes, gran, loc_match)
    prev_map = _fetch_counts(
        orders_collection, prev_start_utc, prev_end_utc, exclude_codes, gran, loc_match)

    current = [int(curr_map.get(k, 0)) for k in labels]
    previous = [int(prev_map.get(k, 0)) for k in prev_labels]

    return {
        "labels": labels,
        "current": current,
        "previous": previous,
        "exclusions": exclude_codes,
        "granularity": gran,
    }


def _fetch_jobs_created_with_preview_per_bucket(
    col: Collection,
    start_utc: datetime,
    end_utc: datetime,
    granularity: str,
    loc_match: dict,                      # <-- NEW
) -> Dict[str, int]:
    base_match = {
        PREVIEW_URL_FIELD: {"$exists": True, "$nin": [None, ""]},
        JOBS_CREATED_AT_FIELD: {"$exists": True, "$ne": None},
    }
    if loc_match:
        base_match = {"$and": [base_match, loc_match]}

    pipeline = [
        {"$match": base_match},
        {"$addFields": {
            "_dt": {
                "$cond": [
                    {"$eq": [{"$type": f"${JOBS_CREATED_AT_FIELD}"}, "date"]},
                    f"${JOBS_CREATED_AT_FIELD}",
                    {"$toDate": f"${JOBS_CREATED_AT_FIELD}"},
                ]
            }
        }},
        {"$match": {"_dt": {"$gte": start_utc, "$lt": end_utc}}},
        {"$group": {
            "_id": {
                "$dateToString": {
                    "format": "%Y-%m-%d %H:00" if granularity == "hour" else "%Y-%m-%d",
                    "date": "$_dt",
                    "timezone": "Asia/Kolkata",
                }
            },
            "count": {"$sum": 1},
        }},
        {"$sort": {"_id": 1}},
    ]
    return {r["_id"]: int(r["count"]) for r in col.aggregate(pipeline)}


def _fetch_paid_orders_per_bucket(
    col: Collection,
    start_utc: datetime,
    end_utc: datetime,
    granularity: str,
    loc_match: dict,                      # <-- NEW
) -> Dict[str, int]:
    base_match = {
        PAID_FIELD: True,
        "$or": [
            {"processed_at": {"$exists": True, "$ne": None}},
            {"created_at": {"$exists": True, "$ne": None}},
        ],
    }
    if loc_match:
        base_match = {"$and": [base_match, loc_match]}

    pipeline = [
        {"$match": base_match},
        {"$addFields": {
            "_dt": {"$toDate": {"$ifNull": ["$processed_at", "$created_at"]}}}},
        {"$match": {"_dt": {"$gte": start_utc, "$lt": end_utc}}},
        {"$group": {
            "_id": {
                "$dateToString": {
                    "format": "%Y-%m-%d %H:00" if granularity == "hour" else "%Y-%m-%d",
                    "date": "$_dt",
                    "timezone": "Asia/Kolkata",
                }
            },
            "count": {"$sum": 1},
        }},
        {"$sort": {"_id": 1}},
    ]
    return {r["_id"]: int(r["count"]) for r in col.aggregate(pipeline)}


@app.get("/stats/preview-vs-orders", tags=["stats"])
def stats_preview_vs_orders(
    range: RangeKey = Query("1w"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    loc: str = Query(
        "IN", description="Country code; IN includes empty/missing"),
):
    now_utc = datetime.now(tz=UTC)
    if start_date and end_date:
        cs, ce, ps, pe, gran = _periods_custom(start_date, end_date)
    else:
        cs, ce, ps, pe, gran = _periods(range, now_utc)

    labels = _labels_for("1d" if gran == "hour" else range, cs, ce)
    prev_labels = _labels_for("1d" if gran == "hour" else range, ps, pe)

    loc_match = _build_loc_match(loc)

    jobs_map_curr = _fetch_jobs_created_with_preview_per_bucket(
        orders_collection, cs, ce, granularity=gran, loc_match=loc_match)
    paid_map_curr = _fetch_paid_orders_per_bucket(
        orders_collection, cs, ce, granularity=gran, loc_match=loc_match)
    jobs_map_prev = _fetch_jobs_created_with_preview_per_bucket(
        orders_collection, ps, pe, granularity=gran, loc_match=loc_match)
    paid_map_prev = _fetch_paid_orders_per_bucket(
        orders_collection, ps, pe, granularity=gran, loc_match=loc_match)

    current_jobs = [int(jobs_map_curr.get(k, 0)) for k in labels]
    current_orders = [int(paid_map_curr.get(k, 0)) for k in labels]
    previous_jobs = [int(jobs_map_prev.get(k, 0)) for k in prev_labels]
    previous_orders = [int(paid_map_prev.get(k, 0)) for k in prev_labels]

    conversion_current = [(o * 100 / j) if j > 0 else 0 for o,
                          j in zip(current_orders, current_jobs)]
    conversion_previous = [(o * 100 / j) if j > 0 else 0 for o,
                           j in zip(previous_orders, previous_jobs)]

    return {
        "labels": labels,
        "current_jobs": current_jobs,
        "previous_jobs": previous_jobs,
        "current_orders": current_orders,
        "previous_orders": previous_orders,
        "conversion_current": conversion_current,
        "conversion_previous": conversion_previous,
        "granularity": gran,
    }


def _fetch_revenue_per_bucket(
    col: Collection,
    start_utc: datetime,
    end_utc: datetime,
    granularity: str,
    loc_match: dict,
) -> Dict[str, float]:
    base_match = {PAID_FIELD: True}
    if loc_match:
        base_match = {"$and": [base_match, loc_match]}

    value_expr = {
        "$toDouble": {
            "$ifNull": [
                "$total_amount",
                {"$ifNull": [
                    "$total_price",
                    {"$ifNull": [
                        "$amount",
                        {"$ifNull": ["$price", 0]}
                    ]}
                ]}
            ]
        }
    }

    pipeline = [
        {"$match": base_match},
        {"$addFields": {
            "_dt": {"$toDate": {"$ifNull": ["$processed_at", "$created_at"]}}}},
        {"$match": {"_dt": {"$gte": start_utc, "$lt": end_utc}}},
        {"$group": {
            "_id": {
                "$dateToString": {
                    "format": "%Y-%m-%d %H:00" if granularity == "hour" else "%Y-%m-%d",
                    "date": "$_dt",
                    "timezone": "Asia/Kolkata",
                }
            },
            "revenue": {"$sum": value_expr},
        }},
        {"$sort": {"_id": 1}},
    ]
    rows = list(col.aggregate(pipeline))
    return {r["_id"]: float(r["revenue"]) for r in rows}


@app.get("/stats/revenue", tags=["stats"])
def stats_revenue(
    range: RangeKey = Query("1w"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    loc: str = Query(
        "IN", description="Country code; IN includes empty/missing"),
):
    now_utc = datetime.now(tz=UTC)
    if start_date and end_date:
        cs, ce, ps, pe, gran = _periods_custom(start_date, end_date)
    else:
        cs, ce, ps, pe, gran = _periods(range, now_utc)

    labels = _labels_for("1d" if gran == "hour" else range, cs, ce)
    prev_labels = _labels_for("1d" if gran == "hour" else range, ps, pe)

    loc_match = _build_loc_match(loc)

    rev_curr = _fetch_revenue_per_bucket(
        orders_collection, cs, ce, gran, loc_match)
    rev_prev = _fetch_revenue_per_bucket(
        orders_collection, ps, pe, gran, loc_match)

    current = [float(rev_curr.get(k, 0.0)) for k in labels]
    previous = [float(rev_prev.get(k, 0.0)) for k in prev_labels]

    return {
        "labels": labels,
        "current": current,
        "previous": previous,
        "granularity": gran,
        "currency_hint": "mixed",  # you can switch to currency-specific buckets later if needed
    }


@app.get("/orders/hash-ids")
def list_hash_ids(
    exclude_codes: List[str] = Query(["TEST", "LHMM", "COLLAB"]),
    days: int = Query(14, ge=1, le=90),
):
    end_ist = _ist_midnight(_now_ist()) + timedelta(days=1)
    start_ist = end_ist - timedelta(days=days)
    start_utc = start_ist.astimezone(timezone.utc)
    end_utc = end_ist.astimezone(timezone.utc)

    discount_ne = [{"discount_code": {"$ne": code}} for code in exclude_codes]
    query = {
        "paid": True,
        "order_id": {"$regex": r"^#\d+$"},
        "processed_at": {"$exists": True, "$ne": None},
        "$and": discount_ne if discount_ne else []
    }

    projection = {"_id": 0, "order_id": 1,
                  "processed_at": 1, "discount_code": 1}
    cur = orders_collection.find(query, projection)

    # Filter by processed_at window
    items = []
    for doc in cur:
        try:
            dt = doc.get("processed_at")
            if isinstance(dt, str):
                dt = parser.isoparse(dt)
            if dt and dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt and (start_utc <= dt < end_utc):
                items.append({
                    "order_id": doc["order_id"],
                    "processed_at": dt.astimezone(IST_TZ).strftime("%Y-%m-%d %H:%M:%S"),
                })
        except Exception:
            continue

    # Sort by time desc
    items.sort(key=lambda x: x["processed_at"], reverse=True)
    return {"count": len(items), "items": items}


MONGO_URI = os.getenv("MONGO_URI")
client = MongoClient(MONGO_URI, tz_aware=True)
db = client["candyman"]
orders_collection = db["user_details"]

s3 = boto3.client('s3',
                  aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
                  aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
                  region_name=os.getenv("AWS_REGION"))

BUCKET_NAME = "replicacomfy"


class CloudprinterWebhookBase(BaseModel):
    apikey: str
    type: str
    order: Optional[str] = None
    item: Optional[str] = None
    order_reference: str
    item_reference: Optional[str] = None
    datetime: str


class ItemProducedPayload(CloudprinterWebhookBase):
    pass


class ItemErrorPayload(CloudprinterWebhookBase):
    error_code: str
    error_message: str


class ItemValidatedPayload(CloudprinterWebhookBase):
    pass


class ItemCanceledPayload(CloudprinterWebhookBase):
    pass


class CloudprinterOrderCanceledPayload(CloudprinterWebhookBase):
    pass


class ItemDeletePayload(CloudprinterWebhookBase):
    pass


class ItemShippedPayload(CloudprinterWebhookBase):
    tracking: str
    shipping_option: str


class UnapproveRequest(BaseModel):
    job_ids: List[str]


def generate_book_title(book_id, child_name):
    if not child_name:
        child_name = "Your child"
    else:
        child_name = child_name.strip().capitalize()

    book_id = (book_id or "").lower()

    if book_id == "wigu":
        return f"When {child_name} grows up"
    elif book_id == "astro":
        return f"{child_name}'s Space Adventure"
    elif book_id == "abcd":
        return f"{child_name} meets ABC"
    elif book_id == "dream":
        return f"Many Dreams of {child_name}"
    else:
        return f"{child_name}'s Storybook"


@app.get("/orders")
def get_orders(
    sort_by: Optional[str] = Query(None, description="Field to sort by"),
    sort_dir: Optional[str] = Query("asc", description="asc or desc"),
    filter_status: Optional[str] = Query(None),
    filter_book_style: Optional[str] = Query(None),
    filter_print_approval: Optional[str] = Query(None),
    filter_discount_code: Optional[str] = Query(None),
    exclude_discount_code: Optional[List[str]] = Query(None),
    q: Optional[str] = Query(
        None, description="Search by job_id, order_id, email, name, discount_code, city, locale, book_id"),
):
    # Base query    
    query = {"paid": True}
    ex_values: List[str] = []

    # --- Filters (same as before) ---
    if filter_status == "approved":
        query["approved"] = True
    elif filter_status == "uploaded":
        query["approved"] = False

    if filter_book_style:
        query["book_style"] = filter_book_style

    if filter_print_approval == "yes":
        query["print_approval"] = True
    elif filter_print_approval == "no":
        query["print_approval"] = False
    elif filter_print_approval == "not_found":
        query["print_approval"] = {"$exists": False}

    if filter_discount_code:
        print(f"[DEBUG] Filter discount code: {filter_discount_code}")
        if filter_discount_code.lower() == "none":
            query["discount_amount"] = 0
            query["paid"] = True
        else:
            query["discount_code"] = filter_discount_code.upper()

    # Exclude discount codes
    if exclude_discount_code:
        if isinstance(exclude_discount_code, list):
            ex_values = exclude_discount_code
        else:
            ex_values = [p.strip()
                         for p in str(exclude_discount_code).split(",")]

    ex_values = [v for v in (s.strip() for s in ex_values) if v]
    if ex_values:
        regexes = [re.compile(rf"^{re.escape(v)}$", re.IGNORECASE)
                   for v in ex_values]
        existing = query.pop("discount_code", None)
        exclude_cond = {"discount_code": {"$nin": regexes}}
        if existing is None:
            query["discount_code"] = exclude_cond["discount_code"]
        else:
            query["$and"] = [{"discount_code": existing}, exclude_cond]

    # --- Extended free-text search ---
    if q:
        term = q.strip()
        if term:
            rx = re.compile(re.escape(term), re.IGNORECASE)
            query.setdefault("$and", []).append({
                "$or": [
                    {"order_id": {"$regex": rx}},
                    {"job_id": {"$regex": rx}},
                    {"email": {"$regex": rx}},
                    {"name": {"$regex": rx}},
                    {"discount_code": {"$regex": rx}},
                    {"book_id": {"$regex": rx}},
                    {"locale": {"$regex": rx}},
                    {"shipping_address.city": {"$regex": rx}},
                ]
            })

    # Sorting
    sort_field = sort_by if sort_by else "created_at"
    sort_order = 1 if sort_dir == "asc" else -1

    # Projection
    projection = {
        "order_id": 1,
        "job_id": 1,
        "cover_url": 1,
        "book_url": 1,
        "preview_url": 1,
        "name": 1,
        "shipping_address": 1,
        "created_at": 1,
        "processed_at": 1,
        "approved_at": 1,
        "approved": 1,
        "book_id": 1,
        "book_style": 1,
        "print_status": 1,
        "price": 1,
        "total_price": 1,
        "amount": 1,
        "total_amount": 1,
        "feedback_email": 1,
        "print_approval": 1,
        "discount_code": 1,
        "currency": 1,
        "locale": 1,
        "quantity": 1,
        "_id": 0,
        "shipped_at": 1,
        "cust_status": 1,
        "printer": 1,
    }

    records = list(orders_collection.find(
        query, projection).sort(sort_field, sort_order))
    result = []

    for doc in records:
        result.append({
            "order_id": doc.get("order_id", ""),
            "job_id": doc.get("job_id", ""),
            "coverPdf": doc.get("cover_url", ""),
            "interiorPdf": doc.get("book_url", ""),
            "previewUrl": doc.get("preview_url", ""),
            "name": doc.get("name", ""),
            "city": doc.get("shipping_address", {}).get("city", ""),
            "price": doc.get("price", doc.get("total_price", doc.get("amount", doc.get("total_amount", 0)))),
            "paymentDate": doc.get("processed_at", ""),
            "approvalDate": doc.get("approved_at", ""),
            "status": "Approved" if doc.get("approved") else "Uploaded",
            "bookId": doc.get("book_id", ""),
            "bookStyle": doc.get("book_style", ""),
            "printStatus": doc.get("print_status", ""),
            "feedback_email": doc.get("feedback_email", False),
            "print_approval": doc.get("print_approval", None),
            "discount_code": doc.get("discount_code", ""),
            "currency": doc.get("currency", ""),
            "locale": doc.get("locale", ""),
            "shippedAt": doc.get("shipped_at"),
            "quantity": doc.get("quantity", 1),
            "cust_status": doc.get("cust_status", ""),
            "printer": doc.get("printer", ""),
        })

    return result


@app.post("/orders/set-cust-status/{order_id}")
async def set_cust_status(
    order_id: str,
    status: Literal["red", "green"] = Body(..., embed=True),
    create_if_missing: bool = Query(
        False, description="Use ?create_if_missing=true to upsert for testing")
):
    # Add index on order_id in Mongo for performance (recommended)
    # orders_collection.create_index("order_id")

    result = orders_collection.update_one(
        {"order_id": order_id},
        {"$set": {"cust_status": status}},
        upsert=create_if_missing
    )

    if result.matched_count == 0 and not create_if_missing:
        raise HTTPException(status_code=404, detail="Order not found")

    return {
        "order_id": order_id,
        "cust_status": status,
        "matched_count": result.matched_count,
        "modified_count": result.modified_count,
        "upserted_id": str(result.upserted_id) if result.upserted_id else None,
    }


def format_booking_date(processed_at):

    try:
        if isinstance(processed_at, datetime):
            dt = processed_at
        elif isinstance(processed_at, dict):
            # If it's Mongo extended JSON format
            timestamp = int(processed_at['$date']['$numberLong']) / 1000
            dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        elif isinstance(processed_at, str):
            dt = datetime.fromisoformat(processed_at.replace('Z', '+00:00'))
        else:
            return "N/A"
        return dt.strftime("%d %b %Y %I:%M %p")
    except Exception as e:
        print(f"Error formatting processed_at: {e}")
        return "N/A"


def get_pdf_page_count(pdf_url: str) -> int:
    try:
        # Download the PDF
        response = requests.get(pdf_url)
        if response.status_code != 200:
            return 35

        # Read the PDF content
        pdf_content = io.BytesIO(response.content)
        pdf_reader = PyPDF2.PdfReader(pdf_content)

        # Get the page count
        return len(pdf_reader.pages)
    except Exception as e:
        print(f"Error counting PDF pages: {str(e)}")
        return 35  # Fallback to default value


def get_product_details(book_style: str | None, book_id: str | None) -> tuple[str, str]:
    style = (book_style or "").lower()
    bid = (book_id or "").lower()

    if bid == "wigu":
        if style == "paperback":
            return ("Paperback", "photobook_pb_270x200_mm_l_fc")
        if style == "hardcover":
            return ("Hardcover", "photobook_cw_270x200_mm_l_fc")
        # Fallback for WIGU
        return ("Hardcover", "photobook_cw_270x200_mm_l_fc")

    # Default (non-WIGU): square s210 products
    if style == "paperback":
        return ("Paperback", "photobook_pb_s210_s_fc")
    if style == "hardcover":
        return ("Hardcover", "photobook_cw_s210_s_fc")

    # Fallback to Hardcover for unknown styles
    return ("Hardcover", "photobook_cw_s210_s_fc")


def get_shipping_level(country_code: str) -> str:
    if country_code == "IN":
        return "cp_saver"
    elif country_code in {"US", "GB"}:
        return "cp_ground"
    return "cp_ground"  # default fallback


def _send_production_email(
    to_email: str,
    display_name: str,
    child_name: str,
    job_id: str | None,
    order_id: str | None,
):
    if not to_email:
        print("[MAIL] skipped: empty recipient for production email")
        return

    display = (display_name or "there").strip().title() or "there"
    child = (child_name or "Your").strip().title() or "Your"
    track_href = f"https://diffrun.com/track-your-order?job_id={job_id}"
    safe_order = order_id or "—"
    subject = f"Order {safe_order}: {child}'s storybook is now in production 🎉"

    html_template = """<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <style>
    body { margin:0; padding:20px; background:#f7f7f7; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    .container { width:100%; max-width:768px; margin:0 auto; background:#ffffff; border-radius:8px; box-shadow:0 0 10px rgba(0,0,0,0.08); overflow:hidden; }
    .inner { padding:24px; font-family:Arial, Helvetica, sans-serif; color:#111; }
    p { margin:0 0 14px 0; font-size:16px; line-height:1.5; }
    .row { width:100%; }
    .col { vertical-align:top; }
    .col-text { padding:20px; }
    .col-img { padding:0 20px 0 0; }
    img { border:0; outline:none; text-decoration:none; display:block; height:auto; }
    .badge { display:inline-block; padding:0; margin:0; }

    @keyframes shine-sweep {
      0%   { transform: translateX(-100%) rotate(45deg); }
      50%  { transform: translateX(100%)  rotate(45deg); }
      100% { transform: translateX(100%)  rotate(45deg); }
    }

    .cta {
      position: relative;
      overflow: hidden;
      border-radius:9999px; text-align:center; mso-line-height-rule:exactly;
      font-family:Arial, Helvetica, sans-serif; font-weight:bold; text-decoration:none; display:block;
      color:#ffffff !important; background:#5784ba;
    }
    .cta::before {
      content: "";
      position: absolute;
      top: 0;
      left: -50%;
      height: 100%;
      width: 200%;
      background: linear-gradient(120deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%);
      animation: shine-sweep 4s infinite;
    }

    .cta-wrap { width:auto; }
    .cta-text { font-size:15px; line-height:1.2; padding:12px 24px; display:block; color:#ffffff !important; text-decoration:none; }
    .cta-secondary { background:#5784ba; } /* static secondary */

    .banner { background:#f7f6cf; border-radius:8px; }
    .banner p { font-size:15px; }
    .center { text-align:center; }

    @media only screen and (max-width:480px) {
      .inner { padding:16px !important; }
      p { font-size:15px !important; }
      .stack { display:block !important; width:100% !important; }
      .col-text { padding:0px !important; text-align:center !important; }
      .col-img { padding:16px 0 0 0 !important; text-align:center !important; }
      .cta-wrap { width:100% !important; }
      .cta-text { font-size:13px !important; padding:10px 14px !important; }
      .center-sm { text-align:center !important; }
      .banner { padding:12px !important; }
      .mt-sm { margin-top:12px !important; }
      .banner .row { display:block !important; width:100% !important; }
      .banner .col { display:block !important; width:100% !important; }
      .banner img { margin:0 auto !important; }
    }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="container">
          <tr>
            <td class="inner">
              <p>Hey {display},</p>
              <p><strong>{child}'s storybook</strong> has been moved to production at our print factory. 🎉</p>
              <p>It will be shipped within the next 3–4 business days. We will notify you with the tracking ID once your order is shipped.</p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="cta-wrap" style="margin:8px 0 18px 0;">
                <tr>
                  <td>
                    <a href="{track_href}" class="cta">
                      <span class="cta-text">Track your order</span>
                    </a>
                  </td>
                </tr>
              </table>

              <p>Thanks,<br>Team Diffrun</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="banner" style="margin-top:24px;">
                <tr>
                  <td>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="row">
                      <tr>
                        <td class="col col-text stack" width="60%">
                          <p>Explore more magical books in our growing collection</p>

                          <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="cta-wrap mt-sm" style="margin-top:16px;">
                            <tr>
                              <td>
                                <a href="https://diffrun.com" class="cta cta-secondary">
                                  <span class="cta-text">Browse Now</span>
                                </a>
                              </td>
                            </tr>
                          </table>
                        </td>

                        <td class="col col-img stack" width="40%" align="right">
                          <img src="https://diffrungenerations.s3.ap-south-1.amazonaws.com/email_image+(2).jpg"
                               alt="Storybook Preview" width="300" style="max-width:100%;">
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""

    html = (html_template
            .replace("{display}", display)
            .replace("{child}", child)
            .replace("{track_href}", track_href))

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Diffrun <{EMAIL_USER}>"
    msg["To"] = to_email
    msg.set_content(
        f"Hey {display},\n\n"
        f"{child}'s storybook has been moved to production. "
        f"Track here: {track_href}\n\n"
        "Thanks,\nTeam Diffrun"
    )
    msg.add_alternative(html, subtype="html")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)


@app.post("/orders/approve-printing")
async def approve_printing(order_ids: List[str], background_tasks: BackgroundTasks):
    CLOUDPRINTER_API_KEY = os.getenv(
        "CLOUDPRINTER_API_KEY", "1414e4bd0220dc1e518e268937ff18a3")
    CLOUDPRINTER_API_URL = "https://api.cloudprinter.com/cloudcore/1.0/orders/add"

    results = []
    for order_id in order_ids:
        print(f"Processing order ID: {order_id}")
        # Fetch order details from MongoDB
        order = orders_collection.find_one({"order_id": order_id})
        if not order:
            print(f"Order not found in database: {order_id}")
            results.append({
                "order_id": order_id,
                "status": "error",
                "message": "Order not found",
                "step": "database_lookup"
            })
            continue

        print(f"Found order in database: {order_id}")
        print(f"Calculating MD5 sums for PDFs...")

        try:
            # Calculate MD5 sums for the PDFs
            book_url = order.get("book_url", "")
            cover_url = order.get("cover_url", "")
            quantity = order.get("quantity")

            print(f"Downloading and calculating MD5 for cover PDF...")
            cover_md5 = hashlib.md5(requests.get(
                cover_url).content).hexdigest() if cover_url else None
            print(f"Cover PDF MD5: {cover_md5}")

            print(f"Downloading and calculating MD5 for interior PDF...")
            interior_md5 = hashlib.md5(requests.get(
                book_url).content).hexdigest() if book_url else None
            print(f"Interior PDF MD5: {interior_md5}")

            # Get the page count from the interior PDF
            print(f"Calculating page count for interior PDF...")
            total_pages = get_pdf_page_count(book_url) if book_url else 35
            print(f"Total pages: {total_pages}")

            # Split shipping name into first and last name
            shipping_name = order.get("shipping_address", {}).get("name", "")
            firstname, lastname = split_full_name(shipping_name)
            print(f"Split shipping name: {firstname} {lastname}")

            # Get country code
            country = order.get("shipping_address", {}).get("country", "")
            country_code = COUNTRY_CODES.get(country, country)
            print(f"Mapped country {country} to code {country_code}")

            # Get product details based on book style
            book_style = order.get("book_style", "hardcover")
            book_id = order.get("book_id", "")
            reference, product_code = get_product_details(book_style, book_id)
            print(f"Selected product: {reference} ({product_code})")

            shipping_level = get_shipping_level(country_code)
            print(
                f"Selected shipping level: {shipping_level} for {country_code}")

            # Prepare the request payload
            print(f"Preparing CloudPrinter payload for order {order_id}...")
            payload = {
                "apikey": CLOUDPRINTER_API_KEY,
                "reference": order.get("order_id", ""),
                "email": "support@diffrun.com",
                "addresses": [{
                    "type": "delivery",
                    "firstname": firstname,
                    "lastname": lastname,
                    "street1": order.get("shipping_address", {}).get("address1", ""),
                    "street2": order.get("shipping_address", {}).get("address2", ""),
                    "zip": order.get("shipping_address", {}).get("zip", ""),
                    "city": order.get("shipping_address", {}).get("city", ""),
                    "state": order.get("shipping_address", {}).get("province", ""),
                    "country": country_code,
                    "email": order.get("email", ""),
                    "phone": order.get("shipping_address", {}).get("phone", "") if country_code == "IN" else order.get("phone_number", "")
                }],
                "items": [{
                    "reference": reference,
                    "product": product_code,
                    "shipping_level": shipping_level,
                    "title": f"{order.get('order_id', '')}_{order.get('name', 'Book')}",
                    "count": quantity,
                    "files": [
                        {
                            "type": "cover",
                            "url": cover_url,
                            "md5sum": cover_md5
                        },
                        {
                            "type": "book",
                            "url": book_url,
                            "md5sum": interior_md5
                        }
                    ],
                    "options": [
                        {
                            "type": "total_pages",
                            "count": str(total_pages)
                        }
                    ]
                }]
            }

            print(f"Sending request to CloudPrinter for order {order_id}...")

            response = requests.post(
                CLOUDPRINTER_API_URL,
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            response_data = response.json()

            print(
                f"CloudPrinter API Response (Status {response.status_code}): {response_data}")

            if response.status_code in [200, 201]:
                print(f"Updating order status in database for {order_id}...")
                # mark that Cloudprinter was used and save reference + timestamp
                orders_collection.update_one(
                    {"order_id": order_id},
                    {
                        "$set": {
                            "print_status": "sent_to_printer",
                            "printer": "Cloudprinter",                                   # NEW
                            "cloudprinter_reference": response_data.get("reference", ""),
                            "print_sent_at": datetime.now().isoformat()
                        }
                    }
                )

                # send the production email ONCE, idempotent
                once = orders_collection.update_one(
                    {"order_id": order_id, "$or": [
                        {"production_email_sent": {"$exists": False}},
                        {"production_email_sent": False}
                    ]},
                    {"$set": {"production_email_sent": True}}
                )

                if once.modified_count == 1:
                    to_email = (order.get("customer_email")
                                or order.get("email") or "").strip()
                    display_name = order.get("user_name") or "there"
                    child_name = order.get("name") or "Your"
                    job_id = order.get("job_id")

                    if to_email and EMAIL_USER and EMAIL_PASS:
                        background_tasks.add_task(
                            _send_production_email,
                            to_email,
                            display_name,
                            child_name,
                            job_id,
                            order_id
                        )
                        print(
                            f"[EMAIL] queued production email to {to_email} for {order_id}")
                    else:
                        print(
                            f"[EMAIL] skipped (missing recipient or creds) for {order_id}")
                else:
                    print(f"[EMAIL] already sent for {order_id}, skipping")

                results.append({
                    "order_id": order_id,
                    "status": "success",
                    "message": "Successfully sent to printer",
                    "step": "completed",
                    "cloudprinter_reference": response_data.get("reference", "")
                })
                print(f"Successfully processed order {order_id}")
            else:
                error_msg = response_data.get(
                    "message", "Failed to send to printer")
                print(
                    f"Failed to send order {order_id} to printer: {error_msg}")
                results.append({
                    "order_id": order_id,
                    "status": "error",
                    "message": error_msg,
                    "step": "cloudprinter_api"
                })

        except Exception as e:
            error_msg = str(e)
            print(f"Error processing order {order_id}: {error_msg}")
            results.append({
                "order_id": order_id,
                "status": "error",
                "message": error_msg,
                "step": "processing"
            })

    return results

SPREADSHEET_ID = os.getenv("GOOGLE_SHEET_ID")
WORKSHEET_NAME = os.getenv("GOOGLE_SHEET_WORKSHEET", "Order Placement")
VALUE_INPUT_OPTION = os.getenv("GOOGLE_VALUE_INPUT_OPTION", "USER_ENTERED")
SERVICE_ACCOUNT_FILE = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE")
SERVICE_ACCOUNT_JSON = os.getenv(
    "GOOGLE_SERVICE_ACCOUNT_JSON")  # optional fallback
_SCOPES = ["https://www.googleapis.com/auth/spreadsheets",
           "https://www.googleapis.com/auth/drive.file"]


def get_gspread_client():
    """
    Return authenticated gspread client. Preference:
      1) SERVICE_ACCOUNT_FILE path
      2) SERVICE_ACCOUNT_JSON content (full JSON string)
    """

    creds = None
    if SERVICE_ACCOUNT_FILE and os.path.exists(SERVICE_ACCOUNT_FILE):
        creds = _GoogleCredentials.from_service_account_file(
            SERVICE_ACCOUNT_FILE, scopes=_SCOPES)
    elif SERVICE_ACCOUNT_JSON:
        info = json.loads(SERVICE_ACCOUNT_JSON)
        creds = _GoogleCredentials.from_service_account_info(
            info, scopes=_SCOPES)
    else:
        raise RuntimeError(
            "Google service account credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON")

    return gspread.authorize(creds)


def _to_safe_value(v):
    """Convert values that are not JSON-serializable to safe string representations."""
    if v is None:
        return ""
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (datetime, date)):
        # choose format you prefer; ISO is safe and sortable
        return v.isoformat()
    if isinstance(v, ObjectId):
        return str(v)
    # fallback: cast to string
    return str(v)


def order_to_sheet_row(order: dict) -> list:
    """
    Build a sheet row that leaves column A empty and safely converts datetimes.
    Column mapping (B -> K) as requested in your screenshot.
    """
    diffrun_order_id = _to_safe_value(order.get("order_id", ""))

    # choose the created/ordered time field from your schema
    # current IST time for Google-Sheets entry (safe and independent)
    IST_1 = ZoneInfo("Asia/Kolkata")
    now_ist = datetime.now(IST_1)
    order_date = now_ist.strftime("%d %b, %H:%M")

    child_name = _to_safe_value(order.get("name") or "")
    book_style = _to_safe_value(order.get("book_style") or "")
    book_id = _to_safe_value(order.get("book_id") or "")

    shipping = order.get("shipping_address") or {}
    city = _to_safe_value(shipping.get("city") or "")

    address_parts = [
        shipping.get("name") or "",
        shipping.get("address1") or "",
        shipping.get("address2") or "",
        shipping.get("city") or "",
        shipping.get("province") or "",
        shipping.get("country") or "",
        shipping.get("zip") or ""
    ]
    # join non-empty parts with comma (or use "\n" for line breaks)
    address = "\n".join([p for p in address_parts if p])
    address = _to_safe_value(address)

    phone = _to_safe_value(shipping.get("phone") or order.get(
        "phone_number") or order.get("customer_phone") or "")
    
    quantity = int(order.get("quantity", 1) or 1)

    cover_url = order.get("cover_url") or order.get("coverpage_url") or ""
    interior_url = order.get("book_url") or order.get("interior_pdf") or ""

    cover_link_formula = f'=HYPERLINK("{_to_safe_value(cover_url)}","View")' if cover_url else ""
    interior_link_formula = f'=HYPERLINK("{_to_safe_value(interior_url)}","View PDF")' if interior_url else ""

    logged_at = _to_safe_value(datetime.utcnow())

    row = [
        "",                        # A: intentionally blank
        diffrun_order_id,          # B
        order_date,                # C
        child_name,                # D
        book_style,                # E
        book_id,                   # F
        city,                      # G
        address,                   # H
        phone,                     # I
        cover_link_formula,        # J
        interior_link_formula,      # K
        quantity,            # L        
    ]

    # ensure every element is a primitive (str/int/float/bool)
    row = [_to_safe_value(x) for x in row]
    return row

def _ensure_quantity_header(worksheet):
    """Ensure the header 'Quantity' exists in column L (index 12)."""
    try:
        header = worksheet.row_values(1)
        if len(header) < 12 or header[11].strip() == "":
            worksheet.update_cell(1, 12, "Quantity")
            print("[SHEETS] Added missing 'Quantity' header in column L")
    except Exception as e:
        print(f"[SHEETS][WARN] Could not verify Quantity header: {e}")

from datetime import datetime, timezone

def _extract_url_from_formula(formula: str) -> str:
    """
    Extract the URL from a Google Sheets HYPERLINK formula.
    Example:
      '=HYPERLINK("https://abc.com/file.pdf","View")' -> 'https://abc.com/file.pdf'
    If not a formula, returns the original string.
    """
    if not isinstance(formula, str):
        return formula
    match = re.search(r'HYPERLINK\("([^"]+)"', formula)
    if match:
        return match.group(1)
    return formula

def append_shipping_details(row: list, order: dict):
    """
    Upsert into MongoDB using:
      - sheet-mirrored fields from `row`
      - extra fields (user_name, email) directly from `order` (NOT written to sheet)
    """
    try:
        cover_link_raw = _extract_url_from_formula(row[9])
        interior_link_raw = _extract_url_from_formula(row[10])

        # Pick keys that exist in YOUR payload. These fallbacks are safe:
        user_name = (
            order.get("user_name")
            or order.get("customer_name")
            or (order.get("shipping_address") or {}).get("name")
            or order.get("name")
            or ""
        )
        email = (
            order.get("email")
            or order.get("customer_email")
            or (order.get("shipping_address") or {}).get("email")
            or ""
        )

        doc = {
            "order_id": row[1],
            "order_date": row[2],
            "child_name": row[3],
            "book_style": row[4],
            "book_id": row[5],
            "city": row[6],
            "address": row[7],
            "phone": row[8],
            "cover_link": cover_link_raw,
            "interior_link": interior_link_raw,
            "quantity": row[11],

            # Mongo-only additions:
            "user_name": user_name,
            "email": email,

            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        shipping_collection.update_one(
            {"order_id": doc["order_id"]},
            {"$set": doc, "$setOnInsert": {"created_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )

        print(f"[MONGO] upserted shipping_details for order {row[1]}")
    except Exception as exc:
        print(f"[MONGO][ERROR] failed to upsert shipping_details for order {row[1]}: {exc}")


def append_row_to_google_sheet(row: list):
   
    try:
        client = get_gspread_client()
        sh = client.open_by_key(SPREADSHEET_ID)
        worksheet = sh.worksheet(WORKSHEET_NAME)

        _ensure_quantity_header(worksheet)

        worksheet.insert_row(row, index=2, value_input_option="USER_ENTERED")
        print(f"[SHEETS] appended row for order {row[1]}")
    except Exception as exc:
        print(f"[SHEETS][ERROR] failed to append row for order {row[1]}: {exc}")


@app.post("/orders/send-to-google-sheet")
async def send_to_google_sheet(order_ids: List[str], background_tasks: BackgroundTasks):
  
    if not SPREADSHEET_ID:
        raise HTTPException(status_code=500, detail="GOOGLE_SHEET_ID is not configured")

    # 1) De-duplicate IDs within this request (preserve order)
    seen = set()
    unique_order_ids = []
    for oid in order_ids:
        if oid not in seen:
            seen.add(oid)
            unique_order_ids.append(oid)

    results = []
    for order_id in unique_order_ids:
        print(f"[SHEETS] Processing order ID: {order_id}")
        order = orders_collection.find_one({"order_id": order_id})
        if not order:
            print(f"[SHEETS] Order not found: {order_id}")
            results.append({
                "order_id": order_id,
                "status": "error",
                "message": "Order not found",
                "step": "database_lookup"
            })
            continue

        # 2) ATOMIC LOCK: mark as queued only if not already queued
        lock_update = {
            "$set": {
                "sheet_queued": True,
                "printer": "Genesis",
                "print_status": "sent_to_genesis",
                "print_sent_at": datetime.now().isoformat()
            }
        }
        lock_filter = {"_id": order["_id"], "sheet_queued": {"$ne": True}}
        lock_result = orders_collection.update_one(lock_filter, lock_update)

        if lock_result.modified_count == 0:
            # Already queued/sent by an earlier request or click
            results.append({
                "order_id": order_id,
                "status": "skipped",
                "message": "Already queued previously; not sending again",
                "step": "idempotency_check"
            })
            continue

        # 3) Only now build the row and enqueue appends
        row = order_to_sheet_row(order)
        background_tasks.add_task(append_shipping_details, row, order)
        quantity = int(order.get("quantity", 1) or 1)
        quantity = max(1, quantity)
        for _ in range(quantity):
            background_tasks.add_task(append_row_to_google_sheet, row)

        

        results.append({
            "order_id": order_id,
            "status": "queued",
            "message": "Queued for sheet append",
            "step": "queued"
        })

    return results



@app.get("/jobs")
def get_jobs(
    sort_by: Optional[str] = Query(None, description="Field to sort by"),
    sort_dir: Optional[str] = Query("asc", description="asc or desc"),
    filter_status: Optional[str] = Query(None),
    filter_book_style: Optional[str] = Query(None),
):
    # No paid filter for jobs
    query = {}

    if filter_status == "approved":
        query["approved"] = True
    elif filter_status == "uploaded":
        query["approved"] = False

    if filter_book_style:
        query["book_style"] = filter_book_style

    sort_field = sort_by if sort_by else "created_at"
    sort_order = 1 if sort_dir == "asc" else -1

    projection = {
        "order_id": 1,
        "job_id": 1,
        "cover_url": 1,
        "book_url": 1,
        "preview_url": 1,
        "name": 1,
        "shipping_address": 1,
        "created_at": 1,
        "processed_at": 1,
        "approved_at": 1,
        "approved": 1,
        "book_id": 1,
        "book_style": 1,
        "print_status": 1,
        "price": 1,
        "total_price": 1,
        "amount": 1,
        "total_amount": 1,
        "feedback_email": 1,
        "locale": 1,
        "partial_preview": 1,
        "final_preview": 1,
        "printer": 1,
        "_id": 0
    }

    records = list(orders_collection.find(
        query, projection).sort(sort_field, sort_order))
    result = []

    for doc in records:
        shipping_address = doc.get("shipping_address", {})
        if isinstance(shipping_address, dict):
            city = shipping_address.get("city", "")

        else:
            city = ""
        result.append({
            "order_id": doc.get("order_id", ""),
            "job_id": doc.get("job_id", ""),
            "coverPdf": doc.get("cover_url", ""),
            "interiorPdf": doc.get("book_url", ""),
            "previewUrl": doc.get("preview_url", ""),
            "name": doc.get("name", ""),
            "city": city,
            "price": doc.get("price", doc.get("total_price", doc.get("amount", doc.get("total_amount", 0)))),
            "createdAt": format_date(jsonable_encoder(doc.get("created_at", ""))),
            "paymentDate": doc.get("processed_at", ""),
            "approvalDate": doc.get("approved_at", ""),
            "status": "Approved" if doc.get("approved") else "Uploaded",
            "bookId": doc.get("book_id", ""),
            "bookStyle": doc.get("book_style", ""),
            "printStatus": doc.get("print_status", ""),
            "locale": doc.get("locale", ""),
            "partial_preview": doc.get("partial_preview", "") or "",
            "final_preview": doc.get("final_preview", "") or "",
            "printer": doc.get("printer", "") or "",
        })

    return result


@app.get("/stats/jobs-timeline")
def jobs_timeline(interval: str = Query("day", enum=["day", "week", "month"])):
    # Map interval to MongoDB date format
    group_format = {
        "day": {"$dateToString": {"format": "%Y-%m-%d", "date": "$created_at"}},
        "week": {"$dateToString": {"format": "%Y-%U", "date": "$created_at"}},
        "month": {"$dateToString": {"format": "%Y-%m", "date": "$created_at"}},
    }[interval]

    pipeline = [
        {"$match": {"created_at": {"$exists": True, "$ne": None}}},
        {"$group": {
            "_id": group_format,
            "count": {"$sum": 1}
        }},
        {"$sort": {"_id": 1}}
    ]
    data = list(orders_collection.aggregate(pipeline))
    # Format for frontend
    return [{"date": d["_id"], "count": d["count"]} for d in data]


def format_approved_date_for_email(raw):
    try:
        if isinstance(raw, dict) and "$date" in raw:
            print(f"Raw approved_at value: {raw}")
            timestamp = int(raw["$date"]["$numberLong"])
            print(f"Timestamp: {timestamp}")
            return datetime.fromtimestamp(timestamp / 1000).strftime("%d %b, %Y")
        elif isinstance(raw, str) and raw.strip():
            return datetime.fromisoformat(raw).strftime("%d %b, %Y")
    except Exception as e:
        print(f"Error formatting approved_at: {e}")
    return "N/A"


def personalize_pronoun(gender: str) -> str:
    gender = gender.strip().lower()
    if gender == "boy":
        return "his"
    elif gender == "girl":
        return "her"
    else:
        return "their"  # fallback to original if gender is unknown


@app.post("/send-feedback-email/{job_id}")
def send_feedback_email(job_id: str, background_tasks: BackgroundTasks):
    order = orders_collection.find_one({"job_id": job_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    recipient_email = order.get("email", "")
    if not recipient_email:
        raise HTTPException(
            status_code=400, detail="No email found for this order")

    try:
        html_content = f"""
        <html>
        <head>
        <meta charset="UTF-8">
        <meta name="color-scheme" content="light">
        <meta name="supported-color-schemes" content="light">
        <title>We'd love your feedback</title>
        <style>
        @keyframes shine-sweep {{
          0%   {{ transform: translateX(-100%) rotate(45deg); }}
          50%  {{ transform: translateX(100%)  rotate(45deg); }}
          100% {{ transform: translateX(100%)  rotate(45deg); }}
        }}
        .review-btn {{
          position: relative;
          display: inline-block;
          border-radius: 20px;
          font-family: Arial, Helvetica, sans-serif;
          font-weight: bold;
          text-decoration: none;
          color: #ffffff !important;
          background-color: #5784ba;
          overflow: hidden;
          padding: 12px 24px;
          font-size: 16px;
        }}
        .review-btn::before {{
          content: "";
          position: absolute;
          top: 0;
          left: -50%;
          height: 100%;
          width: 200%;
          background: linear-gradient(120deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%);
          animation: shine-sweep 4s infinite;
        }}
        @media only screen and (max-width: 480px) {{
            h2 {{ font-size: 15px !important; }}
            p {{ font-size: 15px !important; }}
            a {{ font-size: 15px !important; }}
            .title-text {{ font-size: 18px !important; }}
            .small-text {{ font-size: 12px !important; }}
            .logo-img {{ width: 300px !important; }}
            .review-btn {{ font-size: 13px !important; padding: 10px 16px !important; width: 100% !important; text-align: center !important; }}
            .browse-now-btn {{
              font-size: 12px !important;
              padding: 8px 12px !important;
            }}
        }}
        </style>

        </head>
        <body style="font-family: Arial, sans-serif; background-color: #f7f7f7; padding: 20px; margin: 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width: 600px; margin: 0 auto; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1);">
            <tr>
            <td style="padding: 20px;">
                <div style="text-align: left; margin-bottom: 20px;">
                <img src="https://diffrungenerations.s3.ap-south-1.amazonaws.com/Diffrun_logo+(1).png" alt="Diffrun" class="logo-img" style="max-width: 100px;">
                </div>

                <h2 style="color: #333; font-size: 15px;">Hey {order.get("user_name")},</h2>

                <p style="font-size: 14px; color: #555;">
                We truly hope {order.get("name", "")} is enjoying {personalize_pronoun(order.get("gender", "   "))} magical storybook, <strong>{generate_book_title(order.get("book_id"), order.get("name"))}</strong>! 
                At Diffrun, we are dedicated to crafting personalized storybooks that inspire joy, imagination, and lasting memories for every child. 
                Your feedback means the world to us. We'd be grateful if you could share your experience.
                </p>

                <p style="font-size: 14px; color: #555;">Please share your feedback with us:</p>

                <p style="text-align: left; margin: 30px 0;">
                <a href="https://search.google.com/local/writereview?placeid=ChIJn5mGENoTrjsRPHxH86vgui0"
                    class="review-btn"
                    style="background-color: #5784ba; color: #ffffff; text-decoration: none; border-radius: 20px;">
                    Leave a Google Review
                </a>
                </p>

                <p style="font-size: 14px; color: #555; text-align: left;">
                Thanks,<br>Team Diffrun
                </p>

                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">

                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 30px;">
                <tr>
                    <td colspan="2" style="padding: 10px 0; text-align: left;">
                    <p class="title-text" style="font-size: 18px; margin: 0; font-weight: bold; color: #000;">
                            {generate_book_title(order.get("book_id"), order.get("name"))}
                            </p>
                    </td>
                </tr>

                <tr>
                    <td style="padding: 0; vertical-align: top; font-size: 12px; color: #333; font-weight: 500;">
                    Order reference ID: <span>{order.get("order_id", "N/A")}</span>
                    </td>
                    <td style="padding: 0; text-align: right; font-size: 12px; color: #333; font-weight: 500;">
                    Ordered: <span>{format_date(order.get("approved_at", ""))}</span>
                    </td>
                </tr>

                <tr>
                    <td colspan="2" style="padding: 0; margin: 0; background-color: #f7f6cf;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; padding: 0; margin: 0;">
                        <tr>
                        <td style="padding: 20px; vertical-align: middle; margin: 0;">
                            
                            <p style="font-size: 15px; margin: 0;">
                        Explore more magical books in our growing collection &nbsp;
                        <button class="browse-now-btn" style="background-color:#5784ba; margin-top: 20px; border-radius: 30px;border: none;padding:10px 15px"><a href="https://diffrun.com" style="color:white; font-weight: bold; text-decoration: none;">
                        Browse Now
                        </a></button>
                    </p>
                        </td>

                        <td width="300" style="padding: 0; margin: 0; vertical-align: middle;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
                            <tr>
                                <td align="right" style="padding: 0; margin: 0;">
                                <img src="https://diffrungenerations.s3.ap-south-1.amazonaws.com/email_image+(2).jpg" 
                                    alt="Cover Image" 
                                    width="300" 
                                    style="display: block; border-radius: 0; margin: 0; padding: 0;">
                                </td>
                            </tr>
                            </table>
                        </td>
                        </tr>
                    </table>
                    </td>
                </tr>

                </table>

            </td>
            </tr>
        </table>
        </body>
        </html>
        """

        msg = EmailMessage()
        msg["Subject"] = f"We'd love your feedback on {order.get('name', '')}'s Storybook!"
        msg["From"] = f"Diffrun Team <{os.getenv('EMAIL_ADDRESS')}>"
        msg["To"] = order.get("email", "")
        msg.set_content("This email contains HTML content.")
        msg.add_alternative(html_content, subtype="html")

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            EMAIL_USER = os.getenv("EMAIL_ADDRESS")
            EMAIL_PASS = os.getenv("EMAIL_PASSWORD")
            print(f"email, password: {EMAIL_USER}, {EMAIL_PASS}")
            smtp.login(EMAIL_USER, EMAIL_PASS)
            smtp.send_message(msg)

        logger.info(f"✅ Feedback email sent to {order.get("email", "")}")

        orders_collection.update_one(
            {"job_id": job_id},
            {"$set": {"feedback_email": True}}
        )

    except Exception as e:
        logger.error(f"❌ Failed to send feedback email: {e}")
        raise HTTPException(status_code=500, detail="Failed to send email.")

    return {"message": "Feedback email queued"}


def send_email(to_email: str, subject: str, body: str):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = "haripriya@lhmm.in"
    msg["To"] = to_email
    msg.set_content(body)

    try:
        # OPTION A – Port 465 (SSL from the start)
        EMAIL_USER = os.getenv("EMAIL_ADDRESS")
        EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD")

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(EMAIL_USER, EMAIL_PASSWORD)
            smtp.send_message(msg)

        print(f"✅ Sent email to {to_email}")
    except Exception as e:
        print(f"❌ Error sending email to {to_email}: {e}")


def send_nudge_email_to_user(email: str, user_name: str | None, child_name: str | None, job_id: str):
    order = orders_collection.find_one({"job_id": job_id})
    if not order:
        logger.warning(f"⚠️ Could not find order for job_id={job_id}")
        return

    preview_link = order.get(
        "preview_url", f"https://diffrun.com/preview/{job_id}")

    user_name = ((user_name or "").strip().title()) or "there"
    child_name = ((child_name or "").strip().title()) or "your child"

    html_content = f"""
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <p>Hi <strong>{user_name}</strong>,</p>
        <p>We noticed you began crafting a personalized storybook for <strong>{child_name}</strong> — and it’s already looking magical!</p>
        <p>Just one more step to bring it to life: preview the story and place your order whenever you’re ready.</p>
        <p style="margin: 32px 0;">
          <a href="{preview_link}" 
             style="background-color: #5784ba; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: bold;">
            Preview & Continue
          </a>
        </p>
        <p>Your story is safe and waiting. We’d love for <strong>{child_name}</strong> to see themselves in a story made just for them. 💫</p>
        <p>Warm wishes,<br><strong>The Diffrun Team</strong></p>
      </body>
    </html>
    """

    msg = EmailMessage()
    msg["Subject"] = f"{child_name}'s Diffrun Storybook is waiting!"
    msg["From"] = f"Diffrun Team <{os.getenv('EMAIL_ADDRESS')}>"
    msg["To"] = email
    msg.add_alternative(html_content, subtype="html")

    EMAIL_USER = (os.getenv("EMAIL_ADDRESS") or "").strip()
    EMAIL_PASS = (os.getenv("EMAIL_PASSWORD") or "").strip()
    if not EMAIL_USER or not EMAIL_PASS:
        raise RuntimeError("EMAIL_ADDRESS/EMAIL_PASSWORD not configured")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)


def send_nudge_email():
    try:
        ist = ZoneInfo("Asia/Kolkata")
        now_ist = datetime.now(ist)
        start_ist_date = (now_ist.date() - timedelta(days=1))
        end_ist_date = now_ist.date()

        start_dt_ist = datetime(
            start_ist_date.year, start_ist_date.month, start_ist_date.day, 0, 0, 0, tzinfo=ist)
        end_dt_ist = datetime(end_ist_date.year,   end_ist_date.month,
                              end_ist_date.day,   0, 0, 0, tzinfo=ist)

        start_utc = start_dt_ist.astimezone(timezone.utc)
        end_utc = end_dt_ist.astimezone(timezone.utc)

        pipeline = [
            {"$match": {
                "paid": False,
                # nudge_sent false OR missing
                "$or": [{"nudge_sent": False}, {"nudge_sent": {"$exists": False}}],
                # strictly yesterday (IST converted to UTC)
                "created_at": {"$gte": start_utc, "$lt": end_utc},
                # email present and not @lhmm.in
                "email": {"$exists": True, "$ne": None, "$not": {"$regex": "@lhmm\\.in$", "$options": "i"}},
                # workflows present
                "workflows": {"$exists": True},
            }},
            # workflows object length == 13
            {"$match": {
                "$expr": {"$eq": [{"$size": {"$objectToArray": "$workflows"}}, 13]}
            }},
            {"$sort": {"email": 1, "created_at": -1}},
            {"$group": {"_id": "$email", "doc": {"$first": "$$ROOT"}}},
            {"$replaceRoot": {"newRoot": "$doc"}},
            {"$limit": 1000},
            {"$project": {"email": 1, "user_name": 1, "name": 1, "job_id": 1}},
        ]

        candidates = list(orders_collection.aggregate(pipeline))
        logger.info(
            f"Found {len(candidates)} nudge candidates for yesterday (IST).")

        for user in candidates:
            try:
                send_nudge_email_to_user(
                    email=user["email"],
                    user_name=user.get("user_name"),
                    child_name=user.get("name"),
                    job_id=user["job_id"],
                )
                orders_collection.update_one(
                    {"job_id": user["job_id"]},
                    {"$set": {"nudge_sent": True,
                              "nudge_sent_at": datetime.now(timezone.utc)}}
                )
                logger.info(f"✅ Nudge sent to {user['email']}")
            except Exception as e:
                logger.error(
                    f"❌ Error sending email to {user.get('email')}: {e}")
    except Exception as e:
        logger.error(f"❌ Nudge email task failed: {e}")


@app.get("/debug/nudge-candidates")
def debug_nudge_candidates():
    ist = ZoneInfo("Asia/Kolkata")
    now_ist = datetime.now(ist)

    # Yesterday in IST (00:00 to 23:59)
    yesterday_ist = now_ist.date() - timedelta(days=1)
    start_yesterday_ist = datetime(
        yesterday_ist.year, yesterday_ist.month, yesterday_ist.day, 0, 0, 0, tzinfo=ist)
    end_yesterday_ist = datetime(
        yesterday_ist.year, yesterday_ist.month, yesterday_ist.day, 23, 59, 59, tzinfo=ist)

    # Today in IST (00:00 to current time)
    today_ist = now_ist.date()
    start_today_ist = datetime(
        today_ist.year, today_ist.month, today_ist.day, 0, 0, 0, tzinfo=ist)
    end_today_ist = now_ist  # current time

    # Convert to UTC for Mongo
    start_yesterday_utc = start_yesterday_ist.astimezone(timezone.utc)
    end_yesterday_utc = end_yesterday_ist.astimezone(timezone.utc)
    start_today_utc = start_today_ist.astimezone(timezone.utc)
    end_today_utc = end_today_ist.astimezone(timezone.utc)

    pipeline = [
        # First, match documents from both yesterday AND today with basic filters
        {"$match": {
            "$or": [
                {"created_at": {"$gte": start_yesterday_utc, "$lt": end_yesterday_utc}},
                {"created_at": {"$gte": start_today_utc, "$lt": end_today_utc}}
            ],
            "email": {
                "$exists": True, "$ne": None,
                "$not": {"$regex": "@lhmm\\.in$", "$options": "i"}
            },
            "workflows": {"$exists": True}
        }},

        # Filter for exactly 13 workflows
        {"$match": {
            "$expr": {
                "$eq": [
                    {"$size": {"$objectToArray": "$workflows"}},
                    13
                ]
            }
        }},

        # Group by email to check payment status
        {"$group": {
            "_id": "$email",
            "docs": {"$push": "$$ROOT"},
            # If any order has paid=true, this becomes true
            "has_paid_order": {"$max": "$paid"},
            # Find the most recent order
            "latest_created_at": {"$max": "$created_at"}
        }},

        # Only include emails where ALL orders are unpaid (has_paid_order is false)
        {"$match": {
            "has_paid_order": False
        }},

        # Find the most recent document for each email
        {"$project": {
            "email": "$_id",
            "latest_doc": {
                "$arrayElemAt": [
                    {"$filter": {
                        "input": "$docs",
                        "as": "doc",
                        "cond": {"$eq": ["$$doc.created_at", "$latest_created_at"]}
                    }},
                    0
                ]
            }
        }},

        # Replace root with the latest document
        {"$replaceRoot": {"newRoot": "$latest_doc"}},

        # Filter for nudge_sent: false or missing
        {"$match": {
            "$or": [{"nudge_sent": False}, {"nudge_sent": {"$exists": False}}]
        }},

        # Project only needed fields
        {"$project": {
            "_id": 0,
            "email": 1,
            "user_name": 1,
            "name": 1,
            "job_id": 1,
            "created_at": 1,
            "paid": 1,
            "nudge_sent": 1,
            "workflows_count": {"$size": {"$objectToArray": "$workflows"}}
        }}
    ]

    results = list(orders_collection.aggregate(pipeline))

    # Add debug info to see what time ranges we're querying
    debug_info = {
        "yesterday_ist_range": {
            "start": start_yesterday_ist.isoformat(),
            "end": end_yesterday_ist.isoformat()
        },
        "today_ist_range": {
            "start": start_today_ist.isoformat(),
            "end": end_today_ist.isoformat()
        },
        "yesterday_utc_range": {
            "start": start_yesterday_utc.isoformat(),
            "end": end_yesterday_utc.isoformat()
        },
        "today_utc_range": {
            "start": start_today_utc.isoformat(),
            "end": end_today_utc.isoformat()
        },
        "current_ist_time": now_ist.isoformat(),
        "candidates_found": len(results),
        "candidates": results
    }

    return debug_info


@app.post("/orders/unapprove")
async def unapprove_orders(req: UnapproveRequest):
    for job_id in req.job_ids:
        result = orders_collection.update_one(
            {"job_id": job_id},
            {"$set": {"approved": False}}
        )
    if result.modified_count == 0:
        raise HTTPException(
            status_code=404, detail=f"No order found with job_id {job_id}")

    prefix = f"output/{job_id}/"
    folders_to_move = ["final_coverpage/", "approved_output/"]
    for folder in folders_to_move:
        old_prefix = prefix + folder
        new_prefix = prefix + "previous/" + folder

        response = s3.list_objects_v2(Bucket=BUCKET_NAME, Prefix=old_prefix)

        if "Contents" not in response:
            continue

        for obj in response["Contents"]:
            src_key = obj["Key"]
            dst_key = src_key.replace(old_prefix, new_prefix, 1)

            s3.copy_object(Bucket=BUCKET_NAME, CopySource={
                           "Bucket": BUCKET_NAME, "Key": src_key}, Key=dst_key)
            s3.delete_object(Bucket=BUCKET_NAME, Key=src_key)

    return {"message": f"Unapproved {len(req.job_ids)} orders successfully"}


@app.get("/export-orders-csv")
def export_orders_csv():
    fields = [
        "email", "phone_number", "age", "book_id", "book_style", "total_price", "gender", "paid",
        "approved", "created_date", "created_time", "creation_hour",
        "payment_date", "payment_time", "payment_hour",
        "locale", "name", "user_name", "shipping_address.city", "shipping_address.province",
        "order_id", "discount_code", "paypal_capture_id", "transaction_id", "tracking_code", "partial_preview", "final_preview","cust_status"
    ]

    projection = {
        "email": 1, "phone_number": 1, "age": 1, "book_id": 1, "book_style": 1, "total_price": 1,
        "gender": 1, "paid": 1, "approved": 1, "created_at": 1, "processed_at": 1,
        "locale": 1, "name": 1, "user_name": 1, "shipping_address": 1, "order_id": 1,
        "discount_code": 1, "paypal_capture_id": 1, "transaction_id": 1, "tracking_code": 1, "partial_preview": 1, "final_preview": 1,"cust_status": 1
    }

    cursor = orders_collection.find({}, projection).sort("created_at", -1)

    def format_datetime_parts(dt):
        try:
            if isinstance(dt, str):
                dt = parser.isoparse(dt)
            if isinstance(dt, datetime):
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                dt_ist = dt.astimezone(IST)
                return (
                    dt_ist.strftime("%d-%m-%Y"),     # date
                    dt_ist.strftime("%I:%M %p"),     # time
                    dt_ist.strftime("%H")            # 24-hour
                )
        except Exception as e:
            print("⚠️ Date parse failed:", e)
        return "", "", ""

    with tempfile.NamedTemporaryFile(mode="w+", newline='', delete=False, suffix=".csv", encoding="utf-8") as temp_file:
        writer = csv.writer(temp_file)
        writer.writerow(fields)

        for doc in cursor:
            created_date, created_time, creation_hour = format_datetime_parts(
                doc.get("created_at"))
            payment_date, payment_time, payment_hour = format_datetime_parts(
                doc.get("processed_at"))

            row = []
            for field in fields:
                if field == "created_date":
                    row.append(created_date)
                elif field == "created_time":
                    row.append(created_time)
                elif field == "creation_hour":
                    row.append(creation_hour)
                elif field == "payment_date":
                    row.append(payment_date)
                elif field == "payment_time":
                    row.append(payment_time)
                elif field == "payment_hour":
                    row.append(payment_hour)
                else:
                    # Nested field handling
                    if '.' in field:
                        value = doc
                        for part in field.split('.'):
                            if isinstance(value, dict):
                                value = value.get(part, "")
                            else:
                                value = ""
                    else:
                        value = doc.get(field, "")

                    # Price formatting for relevant fields
                    if field in ["total_price", "price", "amount", "total_amount"]:
                        try:
                            value = float(value)
                            value = "{:.2f}".format(value)
                        except:
                            value = ""
                    if field == "phone_number":
                        value = str(value).replace(",", "").strip()

                    row.append(value)

            writer.writerow(row)

        temp_file.flush()
        return FileResponse(temp_file.name, media_type="text/csv", filename="orders_export.csv")


IST_OFFSET = timedelta(hours=5, minutes=30)
TIMESTAMP_FIELD = "time_req_recieved"

INSTANCE_IDS = [
    "i-0b1f98e12f9344f9f",
    "i-071c197c88296ab8a",
    "i-03dbcc37d0a59609d",
    "i-00de64646abb34ad2",
    "i-0e9f5ac83b77815a0",
    "i-0e6c27e8b058676f8",
    "i-0bfbcb4615bc6b3e3",
    "i-0b1f98e12f9344f9f",
    "i-071c197c88296ab8a",
    "i-03dbcc37d0a59609d",
    "i-00de64646abb34ad2",
]


def _parse_dt(value):
    """Return naive datetime from common string or datetime inputs; None if not parseable."""
    if isinstance(value, datetime):
        # Strip tzinfo if present (we’ll treat it as naive UTC below)
        return value.replace(tzinfo=None)
    if isinstance(value, str):
        # Try a few common wire formats
        for fmt in (
            "%Y-%m-%dT%H:%M:%S.%fZ",
            "%Y-%m-%dT%H:%M:%SZ",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S",
        ):
            try:
                dt = datetime.strptime(value, fmt)
                return dt.replace(tzinfo=None)
            except ValueError:
                pass
    return None


def _pick_excel_engine():
    try:
        import xlsxwriter  # noqa: F401
        return "xlsxwriter"
    except Exception:
        try:
            import openpyxl  # noqa: F401
            return "openpyxl"
        except Exception:
            return None


def _fmt_ist(dt):
    try:
        if dt is None:
            return ""
        if isinstance(dt, str):
            try:
                dt = parser.isoparse(dt)
            except Exception:
                return ""
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


AWS_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")


def _get_ec2_status_rows():
    try:
        if not AWS_REGION:
            return [], "AWS region not set. Set AWS_REGION or AWS_DEFAULT_REGION."

        ec2 = boto3.client("ec2", region_name=AWS_REGION)
        resp = ec2.describe_instances(InstanceIds=INSTANCE_IDS)
        reservations = resp.get("Reservations", [])

        # Gather instance ids for status checks
        instance_ids = [
            inst["InstanceId"]
            for r in reservations
            for inst in r.get("Instances", [])
        ]
        checks_map = {}
        if instance_ids:
            status_resp = ec2.describe_instance_status(
                InstanceIds=instance_ids, IncludeAllInstances=True
            )
            for s in status_resp.get("InstanceStatuses", []):
                checks_map[s["InstanceId"]] = {
                    "InstanceStatus": s.get("InstanceStatus", {}).get("Status", ""),
                    "SystemStatus": s.get("SystemStatus", {}).get("Status", ""),
                }

        now_ist = datetime.utcnow().replace(tzinfo=timezone.utc).astimezone(IST)
        rows = []
        for r in reservations:
            for inst in r.get("Instances", []):
                iid = inst.get("InstanceId", "")
                state = (inst.get("State") or {}).get("Name", "")
                name = ""
                for tag in inst.get("Tags", []) or []:
                    if tag.get("Key") == "Name":
                        name = tag.get("Value") or ""
                        break

                rows.append({
                    "Name": name,
                    "InstanceId": iid,
                    "State": state,                           # running/stopped/…
                    "OnOff": "on" if state == "running" else "off",
                    "InstanceStatus": checks_map.get(iid, {}).get("InstanceStatus", ""),
                    "SystemStatus": checks_map.get(iid, {}).get("SystemStatus", ""),
                    "PublicIP": inst.get("PublicIpAddress", ""),
                    "PrivateIP": inst.get("PrivateIpAddress", ""),
                    "LaunchTime_IST": _fmt_ist(inst.get("LaunchTime")),
                    "CheckedAt_IST": now_ist.strftime("%Y-%m-%d %H:%M:%S"),
                })

        return rows, None

    except (BotoCoreError, ClientError) as e:
        return [], f"AWS error: {e}"
    except Exception as e:
        return [], f"Unexpected error: {e}"


def _get_ec2_status_rows() -> Tuple[List[dict], Optional[str]]:
    """
    Return (rows, err).  Skips any missing instance IDs instead of failing.
    rows schema includes keys used later: OnOff, Name, InstanceId (plus extras).
    """
    ec2 = boto3.client("ec2", region_name=os.getenv("AWS_REGION", None))

    # Source of instance IDs: keep whatever you already use
    # Example: a global/list env. Do NOT change your current source; just read it.
    # If you already have EC2_INSTANCE_IDS somewhere, keep that.
    instance_ids: List[str] = INSTANCE_IDS  # type: ignore[name-defined]

    rows: List[dict] = []
    if not instance_ids:
        # Nothing to do; do not error
        return rows, None

    def chunks(lst, n):
        for i in range(0, len(lst), n):
            yield lst[i:i + n]

    skipped: List[str] = []

    for chunk in chunks(instance_ids, 100):
        to_query = list(chunk)
        if not to_query:
            continue

        while to_query:
            try:
                resp = ec2.describe_instances(InstanceIds=to_query)
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code")
                if code == "InvalidInstanceID.NotFound":
                    # Extract bad IDs from the message and drop them
                    msg = e.response.get("Error", {}).get("Message", "")
                    bad = re.findall(r"i-[0-9a-f]+", msg)
                    if not bad:
                        # If we can't parse, skip this whole chunk and move on
                        logging.warning(
                            "EC2: could not parse missing IDs from: %s", msg)
                        break
                    skipped.extend(bad)
                    to_query = [i for i in to_query if i not in bad]
                    if not to_query:
                        break
                    # retry with the remaining IDs
                    continue
                else:
                    # Any other AWS error: surface a single error string (optional)
                    logging.exception("EC2 describe_instances failed")
                    return rows, f"AWS error: {e}"

            # Process reservations -> instances
            for r in resp.get("Reservations", []):
                for inst in r.get("Instances", []):
                    iid = inst.get("InstanceId", "")
                    state = (inst.get("State", {}) or {}).get("Name", "")
                    # OnOff field as int (1 running, 0 otherwise), matches your sort later
                    onoff = 1 if state == "running" else 0
                    # Name tag
                    name = ""
                    for t in inst.get("Tags", []) or []:
                        if t.get("Key") == "Name":
                            name = t.get("Value", "")
                            break
                    rows.append({
                        "OnOff": onoff,
                        "Name": name,
                        "InstanceId": iid,
                        "State": state,
                        "Type": inst.get("InstanceType", ""),
                        "AZ": (inst.get("Placement", {}) or {}).get("AvailabilityZone", ""),
                        "PrivateIP": inst.get("PrivateIpAddress", ""),
                        "PublicIP": inst.get("PublicIpAddress", ""),
                        "LaunchTime": inst.get("LaunchTime", ""),
                    })
            break  # exit the inner while after successful call

    if skipped:
        logging.warning("EC2: skipped missing instance IDs: %s",
                        ", ".join(skipped))

    # IMPORTANT: we return no error so the caller writes 'ec2_status' (not *_error)
    return rows, None


@app.get("/download-csv")
def download_csv(from_date: str = Query(...), to_date: str = Query(...)):
    try:
        # Validate date range (inclusive to 23:59:59 for to_date)
        from_dt = datetime.strptime(from_date, "%Y-%m-%d")
        to_dt = datetime.strptime(
            to_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
        if from_dt > to_dt:
            return Response(content="from_date cannot be after to_date", media_type="text/plain", status_code=400)

        # Pull rows from Mongo (exclude _id)
        data = list(collection_df.find(
            {TIMESTAMP_FIELD: {"$gte": from_dt, "$lte": to_dt}},
            {"_id": 0}
        ))

        if not data:
            return Response(content="No data available", media_type="text/plain", status_code=404)

        # Compute additional columns per row
        rows_out = []
        for row in data:
            r = dict(row)
            base_ts = _parse_dt(r.get(TIMESTAMP_FIELD))

            # Default blanks if missing/unparseable
            r["date"] = ""
            r["hour"] = ""
            r["date-hour"] = ""
            r["ist-date"] = ""
            r["ist-hour"] = ""

            if base_ts is not None:
                # Original timestamp derived columns
                r["date"] = base_ts.strftime("%d/%m/%Y")  # DD/MM/YYYY
                r["hour"] = base_ts.strftime("%H")        # HH (00-23)

                # IST adjusted timestamp (UTC + 05:30)
                ist_ts = base_ts + IST_OFFSET
                # combined datetime for sheets
                r["date-hour"] = ist_ts.strftime("%Y-%m-%d %H:%M:%S")
                r["ist-date"] = ist_ts.strftime("%d/%m/%Y")
                r["ist-hour"] = ist_ts.strftime("%H")

            rows_out.append(r)

        # Ensure consistent column order (existing cols first, then new cols)
        extra_cols = ["date", "hour", "date-hour", "ist-date", "ist-hour"]
        base_cols = [k for k in rows_out[0].keys() if k not in extra_cols]
        fieldnames = base_cols + extra_cols

        # Write CSV
        csv_file = io.StringIO()
        writer = csv.DictWriter(
            csv_file, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows_out)
        csv_file.seek(0)

        # Name is overridden by your frontend anyway; leaving static is fine
        headers = {
            "Content-Disposition": "attachment; filename=darkfantasy_orders.csv"}
        return StreamingResponse(csv_file, media_type="text/csv", headers=headers)

    except Exception as e:
        return Response(content=f"❌ Error: {str(e)}", media_type="text/plain", status_code=500)


@app.get("/download-xlsx")
def download_xlsx(from_date: str = Query(...), to_date: str = Query(...)):
    try:
        # Validate range
        from_dt = datetime.strptime(from_date, "%Y-%m-%d")
        to_dt = datetime.strptime(
            to_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
        if from_dt > to_dt:
            return Response("from_date cannot be after to_date", media_type="text/plain", status_code=400)

        # Query Mongo (exclude _id)
        data = list(collection_df.find(
            {TIMESTAMP_FIELD: {"$gte": from_dt, "$lte": to_dt}},
            {"_id": 0}
        ))
        if not data:
            return Response("No data available", media_type="text/plain", status_code=404)

        # Build rows + IST columns
        rows_out = []
        for row in data:
            r = dict(row)
            base_ts = _parse_dt(r.get(TIMESTAMP_FIELD))

            r["date"] = ""
            r["hour"] = ""
            r["date-hour"] = ""
            r["ist-date"] = ""
            r["ist-hour"] = ""

            if base_ts is not None:
                ist_ts = base_ts + IST_OFFSET  # remove if DB already stores IST
                r["date"] = base_ts.strftime("%d/%m/%Y")
                r["hour"] = base_ts.strftime("%H")
                r["date-hour"] = ist_ts.strftime("%Y-%m-%d %H:%M:%S")
                r["ist-date"] = ist_ts.strftime("%d/%m/%Y")
                r["ist-hour"] = ist_ts.strftime("%H")

            rows_out.append(r)

        df = pd.DataFrame(rows_out)

        # Ensure required columns exist
        for col in ["ist-date", "ist-hour", "room_id"]:
            if col not in df.columns:
                df[col] = ""

        # Build pivot: count of room_id by (ist-date x ist-hour)
        hours = [f"{h:02d}" for h in range(24)]
        df["ist-hour"] = df["ist-hour"].astype(str)
        pivot = pd.pivot_table(
            df, index="ist-date", columns="ist-hour",
            values="room_id", aggfunc="count", fill_value=0
        )
        pivot = pivot.reindex(columns=hours, fill_value=0)

        # Sort ist-date as real dates when possible
        def _date_key(x):
            try:
                return datetime.strptime(x, "%d/%m/%Y")
            except Exception:
                return x
        pivot = pivot.sort_index(key=lambda idx: [_date_key(x) for x in idx])

        # Totals
        pivot["Total"] = pivot.sum(axis=1)
        pivot.loc["Total"] = pivot.sum(numeric_only=True)

        # Pick an engine we actually have
        engine = _pick_excel_engine()
        if engine is None:
            return Response(
                "Missing Excel writer engine. Install one of: pip install xlsxwriter OR pip install openpyxl",
                media_type="text/plain", status_code=500
            )

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine=engine) as writer:
            # Sheet 1: raw/orders
            # df.to_excel(writer, index=False, sheet_name="orders")
            # Sheet 2: pivot
            pivot.to_excel(writer, sheet_name="pivot")

            # ✅ NEW: Sheet 3 — EC2 status
            ec2_rows, ec2_err = _get_ec2_status_rows()
            if ec2_err:
                pd.DataFrame([{"error": ec2_err}]).to_excel(
                    writer, index=False, sheet_name="ec2_status_error"
                )
            else:
                ec2_df = pd.DataFrame(ec2_rows)
                if not ec2_df.empty:
                    for col in ec2_df.columns:
                        if pd.api.types.is_datetime64tz_dtype(ec2_df[col]):
                            ec2_df[col] = ec2_df[col].dt.tz_convert(
                                'UTC').dt.tz_localize(None)
                        elif ec2_df[col].dtype == "object":
                            if ec2_df[col].apply(lambda v: isinstance(v, datetime) and getattr(v, "tzinfo", None) is not None).any():
                                ec2_df[col] = ec2_df[col].apply(_to_naive_utc)
                ec2_df.to_excel(writer, index=False, sheet_name="ec2_status")

            # Freeze panes (engine-specific)
            if engine == "xlsxwriter":
                # ws1 = writer.sheets["orders"]
                ws1 = writer.sheets["pivot"]
                ws2 = writer.sheets.get("ec2_status")
                # if ws1:ws1.freeze_panes(1, 0)  # row 2
                if ws1:
                    ws1.freeze_panes(1, 1)  # row 2, col B
                if ws2:
                    ws2.freeze_panes(1, 0)

            else:  # openpyxl
                # ws1 = writer.sheets.get("orders")
                ws1 = writer.sheets.get("pivot")
                ws2 = writer.sheets.get("ec2_status")
                # if ws1 is not None: ws1.freeze_panes = "A2"
                if ws1 is not None:
                    ws1.freeze_panes = "B2"
                if ws2 is not None:
                    ws2.freeze_panes = "A2"

        output.seek(0)
        filename = f"darkfantasy_{from_date}_to_{to_date}.xlsx"
        headers = {"Content-Disposition": f"attachment; filename={filename}"}
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers
        )

    except Exception as e:
        # Return the message so you see the real cause in the browser too
        return Response(f"❌ Error building XLSX: {e}", media_type="text/plain", status_code=500)


@app.get("/download-xlsx-yippee")
def download_xlsx_yippee(from_date: str = Query(...), to_date: str = Query(...)):
    try:
        # Validate range (dates are interpreted as UTC-naive, like your original)
        from_dt = datetime.strptime(from_date, "%Y-%m-%d")
        to_dt = datetime.strptime(
            to_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
        if from_dt > to_dt:
            return Response("from_date cannot be after to_date", media_type="text/plain", status_code=400)

        # Query Yippee collection (exclude _id)
        data = list(
            collection_yippee.find(
                {TIMESTAMP_FIELD: {"$gte": from_dt, "$lte": to_dt}},
                {"_id": 0},
            )
        )
        if not data:
            return Response("No data available", media_type="text/plain", status_code=404)

        # Build rows + IST helper columns (same logic as your DF endpoint)
        rows_out = []
        for row in data:
            r = dict(row)
            base_ts = _parse_dt(r.get(TIMESTAMP_FIELD))

            r["date"] = ""
            r["hour"] = ""
            r["date-hour"] = ""
            r["ist-date"] = ""
            r["ist-hour"] = ""

            if base_ts is not None:
                ist_ts = base_ts + IST_OFFSET  # keep same assumption as DF endpoint
                r["date"] = base_ts.strftime("%d/%m/%Y")
                r["hour"] = base_ts.strftime("%H")
                r["date-hour"] = ist_ts.strftime("%Y-%m-%d %H:%M:%S")
                r["ist-date"] = ist_ts.strftime("%d/%m/%Y")
                r["ist-hour"] = ist_ts.strftime("%H")

            rows_out.append(r)

        df = pd.DataFrame(rows_out)

        # Ensure required columns exist
        for col in ["ist-date", "ist-hour", "room_id"]:
            if col not in df.columns:
                df[col] = ""

        # Pivot: count of room_id by (ist-date × ist-hour)
        hours = [f"{h:02d}" for h in range(24)]
        df["ist-hour"] = df["ist-hour"].astype(str)
        pivot = pd.pivot_table(
            df,
            index="ist-date",
            columns="ist-hour",
            values="room_id",
            aggfunc="count",
            fill_value=0,
        )
        pivot = pivot.reindex(columns=hours, fill_value=0)

        # Sort ist-date as real dates when possible
        def _date_key(x):
            try:
                return datetime.strptime(x, "%d/%m/%Y")
            except Exception:
                return x

        pivot = pivot.sort_index(key=lambda idx: [_date_key(x) for x in idx])

        # Totals
        pivot["Total"] = pivot.sum(axis=1)
        pivot.loc["Total"] = pivot.sum(numeric_only=True)

        # Pick writer engine
        engine = _pick_excel_engine()
        if engine is None:
            return Response(
                "Missing Excel writer engine. Install one of: pip install xlsxwriter OR pip install openpyxl",
                media_type="text/plain",
                status_code=500,
            )

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine=engine) as writer:
            # pivot sheet
            pivot.to_excel(writer, sheet_name="pivot")

            # EC2 status sheet (same as DF)
            ec2_rows, ec2_err = _get_ec2_status_rows()
            if ec2_err:
                pd.DataFrame([{"error": ec2_err}]).to_excel(
                    writer, index=False, sheet_name="ec2_status_error"
                )
            else:
                ec2_df = pd.DataFrame(ec2_rows)
                if not ec2_df.empty:
                    for col in ec2_df.columns:
                        if pd.api.types.is_datetime64tz_dtype(ec2_df[col]):
                            ec2_df[col] = ec2_df[col].dt.tz_convert(
                                'UTC').dt.tz_localize(None)
                        elif ec2_df[col].dtype == "object":
                            if ec2_df[col].apply(lambda v: isinstance(v, datetime) and getattr(v, "tzinfo", None) is not None).any():
                                ec2_df[col] = ec2_df[col].apply(_to_naive_utc)
                ec2_df.to_excel(writer, index=False, sheet_name="ec2_status")

            # Freeze panes
            if engine == "xlsxwriter":
                ws1 = writer.sheets["pivot"]
                ws2 = writer.sheets.get("ec2_status")
                if ws1:
                    ws1.freeze_panes(1, 1)  # row 2, col B
                if ws2:
                    ws2.freeze_panes(1, 0)
            else:  # openpyxl
                ws1 = writer.sheets.get("pivot")
                ws2 = writer.sheets.get("ec2_status")
                if ws1 is not None:
                    ws1.freeze_panes = "B2"
                if ws2 is not None:
                    ws2.freeze_panes = "A2"

        output.seek(0)
        filename = f"yippee_{from_date}_to_{to_date}.xlsx"
        headers = {"Content-Disposition": f"attachment; filename={filename}"}
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )
    except Exception as e:
        return Response(f"❌ Error building XLSX: {e}", media_type="text/plain", status_code=500)


def _format_ec2_status_table(rows: List[dict]) -> pd.DataFrame:
    """
    Shape EC2 rows into the exact table:
    Name, InstanceId, State, OnOff('on'/'off'), InstanceStatus, SystemStatus,
    PublicIP, PrivateIP, LaunchTime_ISO (YYYY-MM-DD), CheckedAt_IST (YYYY-MM-DD)
    """
    df = pd.DataFrame(rows or [])
    if df.empty:
        # return empty frame with expected columns so Excel writer doesn't choke
        return pd.DataFrame(columns=[
            "Name", "InstanceId", "State", "OnOff", "InstanceStatus", "SystemStatus",
            "PublicIP", "PrivateIP", "LaunchTime_ISO", "CheckedAt_IST"
        ])

    # Map OnOff 1/0 -> "on"/"off"
    df["OnOff"] = df.get("OnOff", 0).map({1: "on", 0: "off"}).fillna("off")

    # Resolve statuses from DescribeInstanceStatus (include stopped)
    status_map = {}
    ec2 = boto3.client("ec2", region_name=os.getenv("AWS_REGION", None))
    ids = [i for i in df.get("InstanceId", []).tolist(
    ) if isinstance(i, str) and i.startswith("i-")]
    for i in range(0, len(ids), 100):
        chunk = ids[i:i+100]
        try:
            resp = ec2.describe_instance_status(
                InstanceIds=chunk, IncludeAllInstances=True)
            for st in resp.get("InstanceStatuses", []):
                iid = st.get("InstanceId", "")
                inst_status = (st.get("InstanceStatus", {}) or {}).get(
                    "Status", "not-applicable")
                sys_status = (st.get("SystemStatus", {}) or {}
                              ).get("Status", "not-applicable")
                status_map[iid] = (
                    inst_status or "not-applicable", sys_status or "not-applicable")
        except ClientError as e:
            logging.warning(
                "describe_instance_status failed for %s: %s", chunk, e)

    df["InstanceStatus"] = df["InstanceId"].map(
        lambda x: status_map.get(x, ("not-applicable", "not-applicable"))[0])
    df["SystemStatus"] = df["InstanceId"].map(
        lambda x: status_map.get(x, ("not-applicable", "not-applicable"))[1])

    # LaunchTime -> UTC date string (YYYY-MM-DD), safe for Excel
    def _to_naive_utc(x):
        if isinstance(x, datetime):
            return x.astimezone(timezone.utc).replace(tzinfo=None) if x.tzinfo else x
        return x
    launch_col = "LaunchTime" if "LaunchTime" in df.columns else "LaunchTime_ISO"
    df["LaunchTime_ISO"] = df.get(launch_col, "").apply(_to_naive_utc).apply(
        lambda d: d.strftime("%Y-%m-%d") if isinstance(d,
                                                       datetime) else (str(d) if d else "")
    )

    # CheckedAt_IST = today's IST date
    df["CheckedAt_IST"] = datetime.now(IST_TZ).date().isoformat()

    # Select & order columns
    out = df.reindex(columns=[
        "Name", "InstanceId", "State", "OnOff", "InstanceStatus", "SystemStatus",
        "PublicIP", "PrivateIP", "LaunchTime_ISO", "CheckedAt_IST"
    ])
    # Fill NAs with empty string
    return out.fillna("")


def _export_xlsx_bytes(from_dt_utc: datetime, to_dt_utc: datetime) -> Tuple[bytes, str]:
    # ---- helpers ----
    def _load_df_for_collection(mongo_collection) -> pd.DataFrame:
        mongo_filter = {TIMESTAMP_FIELD: {
            "$gte": from_dt_utc, "$lte": to_dt_utc}}
        projection = {"_id": 0}
        data = list(mongo_collection.find(mongo_filter, projection))
        rows_out = []
        if data:
            for row in data:
                r = dict(row)
                base_ts = _parse_dt(r.get(TIMESTAMP_FIELD))
                r["date"] = ""
                r["hour"] = ""
                r["date-hour"] = ""
                r["ist-date"] = ""
                r["ist-hour"] = ""
                if base_ts is not None:
                    ist_ts = base_ts + IST_OFFSET
                    r["date"] = base_ts.strftime("%d/%m/%Y")
                    r["hour"] = base_ts.strftime("%H")
                    r["date-hour"] = ist_ts.strftime("%Y-%m-%d %H:%M:%S")
                    r["ist-date"] = ist_ts.strftime("%d/%m/%Y")
                    r["ist-hour"] = ist_ts.strftime("%H")
                rows_out.append(r)
            df = pd.DataFrame(rows_out)
        else:
            df = pd.DataFrame(columns=["ist-date", "ist-hour"])

        for col in ["ist-date", "ist-hour", "room_id"]:
            if col not in df.columns:
                df[col] = ""
        if "ist-hour" in df.columns:
            df["ist-hour"] = df["ist-hour"].astype(str)
        return df

    def _build_pivot(df: pd.DataFrame) -> pd.DataFrame:
        hours = [f"{h:02d}" for h in range(24)]
        if df.empty:
            return pd.DataFrame([{"error": "No data in range"}])
        try:
            piv = pd.pivot_table(
                df, index="ist-date", columns="ist-hour",
                values="room_id", aggfunc="count", fill_value=0
            )
            piv = piv.reindex(columns=hours, fill_value=0)

            def _date_key(x):
                try:
                    return datetime.strptime(x, "%d/%m/%Y")
                except Exception:
                    return x
            piv = piv.sort_index(key=lambda idx: [_date_key(x) for x in idx])
            piv["Total"] = piv.sum(axis=1)
            piv.loc["Total"] = piv.sum(numeric_only=True)
            return piv
        except Exception as e:
            return pd.DataFrame([{"error": f"pivot build failed: {e}"}])

    def _slice_last_n_days(piv: pd.DataFrame, n_days: int) -> pd.DataFrame:
        if piv.empty or "error" in piv.columns:
            return piv
        base = piv.copy()
        if "Total" in base.index:
            base = base.drop(index="Total")
        # sort by real date

        def _parse_date_idx(idx: pd.Index) -> list:
            out = []
            for v in idx:
                try:
                    out.append(datetime.strptime(v, "%d/%m/%Y"))
                except Exception:
                    out.append(v)
            return out
        sort_pairs = sorted(zip(_parse_date_idx(base.index),
                            base.index), key=lambda x: x[0])
        keep_labels = [lbl for _, lbl in sort_pairs[-n_days:]]
        section = base.loc[keep_labels].copy()
        hours = [f"{h:02d}" for h in range(24)]
        for h in hours:
            if h not in section.columns:
                section[h] = 0
        section = section.reindex(columns=hours, fill_value=0)
        section["Total"] = section.sum(axis=1)
        section.loc[f"Total ({n_days}d)"] = section.sum(numeric_only=True)
        return section

    # ---- main & yippee pivots ----
    df_main = _load_df_for_collection(collection_df)
    pivot_main_full = _build_pivot(df_main)

    # filename
    filename = (
        f"export_{from_dt_utc.strftime('%Y%m%d_%H%M%S')}_to_{to_dt_utc.strftime('%Y%m%d_%H%M%S')}.xlsx"
        if not df_main.empty
        else f"export_empty_{from_dt_utc.date()}_{to_dt_utc.date()}.xlsx"
    )

    df_yip = _load_df_for_collection(collection_yippee)
    pivot_yip_full = _build_pivot(df_yip)

    # keep full main block as-is; yippee = last 4 IST days
    pivot_main = pivot_main_full.copy()
    pivot_yippee = _slice_last_n_days(pivot_yip_full, 4)

    # ---- combined (DF + Yippee) hour-wise sums per day ----
    def _strip_totals(piv: pd.DataFrame) -> pd.DataFrame:
        if piv.empty or "error" in piv.columns:
            return pd.DataFrame()
        if "Total" in piv.index:
            piv = piv.drop(index="Total")
        hours = [f"{h:02d}" for h in range(24)]
        cols = [c for c in piv.columns if c in hours]
        return piv[cols].copy()

    hours = [f"{h:02d}" for h in range(24)]
    m_hours = _strip_totals(pivot_main_full)
    y_hours = _strip_totals(pivot_yip_full)

    # union of dates
    all_days = sorted(set(m_hours.index) | set(y_hours.index),
                      key=lambda x: datetime.strptime(x, "%d/%m/%Y") if isinstance(x, str) else x)
    combined = pd.DataFrame(0, index=all_days, columns=hours)
    if not m_hours.empty:
        m_aligned = m_hours.reindex(
            index=all_days, columns=hours, fill_value=0)
        combined = combined.add(m_aligned, fill_value=0)
    if not y_hours.empty:
        y_aligned = y_hours.reindex(
            index=all_days, columns=hours, fill_value=0)
        combined = combined.add(y_aligned, fill_value=0)
    # totals
    if not combined.empty:
        combined["Total"] = combined.sum(axis=1)
        combined.loc["Total (COMBINED)"] = combined.sum(numeric_only=True)
    else:
        combined = pd.DataFrame([{"info": "No data to combine"}])

    # ---- Write workbook with headings and blocks ----
    buf = BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        ws_name = "pivot"
        start_row = 0

        # Heading 1
        pd.DataFrame({"Dark fantasy": []}).to_excel(
            writer, sheet_name=ws_name, index=False, header=True, startrow=start_row
        )
        start_row += 1

        # DF block
        pivot_main.to_excel(writer, sheet_name=ws_name, startrow=start_row)
        start_row += (pivot_main.shape[0] + 4)  # leave some space

        # Heading 2
        pd.DataFrame({"Yippee": []}).to_excel(
            writer, sheet_name=ws_name, index=False, header=True, startrow=start_row
        )
        start_row += 1

        # Yippee block
        pivot_yippee.to_excel(writer, sheet_name=ws_name, startrow=start_row)
        start_row += (pivot_yippee.shape[0] + 4)

        # Heading 3
        pd.DataFrame({"Combined (DF + Yippee)": []}).to_excel(
            writer, sheet_name=ws_name, index=False, header=True, startrow=start_row
        )
        start_row += 1

        # Combined block
        combined.to_excel(writer, sheet_name=ws_name, startrow=start_row)

        # EC2 status sheet
        ec2_rows, ec2_err = _get_ec2_status_rows()
        if ec2_err:
            ec2_df = pd.DataFrame([{"error": ec2_err}])
            ec2_sheet_name = "ec2_status_error"
        else:
            ec2_df = _format_ec2_status_table(ec2_rows)
            if not ec2_df.empty:
                ec2_df["__on__"] = (ec2_df["OnOff"] == "on").astype(int)
                ec2_df = ec2_df.sort_values(["__on__", "Name", "InstanceId"], ascending=[
                                            False, True, True]).drop(columns="__on__")
            ec2_sheet_name = "ec2_status"
        ec2_df.to_excel(writer, index=False, sheet_name=ec2_sheet_name)

        # Freeze panes (optional: top headings won’t freeze across all blocks cleanly)
        ws2 = writer.sheets.get(ec2_sheet_name)
        if ws2 is not None:
            ws2.freeze_panes = "A2"

        # Basic formatting for headings (bold) via openpyxl
        ws = writer.sheets.get(ws_name)
        if ws is not None:
            for r in [1,                     # "Dark fantasy"
                      1 + pivot_main.shape[0] + 4 + 1,  # "Yippee"
                      # "Combined"
                      1 + pivot_main.shape[0] + 4 + 1 + pivot_yippee.shape[0] + 4 + 1]:
                try:
                    ws.cell(row=r, column=1).font = ws.cell(
                        row=r, column=1).font.copy(bold=True)
                except Exception:
                    pass

    buf.seek(0)
    return buf.read(), filename


def _send_email_with_attachment(subject: str, body_html: str, attachment_name: str, attachment_bytes: bytes):
    """
    Sends an email with XLSX attachment via SMTP (STARTTLS).
    """
    if not (SMTP_HOST and SMTP_PORT and SMTP_USER and SMTP_PASS and EMAIL_FROM):
        logger.error("Email env vars missing; cannot send export email.")
        return
    if not EMAIL_TO:
        logger.error(
            "EMAIL_TO is empty after parsing. Set EMAIL_TO='a@x.com,b@y.com'.")
        return

    msg = EmailMessage()
    msg["From"] = EMAIL_FROM
    msg["To"] = ", ".join(EMAIL_TO)
    msg["Subject"] = subject
    msg.set_content(
        "This email contains HTML content. Please view in an HTML-capable client.")
    msg.add_alternative(body_html, subtype="html")

    msg.add_attachment(
        attachment_bytes,
        maintype="application",
        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=attachment_name,
    )

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
            # STARTTLS path (most common). If you use port 465, switch to SMTP_SSL.
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(msg)
        logger.info(
            f"SMTP: host={SMTP_HOST}:{SMTP_PORT} as={SMTP_USER} to={EMAIL_TO}")

        logger.info("📧 Export email sent.")
    except Exception as e:
        logger.exception("Failed to send export email")


def _run_export_and_email():
    try:
        # IST-aligned window
        now_ist = datetime.now(IST_TZ)  # use your single pytz timezone object
        to_ist = now_ist.replace(minute=0, second=0, microsecond=0)
        from_ist = to_ist - timedelta(days=3)   # <-- last 3 days

        # Convert IST -> naive UTC for Mongo (if DB stores UTC)
        from_utc = from_ist.astimezone(pytz.utc).replace(tzinfo=None)
        to_utc = to_ist.astimezone(pytz.utc).replace(tzinfo=None)

        xlsx_bytes, fname = _export_xlsx_bytes(from_utc, to_utc)

        subject = f"[Diffrun Admin] Export (IST {from_ist:%Y-%m-%d %H:%M} → {to_ist:%Y-%m-%d %H:%M})"
        body_html = f"""
        <html><body style="font-family: Arial, sans-serif;">
          <p>Attached export for the <b>last 3 days</b> (IST).</p>
          <ul>
            <li><b>Window (IST):</b> {from_ist:%Y-%m-%d %H:%M} → {to_ist:%Y-%m-%d %H:%M}</li>
          </ul>
        </body></html>
        """
        _send_email_with_attachment(subject, body_html, fname, xlsx_bytes)
        logger.info("✅ Scheduled export completed")
    except Exception:
        logger.exception("Scheduled export failed")


@app.get("/debug/scheduler-jobs")
def debug_scheduler_jobs():
    # Shows what jobs are registered and their next run times
    out = []
    for j in scheduler.get_jobs():
        nxt = j.next_run_time
        nxt_ist = nxt.astimezone(IST_TZ).strftime(
            "%Y-%m-%d %H:%M:%S %Z") if nxt else None
        out.append({"id": j.id, "next_run_ist": nxt_ist,
                   "trigger": str(j.trigger)})
    return out


try:
    scheduler.add_job(
        _hourly_reconcile_and_email,
        CronTrigger(minute=0, timezone=IST_TZ),
        id="reconcile_email_hourly",
        replace_existing=True,
        max_instances=1,  # don't overlap runs
        coalesce=True     # skip missed to one
    )
except Exception:
    logger.exception("Failed to register reconcile email hourly job")


@app.post("/debug/run-export-now")
def debug_run_export_now():
    # Manually trigger the XLSX export + email once
    _run_export_and_email()
    return {"status": "ok"}


@app.post("/debug/email-ping")
def debug_email_ping():
    if not EMAIL_TO:
        return {"ok": False, "error": "EMAIL_TO empty"}
    msg = EmailMessage()
    msg["From"] = EMAIL_FROM
    msg["To"] = ", ".join(EMAIL_TO)
    msg["Subject"] = "Ping from Diffrun backend"
    msg.set_content("If you see this, SMTP + routing works.")
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASS)
            refused = s.send_message(msg)
        return {"ok": True, "refused": refused}
    except Exception as e:
        logger.exception("Ping email failed")
        return {"ok": False, "error": str(e)}


def _utc_bounds_for_ist_day(days_ago: int = 6):
    now_ist = datetime.now(IST)
    target_date = (now_ist - timedelta(days=days_ago)).date()
    start_ist = datetime.combine(target_date, datetime.min.time(), tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    return start_ist.astimezone(timezone.utc), end_ist.astimezone(timezone.utc)


@app.get("/debug/feedback-candidates")
def feedback_eligible(days_ago: int = 6, limit: int = 500):
    start_utc, end_utc = _utc_bounds_for_ist_day(days_ago)

    pipeline = [
        {"$match": {
            "feedback_email": {"$ne": True},
            "shipping_option": "bluedart_in_domestic",
            "shipped_at": {"$exists": True, "$ne": None},
        }},
        {"$addFields": {"shipped_dt": {"$toDate": "$shipped_at"}}},
        {"$match": {"shipped_dt": {"$gte": start_utc, "$lt": end_utc}}},
        {"$project": {
            "_id": 0,
            "order_id": 1, "job_id": 1, "email": 1,
            "name": 1, "user_name": 1, "gender": 1, "book_id": 1,
            "shipping_option": 1, "shipped_at": 1, "shipped_dt": 1
        }},
        {"$sort": {"shipped_dt": 1, "order_id": 1}},
        {"$limit": int(limit)}
    ]

    items = list(orders_collection.aggregate(pipeline))
    return {
        "ist_target_day": str((datetime.now(IST) - timedelta(days=days_ago)).date()),
        "utc_bounds": [start_utc.isoformat(), end_utc.isoformat()],
        "count": len(items),
        "candidates": items
    }


@app.post("/cron/feedback-emails")
def cron_feedback_emails(limit: int = 200):
    pipeline = [
        {
            "$match": {
                "feedback_email": {"$ne": True},
                "shipping_option": "bluedart_in_domestic",
                "shipped_at": {"$exists": True, "$ne": None},
                "$or": [
                    {"discount_code": {"$exists": False}},
                    {"discount_code": {"$ne": "TEST"}}
                ],
            }
        },
        {"$addFields": {"shipped_dt": {"$toDate": "$shipped_at"}}},
        {
            "$match": {
                "$expr": {
                    "$and": [
                        {
                            "$gte": [
                                {
                                    "$dateDiff": {
                                        "startDate": "$shipped_dt",
                                        "endDate": "$$NOW",
                                        "unit": "day",
                                        "timezone": "Asia/Kolkata",
                                    }
                                },
                                10,
                            ]
                        },
                        {
                            "$lt": [
                                {
                                    "$dateDiff": {
                                        "startDate": "$shipped_dt",
                                        "endDate": "$$NOW",
                                        "unit": "day",
                                        "timezone": "Asia/Kolkata",
                                    }
                                },
                                11,
                            ]
                        },
                    ]
                }
            }
        },
        {
            "$project": {
                "_id": 0,
                "order_id": 1,
                "job_id": 1,
                "email": 1,
                "name": 1,
                "user_name": 1,
                "gender": 1,
                "book_id": 1,
                "shipping_option": 1,
                "discount_code": 1,
                "shipped_at": 1,
                "shipped_dt": 1,
            }
        },
        {"$sort": {"shipped_dt": 1, "order_id": 1}},
        {"$limit": int(limit)},
    ]

    candidates = list(orders_collection.aggregate(pipeline))

    results = {"total": len(candidates), "sent": 0,
               "skipped": 0, "errors": 0, "details": []}
    for c in candidates:
        job_id = c.get("job_id")
        email = c.get("email")
        if not job_id or not email:
            results["skipped"] += 1
            results["details"].append(
                {
                    "job_id": job_id,
                    "order_id": c.get("order_id"),
                    "status": "skipped",
                    "reason": "missing job_id or email",
                }
            )
            continue

        try:
            send_feedback_email(job_id, BackgroundTasks())
            results["sent"] += 1
            results["details"].append(
                {
                    "job_id": job_id,
                    "order_id": c.get("order_id"),
                    "status": "sent",
                    "email": email,
                }
            )
        except Exception as e:
            results["errors"] += 1
            results["details"].append(
                {
                    "job_id": job_id,
                    "order_id": c.get("order_id"),
                    "status": "error",
                    "error": str(e),
                }
            )

    return results


def run_feedback_emails_job():
    try:
        cron_feedback_emails(limit=200)
    except Exception:
        logger.exception("Error running feedback emails job")


@app.get("/orders/meta/by-job/{job_id}")
def order_meta_by_job(job_id: str):
    doc = orders_collection.find_one(
        {"job_id": job_id},
        {"_id": 0, "book_id": 1, "book_style": 1}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    # normalize keys if you want
    return {
        "book_id": doc.get("book_id"),
        "book_style": doc.get("book_style")
    }


@app.post("/reconcile/mark")
def mark_reconciled(payload: dict):
    job_id = payload.get("job_id")
    razorpay_payment_id = payload.get(
        "razorpay_payment_id")  # optional, nice to store

    if not job_id:
        raise HTTPException(status_code=400, detail="job_id is required")

    now = datetime.now(timezone.utc)
    update = {
        "reconcile": True,
        "reconciled_at": now,
    }
    if razorpay_payment_id:
        # doesn’t overwrite your verify logic—just stores it if you want
        update["transaction_id"] = razorpay_payment_id

    result = orders_collection.update_one(
        {"job_id": job_id},
        {"$set": update}
    )

    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="job_id not found")

    return {"ok": True, "matched": result.matched_count, "modified": result.modified_count}


@app.post("/debug/run-reconcile-now")
def debug_run_reconcile_now():
    _hourly_reconcile_and_email()
    return {"ok": True}




def _iso(dt: Any) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.isoformat()
    if isinstance(dt, str):
        return dt
    try:
        return datetime.fromtimestamp(dt).isoformat()
    except Exception:
        return str(dt)


def _first_non_empty(d: Dict[str, Any], keys: List[str], default=None):
    for k in keys:
        val = d.get(k)
        if val not in (None, "", []):
            return val
    return default


def _pick_image_list(doc: Dict[str, Any]) -> List[str]:

    candidate_keys = [
        "saved_files",
    ]

    # helper to normalize a value to a list of basenames
    def _norm(x: Any) -> List[str]:
        if isinstance(x, list):
            items = x
        elif isinstance(x, str) and x.strip():
            items = [x.strip()]
        else:
            return []
        # keep basenames (in case a full path/key was stored)
        return [os.path.basename(s) for s in items if isinstance(s, str) and s.strip()]

    # 1) check keys at the root
    for key in candidate_keys:
        v = doc.get(key)
        lst = _norm(v)
        if lst:
            return lst[:3]

    # 2) check nested under "child" if present
    child = doc.get("child")
    if isinstance(child, dict):
        for key in candidate_keys:
            v = child.get(key)
            lst = _norm(v)
            if lst:
                return lst[:3]

    return []


def _build_order_response(order: Dict[str, Any]) -> Dict[str, Any]:
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    job_id = _first_non_empty(order, ["job_id", "JobId", "jobID"], default="")

    user_doc = {}
    if job_id:
        user_doc = orders_collection.find_one({"job_id": job_id}) or {}

    child_name = _first_non_empty(
        order, ["name"],   default=_first_non_empty(user_doc, ["name"]))
    child_age = _first_non_empty(
        order, ["age"],    default=_first_non_empty(user_doc, ["age"]))
    child_gender = _first_non_empty(
        order, ["gender"], default=_first_non_empty(user_doc, ["gender"]))

    saved_files = _pick_image_list(order) or _pick_image_list(user_doc)

    saved_file_urls: list[str] = []
    if saved_files:
        saved_file_urls = _presigned_urls_for_saved_files(
            saved_files, expires_in=3600)

    book_id = _first_non_empty(
        order, ["book_id"], default=_first_non_empty(user_doc, ["book_id"])) or ""
    is_twin = _is_twin_book(book_id)

    child1_age = _first_non_empty(
        order, ["child1_age"], default=_first_non_empty(user_doc, ["child1_age"]))
    child2_age = _first_non_empty(
        order, ["child2_age"], default=_first_non_empty(user_doc, ["child2_age"]))

    child1_files = _coerce_list(order.get(
        "child1_image_filenames") or user_doc.get("child1_image_filenames"))[:3]
    child2_files = _coerce_list(order.get(
        "child2_image_filenames") or user_doc.get("child2_image_filenames"))[:3]

    child1_input_urls: list[str] = _presigned_urls_for_saved_files(
        child1_files, expires_in=3600) if child1_files else []
    child2_input_urls: list[str] = _presigned_urls_for_saved_files(
        child2_files, expires_in=3600) if child2_files else []

    child_details = {
        "name": (child_name or ""),
        "age":  (child_age or ""),
        "gender": (child_gender or "").lower(),
        "saved_files": saved_files[:3],
        "saved_file_urls": saved_file_urls,
        "is_twin": bool(is_twin),
        "child1_age": child1_age if child1_age not in (None, "") else None,
        "child2_age": child2_age if is_twin and child2_age not in (None, "") else None,
        # as stored in DB (for traceability)
        "child1_image_filenames": child1_files,
        "child2_image_filenames": child2_files,
        # presigned URLs from replicacomfy/input/<filename>
        "child1_input_images": child1_input_urls,
        "child2_input_images": child2_input_urls,
    }

    # customer details
    customer_email = _first_non_empty(
        order, ["email", "customer_email", "paypal_email"], default="")
    ship = order.get("shipping_address", {}) or {}
    phone_number = _first_non_empty(
        order, ["phone_number", "phone"], default=_first_non_empty(ship, ["phone"], default=""))
    customer_details = {
        "user_name": order.get("user_name", ""),
        "email": customer_email or "",
        "phone_number": phone_number or "",
    }

    cover_url_from_gen = _find_cover_image_url_from_generations(
        job_id, expires_in=3600)

    # order financials/ids
    order_details = {
        "order_id": order.get("order_id", ""),
        "discount_code": order.get("discount_code", ""),
        "total_price": _first_non_empty(order, ["total_price", "amount", "total"], default=""),
        "transaction_id": _first_non_empty(order, ["transaction_id", "razorpay_payment_id", "payment_id"], default=""),
        "cover_url": order.get("cover_url", ""),
        "book_url": order.get("book_url", ""),
        "paypal_capture_id": order.get("paypal_capture_id", ""),
        "paypal_order_id": order.get("paypal_order_id", ""),
        "cover_image": cover_url_from_gen or "",
        "tracking_code": order.get("tracking_code")
    }

    # timeline
    timeline = {
        "created_at": _iso(order.get("created_at")),
        "processed_at": _iso(order.get("processed_at")),
        "approved_at": _iso(order.get("approved_at")),
        "print_sent_at": _iso(order.get("print_sent_at")),
        "shipped_at": _iso(order.get("shipped_at")),
    }

    # base legacy fields (preserved)
    response = {
        "order_id": order.get("order_id", ""),
        "name": order.get("name", ""),
        "book_id": order.get("book_id", ""),
        "book_style": order.get("book_style", ""),
        "preview_url": order.get("preview_url", ""),
        "gender": order.get("gender", ""),
        "user_name": order.get("user_name", ""),
        "email": order.get("email", ""),
        "discount_code": order.get("discount_code", ""),
        "quantity": order.get("quantity", 1),
        "phone": order.get("phone_number"),
        "shipping_address": {
            "address1": ship.get("address1", "") or "",
            "address2": ship.get("address2", "") or "",
            "city": ship.get("city", "") or "",
            "state": ship.get("province", "") or "",
            "country": ship.get("country", "") or "",
            "zip": ship.get("zip", "") or "",
            "phone": ship.get("phone", "") or "",
        },
    }

    # enrich
    response.update({
        "job_id": job_id,
        "book_style": order.get("book_style", ""),
        "book_id": order.get("book_id", ""),
        "preview_url": order.get("preview_url", ""),
        "locale": order.get("locale", ""),
        "child": child_details,
        "customer": customer_details,
        "order": order_details,
        "timeline": timeline,
    })
    return response


@app.get("/orders/{order_id}")
def get_order_detail(order_id: str):
    order = orders_collection.find_one({"order_id": order_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return _build_order_response(order)


class ShippingAddressUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    address1: Optional[str] = None        
    address2: Optional[str] = None       
    city:   Optional[str] = None
    state:  Optional[str] = None
    country: Optional[str] = None
    zip:    Optional[str] = Field(None, alias="postal_code")


class TimelineUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    created_at:    Optional[str] = None
    processed_at:  Optional[str] = None
    approved_at:   Optional[str] = None
    print_sent_at: Optional[str] = None
    shipped_at:    Optional[str] = None


class OrderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name:   Optional[str] = None
    age:    Optional[Union[str, int]] = None
    gender: Optional[str] = None
    book_id:        Optional[str] = None
    job_id:         Optional[str] = None
    locale:        Optional[str] = None
    book_style:     Optional[str] = None
    discount_code:  Optional[str] = None
    quantity:       Optional[int] = None
    preview_url:    Optional[str] = None
    total_price:        Optional[Union[str, float, int]] = None
    transaction_id:     Optional[str] = None
    paypal_capture_id:  Optional[str] = None
    paypal_order_id:    Optional[str] = None
    cover_url:          Optional[str] = None
    book_url:           Optional[str] = None
    user_name: Optional[str] = None
    email:     Optional[EmailStr] = None
    phone:     Optional[str] = None
    cust_status: Optional[str] = None
    shipping_address: Optional[ShippingAddressUpdate] = None
    timeline:         Optional[TimelineUpdate] = None
    order_id: Optional[str] = None
    tracking_code: Optional[str] = None


IMMUTABLE_PATHS = {
    "saved_files",
    "child.saved_files",
    "child.saved_file_urls",
    "child.child1_input_images",
    "child.child2_input_images",
    "child.child1_image_filenames",
    "child.child2_image_filenames",
    "cover_image",
    "order.cover_image",
}


def _is_forbidden(path: str) -> bool:
    return any(path == p or path.startswith(p + ".") for p in IMMUTABLE_PATHS)


@app.patch("/orders/{order_id}")
def patch_order(order_id: str, update: OrderUpdate):
    payload = update.model_dump(exclude_unset=True, by_alias=True)

    set_ops: dict[str, object] = {}

    if "shipping_address" in payload and payload["shipping_address"]:
        for sk, sv in payload["shipping_address"].items():
            if sv is not None:
                path = f"shipping_address.{sk}"
                if _is_forbidden(path):
                    raise HTTPException(
                        status_code=400, detail=f"Field '{path}' is not editable")
                set_ops[path] = sv

    if "timeline" in payload and payload["timeline"]:
        for tk, tv in payload["timeline"].items():
            if tv is not None:
                path = tk
                if _is_forbidden(path):
                    raise HTTPException(
                        status_code=400, detail=f"Field '{path}' is not editable")
                set_ops[path] = tv

    field_map = {
        "name": "name",
        "age": "age",
        "gender": "gender",
        "book_id": "book_id",
        "book_style": "book_style",
        "discount_code": "discount_code",
        "quantity": "quantity",
        "preview_url": "preview_url",
        "total_price": "total_price",
        "transaction_id": "transaction_id",
        "paypal_capture_id": "paypal_capture_id",
        "paypal_order_id": "paypal_order_id",
        "cover_url": "cover_url",
        "book_url": "book_url",
        "user_name": "user_name",
        "email": "email",
        "phone": "phone_number",
        "cust_status": "cust_status",
        "order_id": "order_id",
        "tracking_code": "tracking_code"
    }

    for incoming, doc_path in field_map.items():
        if incoming in payload and payload[incoming] is not None:
            if _is_forbidden(doc_path):
                raise HTTPException(
                    status_code=400, detail=f"Field '{doc_path}' is not editable")
            set_ops[doc_path] = payload[incoming]

    if not set_ops:
        existing = orders_collection.find_one({"order_id": order_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Order not found")
        return {"updated": False, "order": _build_order_response(existing)}

    res = orders_collection.update_one(
        {"order_id": order_id}, {"$set": set_ops})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Order not found")

    updated = orders_collection.find_one({"order_id": order_id})
    return {"updated": bool(res.modified_count), "order": _build_order_response(updated)}


def _get_s3_client() -> Tuple[boto3.client, str]:
    bucket = os.getenv("REPLICACOMFY_BUCKET", "").strip()
    region = os.getenv("AWS_REGION", "").strip()
    access_key = os.getenv("AWS_ACCESS_KEY_ID", "").strip()
    secret_key = os.getenv("AWS_SECRET_ACCESS_KEY", "").strip()

    if not bucket:
        raise HTTPException(
            status_code=500, detail="REPLICACOMFY_BUCKET not configured")
    if not region:
        raise HTTPException(
            status_code=500, detail="AWS_REGION not configured")
    if not access_key or not secret_key:
        raise HTTPException(
            status_code=500, detail="AWS credentials not configured")

    cfg = Config(signature_version="s3v4", region_name=region,
                 retries={"max_attempts": 3, "mode": "standard"})
    s3 = boto3.client(
        "s3",
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=cfg,
    )
    return s3, bucket


def _s3_key_for_input(filename: str) -> str:
    base = os.path.basename(filename).strip()
    return f"input/{base}"


def _generate_presigned_url(s3, bucket: str, key: str, expires_in: int = 3600) -> str:
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expires_in,
    )


def _presigned_urls_for_saved_files(files: List[str], expires_in: int = 3600) -> List[str]:
    if not files:
        return []
    try:
        s3, bucket = _get_s3_client()
    except HTTPException:
        raise

    urls: List[str] = []
    for f in files[:3]:
        key = _s3_key_for_input(f)
        try:
            # Verify the object exists before signing
            s3.head_object(Bucket=bucket, Key=key)
            urls.append(_generate_presigned_url(
                s3, bucket, key, expires_in=expires_in))
        except NoCredentialsError:
            raise HTTPException(
                status_code=500, detail="AWS credentials not available")
        except PartialCredentialsError:
            raise HTTPException(
                status_code=500, detail="AWS credentials are incomplete")
        except ClientError as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey", "NotFound", "AccessDenied"):
                # Skip silently—don’t break the whole order response
                continue
            raise HTTPException(
                status_code=502, detail="S3 error while generating image URLs")
        except Exception:
            raise HTTPException(
                status_code=502, detail="Unexpected error while generating image URLs")
    return urls


def _get_s3_client_generic() -> boto3.client:
    region = (os.getenv("AWS_REGION") or "").strip()
    access = (os.getenv("AWS_ACCESS_KEY_ID") or "").strip()
    secret = (os.getenv("AWS_SECRET_ACCESS_KEY") or "").strip()
    if not region or not access or not secret:
        raise HTTPException(
            status_code=500, detail="AWS credentials/region not configured")

    return boto3.client(
        "s3",
        region_name=region,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        # force regional endpoint
        endpoint_url=f"https://s3.{region}.amazonaws.com",
        config=Config(
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "standard"},
            s3={"addressing_style": "virtual"}  # virtual-hosted–style URLs
        ),
    )


def _list_objects_with_prefix(s3, bucket: str, prefix: str, max_collect: int = 1000) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    token: Optional[str] = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        out.extend(resp.get("Contents", []) or [])
        if not resp.get("IsTruncated") or len(out) >= max_collect:
            break
        token = resp.get("NextContinuationToken")
    return out


def _find_cover_image_url_from_generations(job_id: str, expires_in: int = 3600) -> Optional[str]:
    bucket = (os.getenv("DIFFRUN_GENERATIONS_BUCKET") or "").strip()
    if not bucket or not job_id:
        return None

    s3 = _get_s3_client_generic()
    prefix = f"jpg_output/{job_id}_pg0_"

    try:
        objs = _list_objects_with_prefix(s3, bucket, prefix, max_collect=2000)
    except ClientError:
        return None

    if not objs:
        return None

    preferred = [o for o in objs if str(
        o.get("Key", "")).lower().endswith("_001.jpg")]
    chosen = min(preferred or objs, key=lambda o: o.get("LastModified"))

    try:
        return s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": bucket,
                "Key": chosen["Key"],
                # Force browser-friendly headers for inline display
                "ResponseContentType": "image/jpeg",
                "ResponseContentDisposition": "inline",
            },
            ExpiresIn=expires_in,
        )
    except ClientError:
        return None


def _is_twin_book(book_id: str) -> bool:
    b = (book_id or "").strip().lower()
    # Adjust the identifiers below to your catalog if needed
    return any(k in b for k in ("twin", "bb", "bg", "gg", "twin_boy_girl", "twin_girl_girl", "twin_boy_boy"))


def _get_child_age(order: Dict[str, Any], idx: int) -> Optional[Union[int, str]]:

    if idx == 1:
        for key in ("child1_age", "age", "child_age", "kid_age"):
            v = order.get(key)
            if v not in (None, ""):
                return v
    if idx == 2:
        v = order.get("child2_age")
        if v not in (None, ""):
            return v

    # nested dicts commonly used
    child_key = f"child{idx}"
    v = (order.get(child_key) or {}).get("age")
    if v not in (None, ""):
        return v

    # array style: children[0], children[1]
    children = order.get("children") or order.get("kids") or []
    if isinstance(children, list) and len(children) >= idx:
        v = (children[idx - 1] or {}).get("age")
        if v not in (None, ""):
            return v

    return None


def _coerce_list(v: Any) -> List[str]:
    if not v:
        return []
    if isinstance(v, list):
        return [str(x) for x in v if x is not None and str(x).strip()]
    return [str(v)]


# JOB_ID Detail API
@app.get("/jobs/{job_id}/mini")
def get_job_mini(job_id: str) -> Dict[str, Any]:
    order = orders_collection.find_one({"job_id": job_id})
    if not order:
        raise HTTPException(status_code=404, detail="Job not found")

    email = _first_non_empty(
        order, ["email", "customer_email", "paypal_email"], default="")
    book_id = order.get("book_id", "") or ""
    is_twin = _is_twin_book(book_id)

    preview_url = (
        order.get("preview_url")
        or ""
    )

    saved_files = _pick_image_list(order)
    input_image_urls = _presigned_urls_for_saved_files(
        saved_files, expires_in=3600) if saved_files else []

    child1_filenames = order.get("child1_image_filenames") or []
    child2_filenames = order.get("child2_image_filenames") or []

    if not isinstance(child1_filenames, list):
        child1_filenames = [child1_filenames]
    if not isinstance(child2_filenames, list):
        child2_filenames = [child2_filenames]
    child1_filenames = [str(x).strip()
                        for x in child1_filenames if str(x).strip()][:3]
    child2_filenames = [str(x).strip()
                        for x in child2_filenames if str(x).strip()][:3]

    child1_input_images = _presigned_urls_for_saved_files(
        child1_filenames, expires_in=3600) if child1_filenames else []
    child2_input_images = _presigned_urls_for_saved_files(
        child2_filenames, expires_in=3600) if child2_filenames else []

    return {
        "job_id": job_id,
        "name": order.get("name", ""),
        "gender": (order.get("gender", "") or "").lower(),
        "age": order.get("age", ""),
        "email": email,
        "created_at": _iso(order.get("created_at")),
        "book_id": book_id,
        "preview_url": preview_url,
        "partial_preview": order.get("partial_preview", ""),
        "final_preview": order.get("final_preview", ""),
        "input_images": input_image_urls,
        "paid": bool(order.get("paid", False)),
        "approved": bool(order.get("approved", False)),
        "child1_age": _get_child_age(order, 1),
        "child2_age": _get_child_age(order, 2) if is_twin else None,
        "child1_image_filenames": child1_filenames,
        "child2_image_filenames": child2_filenames,
        "child1_input_images": child1_input_images,
        "child2_input_images": child2_input_images,
        "is_twin": is_twin,
    }


# ===================== Shiprocket: create from order collection =====================

from fastapi import Body
from typing import Dict, Any

SHIPROCKET_BASE = os.getenv("SHIPROCKET_BASE", "https://apiv2.shiprocket.in").rstrip("/")
SHIPROCKET_EMAIL = os.getenv("SHIPROCKET_EMAIL")
SHIPROCKET_PASSWORD = os.getenv("SHIPROCKET_PASSWORD")
SHIPROCKET_DEFAULT_PICKUP = os.getenv("SHIPROCKET_DEFAULT_PICKUP", "warehouse")

def _sr_login_token() -> str:
    if not SHIPROCKET_EMAIL or not SHIPROCKET_PASSWORD:
        raise HTTPException(status_code=500, detail="Shiprocket API creds missing")
    r = requests.post(
        f"{SHIPROCKET_BASE}/v1/external/auth/login",
        json={"email": SHIPROCKET_EMAIL, "password": SHIPROCKET_PASSWORD},
        timeout=30,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Shiprocket auth failed: {r.text}")
    token = (r.json() or {}).get("token")
    if not token:
        raise HTTPException(status_code=502, detail="Shiprocket auth returned no token")
    return token

def _sr_headers(tok: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}

def _sr_order_payload_from_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    ship = doc.get("shipping_address") or {}
    # name split (helper exists earlier in this file)
    first, last = split_full_name(ship.get("name", "") or (doc.get("user_name") or doc.get("name") or ""))

    # price/qty
    qty = int(doc.get("quantity", 1) or 1)
    subtotal = float(
        doc.get("total_amount")
        or doc.get("total_price")
        or doc.get("amount")
        or doc.get("price")
        or 0.0
    )

        # package: apply dimensions by book_id
    book_id = (doc.get("book_id") or "").lower().strip()

    if book_id == "wigu":
        length, breadth, height = 32.0, 23.0, 3.0
    else:
        length, breadth, height = 23.0, 23.0, 3.0

    weight = float(doc.get("weight_kg", 0.5))


    # book identity for item line
    order_id=(doc.get("order_id"))
    book_id = (doc.get("book_id") or "BOOK").upper()
    book_style = (doc.get("book_style") or "HARDCOVER").upper()

    # order date "YYYY-MM-DD HH:MM" (IST)
    dt = doc.get("processed_at") or doc.get("created_at")
    try:
        if isinstance(dt, str):
            dt = parser.isoparse(dt)
        if isinstance(dt, datetime) and dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        order_date = (dt or datetime.now(timezone.utc)).astimezone(IST_TZ).strftime("%Y-%m-%d %H:%M")
    except Exception:
        order_date = datetime.now(IST_TZ).strftime("%Y-%m-%d %H:%M")

    pickup_name = doc.get("pickup_location") or SHIPROCKET_DEFAULT_PICKUP
    if not pickup_name:
        raise HTTPException(status_code=400, detail="Shiprocket pickup_location not configured")

    # payment
    cod = bool(doc.get("payment_method") == "COD")

    return {
        "order_id": str(doc.get("order_id") or ""),                           # your reference
        "order_date": order_date,
        "pickup_location": pickup_name,
        "comment": doc.get("comment", ""),

        "billing_customer_name": first or ship.get("name", "") or "Customer",
        "billing_last_name": last,
        "billing_address": ship.get("address1", ""),
        "billing_address_2": ship.get("address2", ""),
        "billing_city": ship.get("city", ""),
        "billing_pincode": str(ship.get("zip", ""))[:6],
        "billing_state": ship.get("province", ""),
        "billing_country": ship.get("country", "India"),
        "billing_email": (doc.get("email") or doc.get("customer_email") or ""),
        "billing_phone": ship.get("phone") or doc.get("phone_number") or "",

        "shipping_is_billing": True,
        "shipping_customer_name": "",
        "shipping_last_name": "",
        "shipping_address": "",
        "shipping_address_2": "",
        "shipping_city": "",
        "shipping_pincode": "",
        "shipping_country": "",
        "shipping_state": "",
        "shipping_email": "",
        "shipping_phone": "",

        "order_items": [
            {
                "name": f"Personalised {book_id} ({book_style})",
                "sku": f"{order_id}",
                "units": qty,
                "selling_price": float(round(subtotal / max(qty, 1), 2)),
                "discount": 0,
                "tax": 0,
                "hsn": ""
            }
        ],
        "payment_method": "COD" if cod else "Prepaid",
        "shipping_charges": 0,
        "giftwrap_charges": 0,
        "transaction_charges": 0,
        "total_discount": 0,
        "sub_total": float(subtotal),

        "length": length,
        "breadth": breadth,
        "height": height,
        "weight": weight,
    }

@app.post("/shiprocket/create-from-orders", tags=["shiprocket"])
def shiprocket_create_from_orders(
    order_ids: List[str] = Body(..., embed=True, description="Diffrun order_ids like ['#123', '#124']"),
    assign_awb: bool = Body(False, embed=True, description="If true, assign AWB after creating order"),
    request_pickup: bool = Body(False, embed=True, description="If true, generate pickup after AWB assignment"),
):
    """
    Creates Shiprocket orders for the provided order_ids (reads delivery details from Mongo),
    optionally assigns AWB and requests pickup. By default this WILL ONLY create orders.
    """
    if not order_ids:
        raise HTTPException(status_code=400, detail="order_ids required")

    # dedupe, preserve order
    seen, unique_ids = set(), []
    for oid in order_ids:
        if oid not in seen:
            seen.add(oid)
            unique_ids.append(oid)

    token = _sr_login_token()
    headers = _sr_headers(token)

    created_refs: List[Dict[str, Any]] = []
    shipment_ids: List[int] = []
    errors: List[str] = []

    # 1) Create orders only
    for oid in unique_ids:
        doc = orders_collection.find_one({"order_id": oid})
        if not doc:
            errors.append(f"{oid}: not found")
            continue

        try:
            payload = _sr_order_payload_from_doc(doc)
            r = requests.post(
                f"{SHIPROCKET_BASE}/v1/external/orders/create/adhoc",
                headers=headers, json=payload, timeout=40
            )
            if r.status_code != 200:
                errors.append(f"{oid}: create failed {r.status_code} {r.text}")
                continue

            j = r.json() or {}
            sr_order_id = j.get("order_id")
            shipment_id = j.get("shipment_id")

            # Persist SR ids so you can later call AWB/pickup manually if needed
            orders_collection.update_one(
                {"_id": doc["_id"]},
                {"$set": {
                    "sr_order_id": sr_order_id,
                    "sr_shipment_id": shipment_id,
                    "shiprocket_created_at": datetime.utcnow().isoformat(),
                    "shiprocket_pickup_location": payload.get("pickup_location")
                }}
            )

            created_refs.append({"order_id": oid, "sr_order_id": sr_order_id, "shipment_id": shipment_id})
            if shipment_id:
                # keep shipment ids for later steps only if user asked for AWB/pickup
                shipment_ids.append(int(shipment_id))
        except Exception as e:
            errors.append(f"{oid}: exception {e}")

    # If caller didn't request AWB, stop here (this keeps orders unassigned)
    if not assign_awb:
        return {"created": created_refs, "awbs": [], "pickup": None, "errors": errors}

    # 2) Assign AWB (only if assign_awb == True)
    awb_results: List[Dict[str, Any]] = []
    for sid in shipment_ids:
        try:
            rr = requests.post(
                f"{SHIPROCKET_BASE}/v1/external/courier/assign/awb",
                headers=headers, json={"shipment_id": sid}, timeout=30
            )
            if rr.status_code != 200:
                errors.append(f"awb({sid}) failed {rr.status_code}: {rr.text}")
                continue
            j = rr.json() or {}
            awb_code = j.get("awb_code")
            courier_id = j.get("courier_company_id")
            awb_results.append({"shipment_id": sid, "awb_code": awb_code, "courier_company_id": courier_id})

            orders_collection.update_one({"sr_shipment_id": sid}, {"$set": {"awb_code": awb_code, "courier_company_id": courier_id}})
        except Exception as e:
            errors.append(f"awb({sid}): exception {e}")

    # 3) Generate pickup (only if request_pickup == True)
    pickup_res = None
    if request_pickup and awb_results:
        try:
            rr = requests.post(
                f"{SHIPROCKET_BASE}/v1/external/courier/generate/pickup",
                headers=headers,
                json={"shipment_id": [x["shipment_id"] for x in awb_results]},
                timeout=30
            )
            if rr.status_code == 200:
                pickup_res = rr.json()
                orders_collection.update_many(
                    {"sr_shipment_id": {"$in": [x["shipment_id"] for x in awb_results]}},
                    {"$set": {"pickup_requested": True, "pickup_requested_at": datetime.utcnow().isoformat()}}
                )
            else:
                errors.append(f"pickup failed {rr.status_code}: {rr.text}")
        except Exception as e:
            errors.append(f"pickup: exception {e}")

    return {"created": created_refs, "awbs": awb_results, "pickup": pickup_res, "errors": errors}
