# app/routers/reconcile.py
from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional, Dict, Any, List, Tuple
import os
import httpx
import re
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from app.routers.razorpay_export import (
    _assert_keys,
    amount_to_display,
    ts_to_ddmmyyyy_hhmmss,
)
import hmac, hashlib

router = APIRouter(prefix="/reconcile", tags=["reconcile"])

def norm(s: str | None, *, case_insensitive: bool) -> str:
    t = (s or "").replace("\u00A0", " ").strip()
    return t.lower() if case_insensitive else t

# ---- Razorpay fetcher (reuse your existing code) ----------------------------
from app.routers.razorpay_export import fetch_payments, _assert_keys
# ----------------------------------------------------------------------------

# ---- Mongo connection via ENV ----------------------------------------------
MONGO_URI = os.getenv("MONGO_URI")
if not MONGO_URI:
    # Fail fast with a clear message instead of silently defaulting to localhost.
    raise RuntimeError("MONGO_URI not set")

client = MongoClient(MONGO_URI, tz_aware=True)
db = client["candyman"]
orders_collection = db["user_details"]

_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b"
)

# ------------------------------ KEEP: /orders --------------------------------
@router.get("/orders")
def get_orders(
    sort_by: Optional[str] = Query(None, description="Field to sort by"),
    sort_dir: Optional[str] = Query("asc", description="asc or desc"),
    filter_status: Optional[str] = Query(None),
    filter_book_style: Optional[str] = Query(None),
    filter_print_approval: Optional[str] = Query(None),
    filter_discount_code: Optional[str] = Query(None),
    exclude_discount_code: Optional[str] = None,
):
    # Base query: only show paid orders
    query = {"paid": True}

    # Add additional filters
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
        if filter_discount_code.lower() == "none":
            query["discount_amount"] = 0
            query["paid"] = True
        else:
            query["discount_code"] = filter_discount_code.upper()

    if exclude_discount_code:
        if "discount_code" in query and isinstance(query["discount_code"], str):
            query["$and"] = [
                {"discount_code": query["discount_code"]},
                {"discount_code": {"$ne": exclude_discount_code.upper()}},
            ]
            del query["discount_code"]
        elif "discount_code" not in query:
            query["discount_code"] = {"$ne": exclude_discount_code.upper()}

    # Fetch and sort records
    sort_field = sort_by if sort_by else "created_at"
    sort_order = 1 if sort_dir == "asc" else -1

    projection = {
        "order_id": 1, "job_id": 1, "cover_url": 1, "book_url": 1, "preview_url": 1,
        "name": 1, "shipping_address": 1, "created_at": 1, "processed_at": 1,
        "approved_at": 1, "approved": 1, "book_id": 1, "book_style": 1,
        "print_status": 1, "price": 1, "total_price": 1, "amount": 1, "total_amount": 1,
        "feedback_email": 1, "print_approval": 1, "discount_code": 1,
        "currency": 1, "locale": 1, "_id": 0,
    }

    records = list(orders_collection.find(query, projection).sort(sort_field, sort_order))
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
        })
    return result
# ----------------------------------------------------------------------------


