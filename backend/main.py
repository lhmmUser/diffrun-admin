from fastapi import FastAPI, BackgroundTasks,Response, Request, Query, HTTPException, Body, Path
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from dotenv import load_dotenv
import os
from fastapi.encoders import jsonable_encoder
from typing import Optional, List, Literal
from datetime import datetime, time, timedelta, timezone
import requests
import hashlib
import PyPDF2
import io
import smtplib
from email.message import EmailMessage
import logging
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel,  constr
from pydantic import ValidationError
from contextlib import asynccontextmanager
from apscheduler.schedulers.background import BackgroundScheduler
import boto3
import csv
from fastapi.responses import FileResponse, StreamingResponse
import tempfile
from dateutil import parser
from app.routers.reconcile import router as vlookup_router
from app.routers.razorpay_export import router as razorpay_router
from app.routers.cloudprinter_webhook import router as cloudprinter_router
import pandas as pd
from botocore.exceptions import BotoCoreError, ClientError
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
import pytz
from io import BytesIO
from typing import Tuple

IST_TZ = pytz.timezone("Asia/Kolkata")

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

MONGO_URI_df = os.getenv("MONGO_URI_df")
client_df = MongoClient(MONGO_URI_df)
df_db = client_df["df-db"]
collection_df = df_db["user-data"]

scheduler = BackgroundScheduler(timezone=IST_TZ)

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        if not scheduler.running:
            scheduler.start()

        # register export job (your existing one)
        scheduler.add_job(
            _run_export_and_email,
            trigger=CronTrigger(hour="0,3,6,9,12,15,18", minute="0", timezone=IST_TZ),
            id="xlsx_export_fixed_ist_times",
            replace_existing=True,
            coalesce=True,
            max_instances=1,
        )

        # register nudge job via your function
        schedule_nudge_emails()

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
                timestamp = int(date_input['date']['$numberLong']) / 1000 if '$numberLong' in date_input['date'] else int(date_input['date']) / 1000
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
                logger.warning(f"⚠️ Could not parse string datetime: {value} | Error: {e}")
                return value  # Return original if parsing fails

        logger.warning(f"⚠️ Unknown type for processed_at: {type(value)} -> {value}")
        return str(value)

    except Exception as e:
        logger.error(f"🔥 Failed to format processed_at: {value} | Error: {e}")
        return ""


MONGO_URI = os.getenv("MONGO_URI")
client = MongoClient(MONGO_URI, tz_aware=True)
db = client["candyman"]
orders_collection = db["user_details"] 

s3 = boto3.client('s3',
                  aws_access_key_id = os.getenv("AWS_ACCESS_KEY_ID"),
                  aws_secret_access_key = os.getenv("AWS_SECRET_ACCESS_KEY"),
                  region_name = os.getenv("AWS_REGION"))
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
    job_ids : List[str]
    

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
        print(f"[DEBUG] Filter discount code: {filter_discount_code}")
        if filter_discount_code.lower() == "none":
            query["discount_amount"] = 0
            query["paid"] = True  # already set by default, but explicit is good
        else:
            query["discount_code"] = filter_discount_code.upper()

    if exclude_discount_code:
        if "discount_code" in query and isinstance(query["discount_code"], str):
            # Combine both filter and exclude
            query["$and"] = [
                {"discount_code": query["discount_code"]},
                {"discount_code": {"$ne": exclude_discount_code.upper()}}
            ]
            del query["discount_code"]  # Remove top-level field
        elif "discount_code" not in query:
            query["discount_code"] = {"$ne": exclude_discount_code.upper()}

    # Fetch and sort records
    sort_field = sort_by if sort_by else "created_at"
    sort_order = 1 if sort_dir == "asc" else -1

    # Only fetch the fields we need
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
        "_id": 0,
        "shipped_at": 1,
        "cust_status": 1,
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
            "paymentDate": ((doc.get("processed_at", ""))),
            "approvalDate": ((doc.get("approved_at", ""))),
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
        })

    return result

