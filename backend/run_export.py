# run_export.py
from datetime import datetime, timedelta
import os
import pytz

# IMPORTANT: this imports your function from main.py
from main import _export_xlsx_bytes

IST_TZ = pytz.timezone("Asia/Kolkata")

def main():
    # Align to the top of the current IST hour
    now_ist = datetime.now(IST_TZ)
    to_ist = now_ist.replace(minute=0, second=0, microsecond=0)
    from_ist = to_ist - timedelta(days=3)  # last 3 days

    # Convert IST -> naive UTC (your function expects naive UTC)
    from_utc = from_ist.astimezone(pytz.utc).replace(tzinfo=None)
    to_utc = to_ist.astimezone(pytz.utc).replace(tzinfo=None)

    # Run export
    xlsx_bytes, fname = _export_xlsx_bytes(from_utc, to_utc)

    # Save under exports/
    out_dir = os.path.join(os.path.dirname(__file__), "exports")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, fname)

    with open(out_path, "wb") as f:
        f.write(xlsx_bytes)

    print("✅ Export complete")
    print("File:", out_path)

if __name__ == "__main__":
    main()
