# app/routers/shiprocket_webhook.py
import os
import logging
from datetime import datetime
from typing import List, Optional, Union


from dotenv import load_dotenv, find_dotenv
load_dotenv(find_dotenv(), override=False) 

from fastapi import APIRouter, Request, Response, BackgroundTasks
from pydantic import BaseModel, Field, ConfigDict
from pymongo import MongoClient

router = APIRouter()  # no prefix; we’ll expose a clean path below

# --- Config
EXPECTED_TOKEN = (os.getenv("SHIPROCKET_WEBHOOK_TOKEN") or "").strip()

# Reuse the same DB your main.py uses
MONGO_URI = os.getenv("MONGO_URI")
client = MongoClient(MONGO_URI, tz_aware=True)
db = client["candyman"]
orders_collection = db["shipping_details"]

# ---- Models (lenient; allow extra fields)
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
    order_id: Optional[str] = None          # your commerce order ref like "#123"
    sr_order_id: Optional[int] = None       # Shiprocket's order id
    awb_assigned_date: Optional[str] = None
    pickup_scheduled_date: Optional[str] = None
    etd: Optional[str] = None
    scans: Optional[List[Scan]] = None
    is_return: Optional[int] = None
    channel_id: Optional[int] = None
    pod_status: Optional[str] = None
    pod: Optional[str] = None

def _parse_ts(ts: Optional[str]) -> Optional[str]:
    """Return ISO8601 string or None. Shiprocket sometimes sends '23 05 2023 11:43:52'."""
    if not ts:
        return None
    # Be tolerant; store raw too. We avoid hard failures here.
    try:
        # Try day-first “DD MM YYYY HH:MM:SS”
        from datetime import datetime
        return datetime.strptime(ts, "%d %m %Y %H:%M:%S").isoformat()
    except Exception:
        try:
            # Try common ISO-like formats
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).isoformat()
        except Exception:
            return None

def _dedupe_key(ev: ShiprocketEvent) -> str:
    base = f"{ev.awb or ''}|{ev.current_status_id or ''}|{ev.current_timestamp or ''}"
    import hashlib
    return hashlib.sha256(base.encode()).hexdigest()

# In-memory dedupe for the single-process case; switch to Redis for multi-worker
_seen: set[str] = set()

from datetime import datetime, timezone
def _upsert_tracking(e: ShiprocketEvent, raw: dict) -> None:
    # Prefer matching on your own order_id when present; otherwise keep a separate index by AWB.
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
                "raw": raw,  # keep for debugging
            },
            # Convenience mirrors
            "tracking_number": e.awb or raw.get("tracking") or "",
            "courier_partner": e.courier_name or "",
            "delivery_status": "shipped" if (e.current_status or "").upper() in {"DELIVERED", "RTO DELIVERED"} else None,
        }
    }
    # Avoid wiping print_status to None if not delivered
    if update["$set"]["delivery_status"] is None:
        update["$set"].pop("delivery_status", None)

    orders_collection.update_one(q, update, upsert=False)

def _maybe_send_delivered_email(background: BackgroundTasks, e: ShiprocketEvent) -> None:
    """Stub: hook for delivered notifications. Disabled by default."""
    if (e.current_status or "").upper() != "DELIVERED":
        return
    # Example idempotent flag; off by default to avoid noisy emails.
    # once = orders_collection.update_one({"order_id": e.order_id, "$or": [{"delivered_email_sent": {"$exists": False}}, {"delivered_email_sent": False}]}, {"$set": {"delivered_email_sent": True}})
    # if once.modified_count == 1:
    #     background.add_task(send_delivered_email, ...)

# NOTE: Avoid the banned keywords in the path.
@router.post("/api/webhook/Genesis")
@router.post("/api/webhook/Genesis/")
async def shiprocket_tracking(request: Request, background: BackgroundTasks) -> Response:
    # Must return 200, always.
    try:
        # Optional token check (recommended)
        if EXPECTED_TOKEN:
            token = request.headers.get("x-api-key")  # exact header name
            if not token or token.strip() != EXPECTED_TOKEN:
                logging.warning("[SR WH] token mismatch; ignoring payload")
                return Response(status_code=200)

        # Content-type tolerance: if not JSON, ack and drop.
        if (request.headers.get("content-type") or "").lower() != "application/json":
            return Response(status_code=200)

        raw = await request.json()
        logging.info(f"[SR WH] payload: {raw}")
        event = ShiprocketEvent.model_validate(raw)

        # Idempotency
        key = _dedupe_key(event)
        if key in _seen:
            return Response(status_code=200)
        _seen.add(key)

        # Persist
        _upsert_tracking(event, raw)

        # Optional delivered email hook
        _maybe_send_delivered_email(background, event)

        return Response(status_code=200)
    except Exception as exc:
        logging.exception(f"[SR WH] error: {exc}")
        return Response(status_code=200)