@app.post("/orders/set-cust-status/{order_id}")
async def set_cust_status(
    order_id: str,
    status: Literal["red", "green"] = Body(..., embed=True),
    create_if_missing: bool = Query(False, description="Use ?create_if_missing=true to upsert for testing")
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

@app.get("/orders/{order_id}")
def get_order_detail(order_id: str):
    # Find the order with the given order_id
    order = orders_collection.find_one({"order_id": order_id})
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Format the response with all necessary fields
    return {
        "order_id": order.get("order_id", ""),
        "name": order.get("name", ""),
        "book_id": order.get("book_id", ""),
        "book_style": order.get("book_style", ""),
        "preview_url": f"https://diffrun.com/preview/{order.get('job_id', '')}",
        "gender": order.get("gender", ""),
        "user_name": order.get("user_name", ""),
        "email": order.get("email", ""),
        "phone": order.get("phone", ""),
        "shipping_address": {
            "street": order.get("shipping_address", {}).get("street", ""),
            "city": order.get("shipping_address", {}).get("city", ""),
            "state": order.get("shipping_address", {}).get("state", ""),
            "country": order.get("shipping_address", {}).get("country", ""),
            "zip": order.get("shipping_address", {}).get("zip", "")
        }
    }

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

def get_product_details(book_style: str) -> tuple[str, str]:
    if book_style == "paperback":  # Exact match with database value
        return ("Paperback", "photobook_pb_s210_s_fc")
    elif book_style == "hardcover":  # Exact match with database value
        return ("Hardcover", "photobook_cw_s210_s_fc")
    else:  # Fallback to hardcover if unknown
        return ("Hardcover", "photobook_cw_s210_s_fc")
    
def get_shipping_level(country_code: str) -> str:
    if country_code == "IN":
        return "cp_saver"
    elif country_code in {"US", "GB"}:
        return "cp_ground"
    return "cp_ground"  # default fallback

@app.post("/orders/approve-printing")
async def approve_printing(order_ids: List[str]):
    CLOUDPRINTER_API_KEY = os.getenv("CLOUDPRINTER_API_KEY", "1414e4bd0220dc1e518e268937ff18a3")
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
            
            print(f"Downloading and calculating MD5 for cover PDF...")
            cover_md5 = hashlib.md5(requests.get(cover_url).content).hexdigest() if cover_url else None
            print(f"Cover PDF MD5: {cover_md5}")

            print(f"Downloading and calculating MD5 for interior PDF...")
            interior_md5 = hashlib.md5(requests.get(book_url).content).hexdigest() if book_url else None
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
            reference, product_code = get_product_details(book_style)
            print(f"Selected product: {reference} ({product_code})")

            shipping_level = get_shipping_level(country_code)
            print(f"Selected shipping level: {shipping_level} for {country_code}")

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
                    "count": "1",
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

            print(f"CloudPrinter API Response (Status {response.status_code}): {response_data}")

            if response.status_code in [200, 201]:
                print(f"Updating order status in database for {order_id}...")
                orders_collection.update_one(
                    {"order_id": order_id},
                    {
                        "$set": {
                            "print_status": "sent_to_printer",
                            "cloudprinter_reference": response_data.get("reference", ""),
                            "print_sent_at": datetime.now().isoformat()
                        }
                    }
                )
                results.append({
                    "order_id": order_id,
                    "status": "success",
                    "message": "Successfully sent to printer",
                    "step": "completed",
                    "cloudprinter_reference": response_data.get("reference", "")
                })
                print(f"Successfully processed order {order_id}")
            else:
                error_msg = response_data.get("message", "Failed to send to printer")
                print(f"Failed to send order {order_id} to printer: {error_msg}")
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
        "_id": 0
    }

    records = list(orders_collection.find(query, projection).sort(sort_field, sort_order))
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