@router.get("/vlookup-payment-to-orders/auto")
async def vlookup_payment_to_orders_auto(
    # Payments: ALL STATUSES by default (None)
    status: Optional[str] = Query(None, description="Filter payments fetched from Razorpay by status; omit for ALL"),
    max_fetch: int = Query(200_000, ge=1, le=1_000_000, description="Upper bound for Razorpay pulls"),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD / ISO; omit for ALL time"),
    to_date:   Optional[str] = Query(None, description="YYYY-MM-DD / ISO; omit for ALL time"),
    case_insensitive_ids: bool = Query(False, description="Lowercase both sides before matching"),

    # Orders paging (scan *all* orders)
    orders_batch_size: int = Query(50_000, ge=1_000, le=200_000, description="Mongo batch size"),

    # IMPORTANT: default to only NA with status=captured
    na_status: Optional[str] = Query("captured", description="Only include NA payments with this Razorpay status"),
):
    _assert_keys()

    def _to_unix(s: Optional[str]) -> Optional[int]:
        if not s:
            return None
        from dateutil import parser as dtparser
        return int(dtparser.parse(s).timestamp())

    # 1) Razorpay: fetch ALL (status=None => all statuses)
    try:
        async with httpx.AsyncClient(
            auth=(os.getenv("RAZORPAY_KEY_ID"), os.getenv("RAZORPAY_KEY_SECRET")),
            timeout=60.0
        ) as client:
            payments: List[Dict[str, Any]] = await fetch_payments(
                client=client,
                status_filter=status,   # None => all
                from_unix=_to_unix(from_date),
                to_unix=_to_unix(to_date),
                max_fetch=max_fetch,
            )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Network error calling Razorpay: {e}")

    # Index: normalized id -> (raw id, status)
    pay_index: Dict[str, Dict[str, str]] = {}
    for p in payments:
        raw_id = str(p.get("id", "") or "")
        if not raw_id:
            continue
        key = norm(raw_id, case_insensitive=case_insensitive_ids)
        st = (p.get("status") or "").strip().lower()
        pay_index[key] = {"id": raw_id, "status": st}

    payment_keys = set(pay_index.keys())
    matched_keys: set[str] = set()

    # 2) Scan ALL orders by _id (Atlas-safe)
    total_orders_docs = 0
    orders_with_tx = 0
    last_id = None

    try:
        while True:
            q: Dict[str, Any] = {}
            if last_id is not None:
                q["_id"] = {"$gt": last_id}

            batch = list(
                orders_collection.find(q, projection={"transaction_id": 1, "order_id": 1})
                                 .sort([("_id", 1)])
                                 .limit(orders_batch_size)
            )
            if not batch:
                break

            total_orders_docs += len(batch)

            for doc in batch:
                raw_tx = doc.get("transaction_id")
                if not raw_tx:
                    continue
                tx_key = norm(str(raw_tx), case_insensitive=case_insensitive_ids)
                if not tx_key:
                    continue
                orders_with_tx += 1
                if tx_key in payment_keys:
                    matched_keys.add(tx_key)

            last_id = batch[-1]["_id"]
    except PyMongoError as e:
        raise HTTPException(status_code=502, detail=f"Mongo query failed: {e}")

    # 3) NA keys (in payments but not matched to any order)
    na_keys = payment_keys - matched_keys

    # Build NA items and FILTER by status (default captured)
    target_status = (na_status or "captured").strip().lower()
    na_items: List[Dict[str, str]] = []
    for k in na_keys:
        rec = pay_index.get(k)
        if not rec:
            continue
        if (rec.get("status") or "") == target_status:
            na_items.append({"id": rec["id"], "status": target_status})

    # Sort by id (status is uniform now)
    na_items.sort(key=lambda x: x["id"])

    # Group (will only contain the target status)
    na_by_status: Dict[str, List[str]] = {}
    for item in na_items:
        na_by_status.setdefault(item["status"], []).append(item["id"])

    matched_distinct = len(matched_keys)

    return JSONResponse({
        "summary": {
            "total_orders_docs_scanned": total_orders_docs,
            "orders_with_transaction_id": orders_with_tx,
            "total_payments_rows": len(payments),
            "payment_status_filter": status or "(ALL)",
            "case_insensitive_ids": case_insensitive_ids,
            "matched_distinct_payment_ids": matched_distinct,
            # IMPORTANT: now counts ONLY the chosen status (default captured)
            "na_count": len(na_items),
            "max_fetch": max_fetch,
            "date_window": {
                "from_date": from_date or "(all-time)",
                "to_date": to_date or "(all-time)",
            },
            "orders_batch_size": orders_batch_size,
            "na_status_filter": target_status,
        },
        # Only the chosen status (default captured)
        "na_payment_ids": [x["id"] for x in na_items],
        "na_by_status": na_by_status,  # contains only the chosen status
    })

def _extract_uuid(s: str | None) -> str | None:
    if not isinstance(s, str) or not s:
        return None
    m = _UUID_RE.search(s)
    return m.group(0) if m else None

def _extract_job_id_from_payment(p: Dict[str, Any]) -> Optional[str]:
    notes = p.get("notes") or {}
    if isinstance(notes, dict):
        # common keys first
        for k in ("job_id", "JobId", "JOB_ID"):
            v = notes.get(k)
            got = _extract_uuid(v) if isinstance(v, str) else None
            if got:
                return got
        # scan all string values
        for v in notes.values():
            if isinstance(v, str):
                got = _extract_uuid(v)
                if got:
                    return got
    desc = p.get("description") or ""
    return _extract_uuid(desc) if isinstance(desc, str) else None

def _lookup_paid_preview_by_job(job_id: Optional[str]) -> Tuple[Optional[bool], Optional[str]]:
    if not job_id:
        return (None, None)
    try:
        doc = orders_collection.find_one({"job_id": job_id}, {"paid": 1, "preview_url": 1})
        if not doc:
            return (None, None)
        paid = bool(doc.get("paid")) if "paid" in doc else None
        preview_url = doc.get("preview_url") if isinstance(doc.get("preview_url"), str) else None
        return (paid, preview_url)
    except Exception:
        return (None, None)
    
