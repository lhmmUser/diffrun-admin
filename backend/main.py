from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from bson import ObjectId
from dotenv import load_dotenv
import os
from fastapi.encoders import jsonable_encoder
from fastapi import Request, Query, HTTPException
from typing import Optional, List
from datetime import datetime, timezone, timedelta
import requests
import hashlib
import PyPDF2
import io
from collections import defaultdict
import smtplib
from email.message import EmailMessage
import logging
from fastapi.staticfiles import StaticFiles

# Setup logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # replace with specific domains if needed
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
    print(f"[DEBUG] Raw created_at value: {date_input}, type: {type(date_input)}")
    if not date_input:
        return ""
    try:
        # If it's a MongoDB date object (Python datetime)
        if isinstance(date_input, datetime):
            dt = date_input
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")
            print(f"[DEBUG] Formatted Python datetime: {formatted}")
            return formatted
        # If it's a MongoDB extended JSON
        if isinstance(date_input, dict):
            if '$date' in date_input and '$numberLong' in date_input['$date']:
                timestamp = int(date_input['$date']['$numberLong']) / 1000
                dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
                formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")
                print(f"[DEBUG] Formatted MongoDB extended JSON: {formatted}")
                return formatted
            elif 'date' in date_input:
                timestamp = int(date_input['date']['$numberLong']) / 1000 if '$numberLong' in date_input['date'] else int(date_input['date']) / 1000
                dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
                formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")
                print(f"[DEBUG] Formatted alternate MongoDB date: {formatted}")
                return formatted
        # If it's an ISO string
        elif isinstance(date_input, str):
            if date_input.strip() == "":
                return ""
            dt = datetime.fromisoformat(date_input.replace('Z', '+00:00'))
            formatted = dt.astimezone(IST).strftime("%d %b, %I:%M %p")
            print(f"[DEBUG] Formatted ISO string: {formatted}")
            return formatted
        else:
            print(f"[DEBUG] Unknown date format")
            return ""
    except Exception as e:
        print(f"[DEBUG] Error formatting date: {e}")
        return ""

MONGO_URI = os.getenv("MONGO_URI")
client = MongoClient(MONGO_URI)
db = client["candyman"]
orders_collection = db["user_details"]  # Changed back to user_details as that might be the correct collection

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
        "_id": 0
    }

    records = list(orders_collection.find(query, projection).sort(sort_field, sort_order))
    result = []

    for doc in records:
        print(f"Debug - Order {doc.get('order_id')} full document: {doc}")  # Debug log
        result.append({
            "order_id": doc.get("order_id", ""),
            "job_id": doc.get("job_id", ""),
            "coverPdf": doc.get("cover_url", ""),
            "interiorPdf": doc.get("book_url", ""),
            "previewUrl": doc.get("preview_url", ""),
            "name": doc.get("name", ""),
            "city": doc.get("shipping_address", {}).get("city", ""),
            "price": doc.get("price", doc.get("total_price", doc.get("amount", doc.get("total_amount", 0)))),
            "paymentDate": format_date(jsonable_encoder(doc.get("processed_at", ""))),
            "approvalDate": format_date(jsonable_encoder(doc.get("approved_at", ""))),
            "status": "Approved" if doc.get("approved") else "Uploaded",
            "bookId": doc.get("book_id", ""),
            "bookStyle": doc.get("book_style", ""),
            "printStatus": doc.get("print_status", ""),
            "feedback_email": doc.get("feedback_email", False)

        })

    return result


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
    """
    Download a PDF from a URL and count its pages.
    Returns the page count or 35 as fallback.
    """
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
    """
    Get the product code and reference based on book style.
    Returns a tuple of (reference, product_code)
    """
    if book_style == "paperback":  # Exact match with database value
        return ("Paperback", "photobook_pb_s210_s_fc")
    elif book_style == "hardcover":  # Exact match with database value
        return ("Hardcover", "photobook_cw_s210_s_fc")
    else:  # Fallback to hardcover if unknown
        return ("Hardcover", "photobook_cw_s210_s_fc")

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
                    "email": order.get("customer_email", ""),
                    "phone": order.get("shipping_address", {}).get("phone", "")
                }],
                "items": [{
                    "reference": reference,
                    "product": product_code,
                    "shipping_level": "cp_saver",
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
            # Make the API call to CloudPrinter
            response = requests.post(
                CLOUDPRINTER_API_URL,
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            response_data = response.json()

            print(f"CloudPrinter API Response (Status {response.status_code}): {response_data}")

            # Update order status in MongoDB if successful
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
            "printStatus": doc.get("print_status", "")
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
            timestamp = int(raw["$date"]["$numberLong"])
            return datetime.fromtimestamp(timestamp / 1000).strftime("%d %b, %Y")
        elif isinstance(raw, str) and raw.strip():
            return datetime.fromisoformat(raw).strftime("%d %b, %Y")
    except Exception as e:
        print(f"Error formatting approved_at: {e}")
    return "N/A"

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
          We truly hope {order.get("name", "").upper()} is enjoying their magical storybook! 
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
              Ordered: <span>{format_approved_date_for_email(order.get("approved_at", ""))}</span>
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
        msg["From"] = os.getenv("EMAIL_ADDRESS")
        msg["To"] = order.get("email", "")
        msg.set_content("This email contains HTML content.")
        msg.add_alternative(html_content, subtype="html")

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS")
            EMAIL_PASS = os.getenv("EMAIL_PASSWORD")
            smtp.login(EMAIL_ADDRESS, EMAIL_PASS)
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
        EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS")
        EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD")
        
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(EMAIL_ADDRESS, EMAIL_PASSWORD)
            smtp.send_message(msg)

        print(f"✅ Sent email to {to_email}")
    except Exception as e:
        print(f"❌ Error sending email to {to_email}: {e}")