def personalize_pronoun( gender: str) -> str:
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
        raise HTTPException(status_code=400, detail="No email found for this order")

    try:
        html_content = f"""
        <html>
        <head>
        <meta charset="UTF-8">
        <meta name="color-scheme" content="light">
        <meta name="supported-color-schemes" content="light">
        <title>We'd love your feedback</title>
        <style>
        @media only screen and (max-width: 480px) {{
            h2 {{ font-size: 15px !important; }}
            p {{ font-size: 15px !important; }}
            a {{ font-size: 15px !important; }}
            .title-text {{ font-size: 18px !important; }}
            .small-text {{ font-size: 12px !important; }}
            .logo-img {{ width: 300px !important; }}
            .review-btn {{ font-size: 14px !important; padding: 12px 20px ; font-size: 8px !important; }}
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

                <h2 style="color: #333; font-size: 15px;">Hey there {order.get("user_name")},</h2>

                <p style="font-size: 14px; color: #555;">
                We truly hope {order.get("name", "")} is enjoying {personalize_pronoun(order.get("gender","   "))} magical storybook, <strong>{generate_book_title(order.get("book_id"), order.get("name"))}</strong>! 
                At Diffrun, we are dedicated to crafting personalized storybooks that inspire joy, imagination, and lasting memories for every child. 
                Your feedback means the world to us. We'd be grateful if you could share your experience.
                </p>

                <p style="font-size: 14px; color: #555;">Please share your feedback with us:</p>

                <p style="text-align: left; margin: 30px 0;">
                <a href="https://search.google.com/local/writereview?placeid=ChIJn5mGENoTrjsRPHxH86vgui0"
                    class="review-btn"
                    style="background-color: #5784ba; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 20px; font-weight: bold; font-size: 16px;">
                    Leave a Review
                </a>
                </p>

                <p style="font-size: 14px; color: #555; text-align: left;">
                Thanks,<br>Team Diffrun
                </p>

                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">

                <!-- Explore More Row -->
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 30px;">
                <tr>
                    <td colspan="2" style="padding: 10px 0; text-align: left;">
                    <p class="title-text" style="font-size: 18px; margin: 0; font-weight: bold; color: #000;">
                            {generate_book_title(order.get("book_id"), order.get("name"))}
                            </p>
                    </td>
                </tr>

                <!-- Order reference -->
                <tr>
                    <td style="padding: 0; vertical-align: top; font-size: 12px; color: #333; font-weight: 500;">
                    Order reference ID: <span>{order.get("order_id", "N/A")}</span>
                    </td>
                    <td style="padding: 0; text-align: right; font-size: 12px; color: #333; font-weight: 500;">
                    Ordered: <span>{format_date(order.get("approved_at", ""))}</span>
                    </td>
                </tr>

                <!-- Book title and image block -->
                <tr>
                    <td colspan="2" style="padding: 0; margin: 0; background-color: #f7f6cf;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; padding: 0; margin: 0;">
                        <tr>
                        <!-- Left Title -->
                        <td style="padding: 20px; vertical-align: middle; margin: 0;">
                            
                            <p style="font-size: 15px; margin: 0; ">
                        Explore more magical books in our growing collection &nbsp;
                        <button class="browse-now-btn" style="background-color:#5784ba; margin-top: 20px; border-radius: 30px;border: none;padding:10px 15px"><a href="https://diffrun.com" style="color:white; font-weight: bold; text-decoration: none;">
                        Browse Now
                        </a></button>
                    </p>
                        </td>

                        <!-- Right Image -->
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
        msg["Subject"] = f"We'd love your feedback on {order.get("name", "")}'s Storybook!"
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

    #background_tasks.add_task(send_email, recipient_email, subject, html_body)
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

def send_nudge_email():
    try:
        now = datetime.now(timezone.utc)
        cutoff_24h_ago = now - timedelta(hours=24)
        created_after = datetime(2025, 7, 23, tzinfo=timezone.utc)

        query = {
            "paid": False,
            "nudge_sent": False, 
            "created_at": {
                "$gte": created_after,
                "$lt": cutoff_24h_ago
            },
            "workflows": {"$exists": True}
        }

        users = list(orders_collection.find(query))

        latest_per_email = {}

        for u in users:
            email = u.get("email")
            if not email or "lhmm.in" in email:
                continue

            if len(u.get("workflows", {})) != 10:
                continue

            if email not in latest_per_email or u["created_at"] > latest_per_email[email]["created_at"]:
                latest_per_email[email] = u

        for user in latest_per_email.values():
            try:
                send_nudge_email_to_user(
                    email=user["email"],
                    user_name=user.get("user_name", "there"),
                    child_name=user.get("name", "your child"),
                    job_id=user["job_id"]
                )

                orders_collection.update_one(
                    {"_id": user["_id"]},
                    {"$set": {"nudge_sent": True}}
                )

                logger.info(f"✅ Sent nudge email to {user['email']}")

            except Exception as e:
                logger.error(f"❌ Error sending email to {user.get('email')}: {str(e)}")

    except Exception as e:
        logger.error(f"❌ Nudge email task failed: {str(e)}")

def send_nudge_email_to_user(email: str, user_name: str, child_name: str, job_id: str):
   
    order = orders_collection.find_one({"job_id": job_id})
    if not order:
        logger.warning(f"⚠️ Could not find order for job_id={job_id}")
        return

    preview_link = order.get("preview_url", f"https://diffrun.com/preview/{job_id}")
    user_name = user_name.strip().title() or "there"
    child_name = child_name.strip().title() or "your child"
    
    html_content = f"""
    <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <p>Hi <strong>{user_name}</strong>,</p>

            <p>We noticed you began crafting a personalized storybook for <strong>{child_name}</strong> — and it’s already looking magical!</p>

            <p>Just one more step to bring it to life: preview the story and place your order whenever you’re ready.</p>

            <p style="margin: 32px 0;">
            <a href="{preview_link}" 
                style="background-color: #5784ba;
                    color: white;
                    padding: 14px 28px;
                    border-radius: 6px;
                    text-decoration: none;
                    font-weight: bold;">
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
   
    EMAIL_USER = os.getenv("EMAIL_ADDRESS")
    EMAIL_PASS = os.getenv("EMAIL_PASSWORD")
    
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)

