# app/routers/cloudprinter_webhook.py
import json, time, hmac, os, smtplib
from email.message import EmailMessage
from fastapi import APIRouter, Request, HTTPException, status, Depends, BackgroundTasks
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel

router = APIRouter()
security = HTTPBasic(auto_error=False)

WEBHOOK_KEY = (os.getenv("CLOUDPRINTER_WEBHOOK_KEY") or "").strip()
BASIC_USER  = (os.getenv("CP_WEBHOOK_USER") or "").strip()
BASIC_PASS  = (os.getenv("CP_WEBHOOK_PASS") or "").strip()
EMAIL_USER  = (os.getenv("EMAIL_ADDRESS") or "").strip()
EMAIL_PASS  = (os.getenv("EMAIL_PASSWORD") or "").strip()

def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(str(a or ""), str(b or ""))

class ItemShippedPayload(BaseModel):
    apikey: str
    type: str  # must be "ItemShipped"
    order_reference: str
    order: str | None = None
    item: str | None = None
    item_reference: str | None = None
    tracking: str
    shipping_option: str
    datetime: str  # ISO 8601 from Cloudprinter

def _carrier_slug(shipping_option: str) -> str:
    # Cloudprinter uses identifiers like "bluedart_in_domestic"; AfterShip wants slug-style
    return (shipping_option or "").strip().lower().replace(" ", "-")

def _tracking_link(shipping_option: str, tracking: str) -> str:
    if shipping_option and tracking:
        return f"https://track.aftership.com/{_carrier_slug(shipping_option)}/{tracking}"
    return ""

def _send_tracking_email(to_email: str,
                         order_ref: str,
                         shipping_option: str,
                         tracking: str,
                         when_iso: str,
                         user_name: str | None = None,
                         child_name: str | None = None):
    if not to_email:
        print(f"[MAIL] skipped: empty recipient for order {order_ref}")
        return

    tracking_url = _tracking_link(shipping_option, tracking)
    display_name = (user_name or "there").strip().title() or "there"
    child_name = (child_name or "there").strip().title() or "there"

    subject = f"Your order {order_ref} has shipped!"
    html = f"""
    <html><body style="font-family: Arial, sans-serif;">
      <p>Hi {display_name},</p>
      <p>Your story book for {child_name} has been <strong>shipped</strong>.</p>
      <ul>
        <li><strong>Order:</strong> {order_ref}</li>
        <li><strong>Carrier:</strong> {shipping_option}</li>
        <li><strong>Tracking:</strong> {tracking}</li>
        <li><strong>Shipped at:</strong> {when_iso}</li>
      </ul>
      {"<p><a href='"+tracking_url+"' style='background:#5784ba;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none'>Track your package</a></p>" if tracking_url else ""}
      <p>Thanks,<br/>Team Diffrun</p>
    </body></html>
    """

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Diffrun <{EMAIL_USER}>"
    msg["To"] = to_email
    msg.set_content("Your order has shipped. View this email in HTML to see the tracking button.")
    msg.add_alternative(html, subtype="html")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)
    print(f"[MAIL] sent shipped-email to {to_email} for order {order_ref}")

@router.post("/api/webhook/cloudprinter")
@router.post("/api/webhook/cloudprinter/")  # accept trailing slash; avoids redirect losing auth header
async def cloudprinter_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    credentials: HTTPBasicCredentials | None = Depends(security),
):
    t0 = time.perf_counter()

    # ---- Basic Auth (only if BOTH are configured)
    if BASIC_USER and BASIC_PASS:
        if not credentials or not (_eq(credentials.username, BASIC_USER) and _eq(credentials.password, BASIC_PASS)):
            print(f"[CP WEBHOOK] 401 basic-auth failed (user={getattr(credentials,'username',None)!r})")
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    # ---- parse JSON
    raw = await request.body()
    remote = request.client.host if request.client else "?"
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        print(f"[CP WEBHOOK] <-- {remote} invalid JSON (size={len(raw)}B)")
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # ---- apikey check
    if not _eq(payload.get("apikey"), WEBHOOK_KEY):
        print(f"[CP WEBHOOK] 401 bad webhook key for order_ref={payload.get('order_reference')}")
        raise HTTPException(status_code=401, detail="Bad webhook apikey")

    evt = payload.get("type")
    order_ref = payload.get("order_reference")
    print(f"[CP WEBHOOK] <-- {remote} type={evt} order_ref={order_ref}")

    # ---- only act on ItemShipped; ack others silently
    if evt != "ItemShipped":
        # 204: we intentionally do nothing for other events
        return {"status": "ignored"}

    # Validate payload shape
    data = ItemShippedPayload(**payload)

    # ---- DB work + idempotent email
    try:
        # Lazy import to avoid circular import with main.py
        from main import orders_collection
    except Exception as e:
        print(f"[CP WEBHOOK] DB import error: {e}")
        raise HTTPException(status_code=500, detail="Server misconfiguration")

    # 1) Update tracking fields (always) and set print_status to 'shipped'
    update_fields = {
        "tracking_code": data.tracking,
        "shipping_option": data.shipping_option,
        "shipped_at": data.datetime,
        "print_status": "shipped",
    }
    orders_collection.update_one({"order_id": data.order_reference}, {"$set": update_fields})

    # 2) Idempotent email: set shipped_email_sent=True only once; send email iff we flipped it now
    filter_once = {
        "order_id": data.order_reference,
        "$or": [{"shipped_email_sent": {"$exists": False}}, {"shipped_email_sent": False}],
    }
    set_once = {"$set": {"shipped_email_sent": True}}
    once = orders_collection.update_one(filter_once, set_once)

    if once.modified_count == 1:
        # We "won" the race to send the email → fetch recipient + name
        order = orders_collection.find_one(
            {"order_id": data.order_reference},
            {"customer_email": 1, "email": 1, "user_name": 1, "_id": 0},
        )
        #to_email = (order.get("customer_email") or order.get("email") or "").strip() if order else ""
        to_email = "husain@lhmm.in"
        user_name = (order.get("user_name") if order else None)
        name = order.get("name") if order else None

        if to_email:
            # queue email in background
            background_tasks.add_task(
                _send_tracking_email,
                to_email,
                data.order_reference,
                data.shipping_option,
                data.tracking,
                data.datetime,
                user_name,
                name
            )
            print(f"[CP WEBHOOK] queued shipped-email to {to_email} for {data.order_reference}")
        else:
            print(f"[CP WEBHOOK] no customer_email/email in DB for {data.order_reference}; email skipped")
    else:
        print(f"[CP WEBHOOK] shipped-email already sent for {data.order_reference}; skipping")

    dt_ms = (time.perf_counter() - t0) * 1000
    print(f"[CP WEBHOOK] --> 200 ok ({dt_ms:.1f} ms) ItemShipped {order_ref}")
    return {"ok": True}
