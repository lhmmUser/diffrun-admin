# app/routers/shiprocket_webhook.py
import os
import logging
from datetime import datetime, timezone
from typing import List, Optional, Union
from .cloudprinter_webhook import _send_tracking_email
import requests

from dotenv import load_dotenv, find_dotenv
load_dotenv(find_dotenv(), override=False)

from fastapi import APIRouter, Request, Response, BackgroundTasks
from pydantic import BaseModel, Field, ConfigDict
from pymongo import MongoClient

router = APIRouter()

EXPECTED_TOKEN = (os.getenv("SHIPROCKET_WEBHOOK_TOKEN") or "").strip()
MONGO_URI = os.getenv("MONGO_URI")
client = MongoClient(MONGO_URI, tz_aware=True)
db = client["candyman"]
orders_collection = db["shipping_details"]

class Scan(BaseModel):
    model_config = ConfigDict(extra="allow")
    date: Optional[str] = None
    status: Optional[str] = None
    activity: Optional[str] = None
    location: Optional[str] = None
    sr_status: Optional[Union[str, int]] = Field(default=None, alias="sr-status")
    sr_status_label: Optional[str] = Field(default=None, alias="sr-status-label")

class ShiprocketEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    awb: Optional[str] = None
    courier_name: Optional[str] = None
    current_status: Optional[str] = None
    current_status_id: Optional[int] = None
    shipment_status: Optional[str] = None
    shipment_status_id: Optional[int] = None
    current_timestamp: Optional[str] = None
    order_id: Optional[str] = None
    sr_order_id: Optional[int] = None
    awb_assigned_date: Optional[str] = None
    pickup_scheduled_date: Optional[str] = None
    etd: Optional[str] = None
    scans: Optional[List[Scan]] = None
    is_return: Optional[int] = None
    channel_id: Optional[int] = None
    pod_status: Optional[str] = None
    pod: Optional[str] = None

SHIPROCKET_TRACKING_URL_TEMPLATE = "https://shiprocket.co/tracking/{tracking}"

def _parse_ts(ts: Optional[str]) -> Optional[str]:
    if not ts:
        return None
    try:
        # example format: "11 12 2025 10:16:55"
        return datetime.strptime(ts, "%d %m %Y %H:%M:%S").isoformat()
    except Exception:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).isoformat()
        except Exception:
            return None

def _dedupe_key(ev: ShiprocketEvent) -> str:
    base = f"{ev.awb or ''}|{ev.current_status_id or ''}|{ev.current_timestamp or ''}"
    import hashlib
    return hashlib.sha256(base.encode()).hexdigest()

_seen: set[str] = set()

def _upsert_tracking(e: ShiprocketEvent, raw: dict) -> None:
    q = {"order_id": e.order_id} if e.order_id else {"awb_code": e.awb}
    update = {
        "$set": {
            "shiprocket_data": {
                "awb": e.awb,
                "courier_name": e.courier_name,
                "current_status": e.current_status,
                "current_status_id": e.current_status_id,
                "shipment_status": e.shipment_status,
                "shipment_status_id": e.shipment_status_id,
                "current_timestamp_iso": _parse_ts(e.current_timestamp),
                "current_timestamp_raw": e.current_timestamp,
                "sr_order_id": e.sr_order_id,
                "pod_status": e.pod_status,
                "pod": e.pod,
                "last_update_utc": datetime.now(timezone.utc),
                "scans": [s.model_dump(by_alias=True) for s in (e.scans or [])],
                "raw": raw,
            },
            "tracking_number": e.awb or raw.get("tracking") or "",
            "courier_partner": e.courier_name or "",
            "delivery_status": "shipped" if (e.current_status or "").upper() in {"DELIVERED", "RTO DELIVERED"} else None,
        }
    }
    if update["$set"]["delivery_status"] is None:
        update["$set"].pop("delivery_status", None)
    orders_collection.update_one(q, update, upsert=False)


def _latest_scan(scans: List[dict]) -> Optional[dict]:
    """Return the most recent scan object from scans.
    Attempts to use 'date' when possible; falls back to last element.
    """
    if not scans:
        return None

    # If any scan has a parsable datetime, use the max by parsed time
    parsed = []
    for s in scans:
        date_str = s.get("date") or ""
        parsed_dt = None
        if date_str:
            # try multiple possible formats, keep None on failure
            for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%d-%m-%Y %H:%M:%S", "%d %m %Y %H:%M:%S"):
                try:
                    # handle naive ISO without tz
                    parsed_dt = datetime.strptime(date_str, fmt)
                    break
                except Exception:
                    continue
            # try fromisoformat as a last resort
            if parsed_dt is None:
                try:
                    parsed_dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                except Exception:
                    parsed_dt = None
        parsed.append((parsed_dt, s))

    # If at least one parsed datetime found, pick the max
    parsed_with_dt = [p for p in parsed if p[0] is not None]
    if parsed_with_dt:
        parsed_with_dt.sort(key=lambda x: x[0])
        return parsed_with_dt[-1][1]

    # Otherwise, fallback to last element in list
    try:
        return scans[-1]
    except Exception:
        return None