@app.post("/trigger-nudge-emails")
async def trigger_nudge_emails(background_tasks: BackgroundTasks):
    try:
        background_tasks.add_task(send_nudge_email)
        return {"status": "success", "message": "Nudge email process started"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error starting task: {str(e)}")

def schedule_nudge_emails():
    if not scheduler.running:
        scheduler.start()

    scheduler.add_job(
        send_nudge_email,
        trigger=CronTrigger(hour="14", minute="0", timezone=IST_TZ),
        id="nudge_email_daily_14ist",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )

@app.get("/debug/nudge-candidates")
def debug_nudge_candidates():
    now = datetime.now(timezone.utc)
    min_created_at = datetime(2025, 7, 23, tzinfo=timezone.utc)
    cutoff_time = now - timedelta(hours=24)

    query = {
        "paid": False,
        "nudge_sent": False,
        "created_at": {
            "$gte": min_created_at,
            "$lt": cutoff_time
        },
        "workflows": {"$exists": True}
    }

    users = list(orders_collection.find(query, {
        "email": 1,
        "user_name": 1,
        "name": 1,
        "job_id": 1,
        "created_at": 1,
        "workflows": 1,
        "_id": 0
    }))

    latest_per_email = {}

    for u in users:
        email = u.get("email") or ""
        if not email or "lhmm.in" in email:
            continue

        if len(u.get("workflows", {})) != 10:
            continue

        if email not in latest_per_email or u["created_at"] > latest_per_email[email]["created_at"]:
            latest_per_email[email] = {
                "email": email,
                "name": u.get("name"),
                "user_name": u.get("user_name"),
                "job_id": u.get("job_id"),
                "created_at": u.get("created_at")
            }

    return list(latest_per_email.values())

@app.post("/orders/unapprove")
async def unapprove_orders(req: UnapproveRequest):
    for job_id in req.job_ids:
        result = orders_collection.update_one(
            {"job_id":job_id},
            {"$set": {"approved": False}}    
            )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail=f"No order found with job_id {job_id}")

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

            s3.copy_object(Bucket=BUCKET_NAME, CopySource={"Bucket": BUCKET_NAME, "Key": src_key}, Key=dst_key)
            s3.delete_object(Bucket=BUCKET_NAME, Key=src_key)

    return {"message": f"Unapproved {len(req.job_ids)} orders successfully"}

from dateutil import parser  # ensure this is at the top