def _project_row(payment: Dict[str, Any]) -> Dict[str, Any]:
    """Combine Razorpay fields + DB (job_id, paid, preview_url)."""
    upi = payment.get("upi") or {}
    acq = payment.get("acquirer_data") or {}
    vpa = payment.get("vpa") or upi.get("vpa") or ""
    flow = upi.get("flow", "")

    pid = payment.get("id", "")

    # Primary: transaction_id == payment_id mapping in your user_details
    job_id_db = None
    paid, preview_url = (None, None)
    try:
        doc_tx = orders_collection.find_one({"transaction_id": pid}, {"job_id": 1, "paid": 1, "preview_url": 1})
        if doc_tx:
            job_id_db = doc_tx.get("job_id")
            paid = bool(doc_tx.get("paid")) if "paid" in doc_tx else None
            preview_url = doc_tx.get("preview_url") if isinstance(doc_tx.get("preview_url"), str) else None
    except Exception:
        pass

    # Fallback: extract UUID job_id from Razorpay payload then lookup by job_id
    if not job_id_db:
        job_id_guess = _extract_job_id_from_payment(payment)
        if job_id_guess:
            paid, preview_url = _lookup_paid_preview_by_job(job_id_guess)
            job_id_db = job_id_guess

    return {
        "id": pid,
        "email": payment.get("email") or None,
        "contact": payment.get("contact") or None,
        "status": payment.get("status") or None,
        "method": payment.get("method") or None,
        "currency": payment.get("currency") or None,
        "amount_display": amount_to_display(payment.get("amount")),
        "created_at": ts_to_ddmmyyyy_hhmmss(payment.get("created_at")),
        "order_id": payment.get("order_id") or None,
        "description": payment.get("description") or None,
        "vpa": vpa or None,
        "flow": flow or None,
        "rrn": acq.get("rrn") or None,
        "arn": acq.get("authentication_reference_number") or None,
        "auth_code": acq.get("auth_code") or None,
        # DB-enriched:
        "job_id": job_id_db,
        "paid": paid,
        "preview_url": preview_url,
    }

@router.post("/na-payment-details")
async def na_payment_details(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Body: {"ids": ["pay_ABC...", ...]}
    Returns Razorpay details + DB-enriched (job_id, paid, preview_url) for each ID.
    """
    _assert_keys()

    ids = body.get("ids")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, detail="Body must contain 'ids' as a non-empty list of strings")

    uniq_ids = list(dict.fromkeys([str(x).strip() for x in ids if str(x).strip()]))
    if len(uniq_ids) > 2000:
        raise HTTPException(413, detail="Too many IDs; max 2000 per request")

    items: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    try:
        async with httpx.AsyncClient(
            auth=(os.getenv("RAZORPAY_KEY_ID"), os.getenv("RAZORPAY_KEY_SECRET")),
            timeout=20.0
        ) as client:
            for pid in uniq_ids:
                try:
                    r = await client.get(f"https://api.razorpay.com/v1/payments/{pid}")
                    if r.status_code == 404:
                        errors.append({"id": pid, "error": "not_found"})
                        continue
                    r.raise_for_status()
                    p = r.json()
                    items.append(_project_row(p))
                except httpx.HTTPStatusError as e:
                    errors.append({"id": pid, "error": f"http_{e.response.status_code}", "detail": (e.response.text or "")[:200]})
                except httpx.RequestError as e:
                    errors.append({"id": pid, "error": "network", "detail": str(e)})
    except httpx.RequestError as e:
        raise HTTPException(502, detail=f"Network error calling Razorpay: {e}")

    return {"count": len(items), "items": items, "errors": errors}

@router.post("/sign-razorpay")
def sign_razorpay(body: Dict[str, Any]) -> Dict[str, str]:
    """
    Returns a Razorpay-compatible signature for body: 'order_id|payment_id'.
    Body: { "razorpay_order_id": "...", "razorpay_payment_id": "..." }
    Uses RAZORPAY_KEY_SECRET from server .env. DO NOT expose this from frontend.
    """
    secret = os.getenv("RAZORPAY_KEY_SECRET")
    if not secret:
        raise HTTPException(500, detail="RAZORPAY_KEY_SECRET not set")

    order_id = (body or {}).get("razorpay_order_id")
    payment_id = (body or {}).get("razorpay_payment_id")
    if not order_id or not payment_id:
        raise HTTPException(400, detail="razorpay_order_id and razorpay_payment_id are required")

    message = f"{order_id}|{payment_id}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return {"razorpay_signature": digest}