@router.post("/api/webhook/Genesis")
@router.post("/api/webhook/Genesis/")
async def shiprocket_tracking(request: Request, background: BackgroundTasks) -> Response:
    try:
        if EXPECTED_TOKEN:
            token = request.headers.get("x-api-key")
            if not token or token.strip() != EXPECTED_TOKEN:
                logging.warning("[SR WH] token mismatch; ignoring payload")
                return Response(status_code=200)

        ct = (request.headers.get("content-type") or "").lower()
        if not ct.startswith("application/json"):
            return Response(status_code=200)

        raw = await request.json()
        logging.info(f"[SR WH] payload: {raw}")
        event = ShiprocketEvent.model_validate(raw)

        key = _dedupe_key(event)
        if key in _seen:
            return Response(status_code=200)
        _seen.add(key)

        # persist tracking payload into DB
        _upsert_tracking(event, raw)

        # best-effort: trigger internal page update
        try:
            internal_id = event.order_id  # same order_id you stored in DB
            if internal_id:
                base_url = os.getenv("NEXT_PUBLIC_API_BASE_URL")
                requests.get(
                    f"{base_url}/shiprocket/order/show",
                    params={"internal_order_id": internal_id},
                    timeout=10
                )
                logging.info(f"[SR WH] Triggered /shiprocket/order/show for {internal_id}")
        except Exception as exc:
            logging.exception(f"[SR WH] Failed to trigger order/show for {event.order_id}: {exc}")

        # -------------------------
        # NEW: trigger shipped email only when latest scan shows pickup
        # -------------------------
        query_base = {"order_id": event.order_id} if event.order_id else {"awb_code": event.awb}
        # fetch the updated document after our upsert
        order_doc = orders_collection.find_one(query_base) or {}

        shiprocket_data = order_doc.get("shiprocket_data") or {}
        scans = shiprocket_data.get("scans") or []

        latest = _latest_scan(scans)
        activity = (latest.get("activity") if latest else None) or ""
        activity_norm = activity.strip().lower()

        # Consider pickup detected only when activity exactly equals 'pickup done'
        is_pickup = False
        if activity_norm:
            if activity_norm == "pickup done":
                is_pickup = True

        if not is_pickup:
            logging.info("[SR WH] Pickup not detected in latest scan for %s (activity=%r). Skipping shipped email.", query_base, activity)
            return Response(status_code=200)

        # require a tracking number to include in email CTA
        tracking = (order_doc.get("tracking_number") or event.awb or raw.get("tracking") or "").strip()
        if not tracking:
            logging.info("[SR WH] Pickup detected but no tracking number present for %s. Skipping shipped email.", query_base)
            return Response(status_code=200)

        # idempotent flag specifically for pickup-triggered emails
        filter_once = {
            **query_base,
            "$or": [
                {"shiprocket_pickup_done_email_sent": {"$exists": False}},
                {"shiprocket_pickup_done_email_sent": False},
            ],
        }
        set_once = {"$set": {"shiprocket_pickup_done_email_sent": True}}
        once = orders_collection.update_one(filter_once, set_once, upsert=False)
        if once.modified_count == 1:
            doc = orders_collection.find_one(
                query_base,
                {"email": 1, "user_name": 1, "child_name": 1, "order_id": 1, "tracking_number": 1, "_id": 0},
            ) or {}
            to_email = (doc.get("email") or "").strip()
            if to_email:
                order_ref = (doc.get("order_id") or event.order_id or "").strip()
                shipping_option = "shiprocket"
                # use the tracking we resolved above
                user_name = doc.get("user_name")
                name = doc.get("child_name")
                background.add_task(
                    _send_tracking_email,
                    to_email,
                    order_ref,
                    shipping_option,
                    tracking,
                    user_name,
                    name,
                    SHIPROCKET_TRACKING_URL_TEMPLATE,
                    None
                )
                logging.info(f"[SR WH] queued pickup-shipped-email to {to_email} for {order_ref}")
            else:
                logging.info("[SR WH] pickup-shipped-email: no recipient email for %s", query_base)
        else:
            logging.info("[SR WH] pickup-shipped-email already sent earlier for %s", query_base)

        return Response(status_code=200)
    except Exception as exc:
        logging.exception(f"[SR WH] error: {exc}")
        return Response(status_code=200)