@app.get("/export-orders-csv")
def export_orders_csv():
    fields = [
        "email", "phone_number", "age", "book_id", "book_style", "total_price", "gender", "paid",
        "approved", "created_date", "created_time", "creation_hour",
        "payment_date", "payment_time", "payment_hour",
        "locale", "name", "user_name", "shipping_address.city", "shipping_address.province",
        "order_id", "discount_code", "paypal_capture_id", "transaction_id", 
    ]

    projection = {
        "email": 1, "phone_number": 1, "age": 1, "book_id": 1, "book_style": 1, "total_price": 1,
        "gender": 1, "paid": 1, "approved": 1, "created_at": 1, "processed_at": 1,
        "locale": 1, "name": 1, "user_name": 1, "shipping_address": 1, "order_id": 1,
        "discount_code": 1, "paypal_capture_id": 1, "transaction_id": 1
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
            created_date, created_time, creation_hour = format_datetime_parts(doc.get("created_at"))
            payment_date, payment_time, payment_hour = format_datetime_parts(doc.get("processed_at"))

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

@app.get("/download-csv")
def download_csv(from_date: str = Query(...), to_date: str = Query(...)):
    try:
        # Validate date range (inclusive to 23:59:59 for to_date)
        from_dt = datetime.strptime(from_date, "%Y-%m-%d")
        to_dt = datetime.strptime(to_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
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
                r["date-hour"] = ist_ts.strftime("%Y-%m-%d %H:%M:%S")  # combined datetime for sheets
                r["ist-date"] = ist_ts.strftime("%d/%m/%Y")
                r["ist-hour"] = ist_ts.strftime("%H")

            rows_out.append(r)

        # Ensure consistent column order (existing cols first, then new cols)
        extra_cols = ["date", "hour", "date-hour", "ist-date", "ist-hour"]
        base_cols = [k for k in rows_out[0].keys() if k not in extra_cols]
        fieldnames = base_cols + extra_cols

        # Write CSV
        csv_file = io.StringIO()
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows_out)
        csv_file.seek(0)

        # Name is overridden by your frontend anyway; leaving static is fine
        headers = {"Content-Disposition": "attachment; filename=darkfantasy_orders.csv"}
        return StreamingResponse(csv_file, media_type="text/csv", headers=headers)

    except Exception as e:
        return Response(content=f"❌ Error: {str(e)}", media_type="text/plain", status_code=500)
    
@app.get("/download-xlsx")
def download_xlsx(from_date: str = Query(...), to_date: str = Query(...)):
    try:
        # Validate range
        from_dt = datetime.strptime(from_date, "%Y-%m-%d")
        to_dt = datetime.strptime(to_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
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
                r["date"]      = base_ts.strftime("%d/%m/%Y")
                r["hour"]      = base_ts.strftime("%H")
                r["date-hour"] = ist_ts.strftime("%Y-%m-%d %H:%M:%S")
                r["ist-date"]  = ist_ts.strftime("%d/%m/%Y")
                r["ist-hour"]  = ist_ts.strftime("%H")

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
            df.to_excel(writer, index=False, sheet_name="orders")
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
                    ec2_df = ec2_df.sort_values(
                        ["OnOff", "Name", "InstanceId"], ascending=[False, True, True]
                    )
                ec2_df.to_excel(writer, index=False, sheet_name="ec2_status")


            # Freeze panes (engine-specific)
            if engine == "xlsxwriter":
                ws1 = writer.sheets["orders"]
                ws2 = writer.sheets["pivot"]
                ws3 = writer.sheets.get("ec2_status")
                if ws1:ws1.freeze_panes(1, 0)  # row 2
                if ws2:ws2.freeze_panes(1, 1)  # row 2, col B
                if ws3:ws3.freeze_panes(1, 0)

            else:  # openpyxl
                ws1 = writer.sheets.get("orders")
                ws2 = writer.sheets.get("pivot")
                ws3 = writer.sheets.get("ec2_status")
                if ws1 is not None: ws1.freeze_panes = "A2"
                if ws2 is not None: ws2.freeze_panes = "B2"
                if ws3 is not None: ws3.freeze_panes = "A2"


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
    
def _export_xlsx_bytes(from_dt_utc: datetime, to_dt_utc: datetime) -> Tuple[bytes, str]:
    """
    Build an XLSX with:
      - 'orders'  : raw rows (with IST helper columns)
      - 'pivot'   : counts per (ist-date x ist-hour)
      - 'ec2_status' (or ec2_status_error)
    Returns (xlsx_bytes, filename).
    """
    # Query Mongo (exclude _id)
    mongo_filter = {TIMESTAMP_FIELD: {"$gte": from_dt_utc, "$lte": to_dt_utc}}
    projection = {"_id": 0}
    data = list(collection_df.find(mongo_filter, projection))

    rows_out = []
    if data:
        for row in data:
            r = dict(row)
            base_ts = _parse_dt(r.get(TIMESTAMP_FIELD))

            # Initialize helper columns
            r["date"] = ""
            r["hour"] = ""
            r["date-hour"] = ""
            r["ist-date"] = ""
            r["ist-hour"] = ""

            if base_ts is not None:
                ist_ts = base_ts + IST_OFFSET  # keep your assumption (DB time -> IST)
                r["date"]      = base_ts.strftime("%d/%m/%Y")        # UTC date (string)
                r["hour"]      = base_ts.strftime("%H")              # UTC hour
                r["date-hour"] = ist_ts.strftime("%Y-%m-%d %H:%M:%S")
                r["ist-date"]  = ist_ts.strftime("%d/%m/%Y")
                r["ist-hour"]  = ist_ts.strftime("%H")

            rows_out.append(r)

        df = pd.DataFrame(rows_out)
        filename = f"export_{from_dt_utc.strftime('%Y%m%d_%H%M%S')}_to_{to_dt_utc.strftime('%Y%m%d_%H%M%S')}.xlsx"
    else:
        # still generate a valid workbook
        df = pd.DataFrame([{"note": "No data found in this window"}])
        filename = f"export_empty_{from_dt_utc.date()}_{to_dt_utc.date()}.xlsx"

    # Ensure required columns exist for pivot parity
    for col in ["ist-date", "ist-hour", "room_id"]:
        if col not in df.columns:
            df[col] = ""

    # Build pivot: count of room_id by (ist-date x ist-hour)
    hours = [f"{h:02d}" for h in range(24)]
    try:
        df["ist-hour"] = df["ist-hour"].astype(str)
        pivot = pd.pivot_table(
            df, index="ist-date", columns="ist-hour",
            values="room_id", aggfunc="count", fill_value=0
        )
        pivot = pivot.reindex(columns=hours, fill_value=0)

        # sort ist-date as real dates when possible
        def _date_key(x):
            try:
                return datetime.strptime(x, "%d/%m/%Y")
            except Exception:
                return x
        pivot = pivot.sort_index(key=lambda idx: [_date_key(x) for x in idx])

        # add totals
        pivot["Total"] = pivot.sum(axis=1)
        pivot.loc["Total"] = pivot.sum(numeric_only=True)
    except Exception as e:
        # If something odd with columns, still continue with a minimal pivot
        pivot = pd.DataFrame([{"error": f"pivot build failed: {e}"}])

    # EC2 status
    ec2_rows, ec2_err = _get_ec2_status_rows()
    if ec2_err:
        ec2_df = pd.DataFrame([{"error": ec2_err}])
        ec2_sheet_name = "ec2_status_error"
    else:
        ec2_df = pd.DataFrame(ec2_rows)
        if not ec2_df.empty:
            ec2_df = ec2_df.sort_values(
                ["OnOff", "Name", "InstanceId"], ascending=[False, True, True]
            )
        ec2_sheet_name = "ec2_status"

    # Write workbook
    buf = BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="orders")
        pivot.to_excel(writer, sheet_name="pivot")
        ec2_df.to_excel(writer, index=False, sheet_name=ec2_sheet_name)

        # Freeze panes (openpyxl)
        ws1 = writer.sheets.get("orders")
        ws2 = writer.sheets.get("pivot")
        ws3 = writer.sheets.get(ec2_sheet_name)
        if ws1 is not None: ws1.freeze_panes = "A2"
        if ws2 is not None: ws2.freeze_panes = "B2"
        if ws3 is not None: ws3.freeze_panes = "A2"

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
        logger.error("EMAIL_TO is empty after parsing. Set EMAIL_TO='a@x.com,b@y.com'.")
        return


    msg = EmailMessage()
    msg["From"] = EMAIL_FROM
    msg["To"] = ", ".join(EMAIL_TO)
    msg["Subject"] = subject
    msg.set_content("This email contains HTML content. Please view in an HTML-capable client.")
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
        logger.info(f"SMTP: host={SMTP_HOST}:{SMTP_PORT} as={SMTP_USER} to={EMAIL_TO}")

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
        to_utc   = to_ist.astimezone(pytz.utc).replace(tzinfo=None)

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
        nxt_ist = nxt.astimezone(IST_TZ).strftime("%Y-%m-%d %H:%M:%S %Z") if nxt else None
        out.append({"id": j.id, "next_run_ist": nxt_ist, "trigger": str(j.trigger)})
    return out

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
    """UTC bounds for the IST calendar day 'days_ago' from today."""
    now_ist = datetime.now(IST)
    target_date = (now_ist - timedelta(days=days_ago)).date()   # e.g., yesterday for days_ago=1
    start_ist = datetime.combine(target_date, datetime.min.time(), tzinfo=IST)
    end_ist = start_ist + timedelta(days=6)
    return start_ist.astimezone(timezone.utc), end_ist.astimezone(timezone.utc)

@app.get("/debug/feedback-candidates")
def debug_feedback_candidates(days_ago: int = 6):
    start_utc, end_utc = _utc_bounds_for_ist_day(days_ago)

    pipeline = [
        {"$match": {
            "feedback_email": {"$ne": True},
            "shipping_option": "bluedart_in_domestic",
            "shipped_at": {"$exists": True, "$ne": None},
            "$or": [
                {"discount_code": {"$exists": False}},
                {"discount_code": {"$ne": "TEST"}}
            ],
        }},
        {"$addFields": {"shipped_dt": {"$toDate": "$shipped_at"}}},
        {"$match": {"shipped_dt": {"$gte": start_utc, "$lt": end_utc}}},
        {"$project": {
            "_id": 0,
            "order_id": 1, "job_id": 1, "email": 1,
            "user_name": 1, "name": 1, "gender": 1, "book_id": 1,
            "shipping_option": 1, "discount_code": 1,
            "shipped_at": 1, "shipped_dt": 1
        }},
        {"$sort": {"shipped_dt": 1, "order_id": 1}},
        {"$limit": 500},
    ]

    items = list(orders_collection.aggregate(pipeline))
    return {
        "ist_day": str((datetime.now(IST) - timedelta(days=days_ago)).date()),
        "bounds_utc": [start_utc.isoformat(), end_utc.isoformat()],
        "count": len(items),
        "candidates": items
    }

@app.post("/cron/feedback-emails")
def cron_feedback_emails(limit: int = 200):
    pipeline = [
        {"$match": {
            "feedback_email": {"$ne": True},
            "shipping_option": "bluedart_in_domestic",
            "shipped_at": {"$exists": True, "$ne": None},
            # discount_code != TEST (or missing)
            "$or": [
                {"discount_code": {"$exists": False}},
                {"discount_code": {"$ne": "TEST"}}
            ],
        }},
        # allow only: cust_status missing OR "green"
        {"$match": {
            "$or": [
                {"cust_status": {"$exists": False}},
                {"cust_status": "green"}
            ]
        }},
        {"$addFields": {"shipped_dt": {"$toDate": "$shipped_at"}}},
        # shipped_dt is 6–7 IST days ago
        {"$match": {"$expr": {
            "$and": [
                {"$gte": [
                    {"$dateDiff": {
                        "startDate": "$shipped_dt",
                        "endDate": "$$NOW",
                        "unit": "day",
                        "timezone": "Asia/Kolkata"
                    }},
                    6
                ]},
                {"$lt": [
                    {"$dateDiff": {
                        "startDate": "$shipped_dt",
                        "endDate": "$$NOW",
                        "unit": "day",
                        "timezone": "Asia/Kolkata"
                    }},
                    7
                ]}
            ]
        }}},
        {"$project": {
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
            "cust_status": 1
        }},
        {"$sort": {"shipped_dt": 1, "order_id": 1}},
        {"$limit": int(limit)}
    ]

    candidates = list(orders_collection.aggregate(pipeline))

    results = {"total": len(candidates), "sent": 0, "skipped": 0, "errors": 0, "details": []}
    for c in candidates:
        # Defensive guard in case status flips between query and send:
        if c.get("cust_status") == "red":
            results["skipped"] += 1
            results["details"].append({
                "job_id": c.get("job_id"),
                "order_id": c.get("order_id"),
                "status": "skipped",
                "reason": "cust_status red"
            })
            continue

        job_id = c.get("job_id")
        email = c.get("email")
        if not job_id or not email:
            results["skipped"] += 1
            results["details"].append({"job_id": job_id, "order_id": c.get("order_id"),
                                       "status": "skipped", "reason": "missing job_id or email"})
            continue

        try:
            send_feedback_email(job_id, BackgroundTasks())
            results["sent"] += 1
            results["details"].append({"job_id": job_id, "order_id": c.get("order_id"),
                                       "status": "sent", "email": email})
        except Exception as e:
            results["errors"] += 1
            results["details"].append({"job_id": job_id, "order_id": c.get("order_id"),
                                       "status": "error", "error": str(e)})

    return results
