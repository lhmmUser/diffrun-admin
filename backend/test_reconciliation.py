import asyncio
import os

# make sure the environment is loaded (especially DB + Razorpay keys)
os.environ.setdefault("RAZORPAY_KEY_ID", "rzp_live_p23trocWYTRSaY")
os.environ.setdefault("RAZORPAY_KEY_SECRET", "XWPSbjqLZDUSz6Tmra5wmlJY")
os.environ.setdefault("BACKEND_INTERNAL_BASE", "http://127.0.0.1:8000")
# optional if you use timezone-aware code
os.environ.setdefault("TZ", "Asia/Kolkata")

# import your existing function and Mongo connection
from app.routers.reconcile import _auto_reconcile_and_sign_once

if __name__ == "__main__":
    print("Running auto reconciliation once...")
    try:
        asyncio.run(_auto_reconcile_and_sign_once())
        print("✅ Auto reconciliation task completed successfully.")
    except Exception as e:
        print(f"❌ Error running reconciliation: {e}")
