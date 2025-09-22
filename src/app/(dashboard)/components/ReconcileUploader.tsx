// src/app/(dashboard)/components/ReconcileUploader.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

// Backend base (no trailing slash)
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

// Timeouts (tweak via env if you need)
const SIGN_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_SIGN_TIMEOUT_MS ?? "30000");      // 30s
const VERIFY_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_VERIFY_TIMEOUT_MS ?? "180000"); // 3m

// ---------------- Types ----------------
type ApiResponse = {
  summary: {
    total_orders_docs_scanned: number;
    orders_with_transaction_id: number;
    total_payments_rows: number;
    filter_status: string;
    case_insensitive_ids: boolean;
    na_count: number;
    matched_count: number;
    max_fetch: number;
    date_window: { from_date: string; to_date: string };
  };
  na_payment_ids: string[];
};

type PaymentDetail = {
  id: string;                 // Razorpay payment_id
  email: string | null;
  contact: string | null;
  status: string | null;
  method: string | null;
  currency: string | null;
  amount_display: string;     // "1,750.00" or "₹1,750" etc (we'll parse)
  created_at: string;
  order_id: string | null;    // Razorpay order_id
  description: string | null;
  vpa: string | null;
  flow: string | null;
  rrn: string | null;
  arn: string | null;
  auth_code: string | null;

  // From DB (enriched by your /reconcile/na-payment-details)
  job_id: string | null;
  paid: boolean | null;
  preview_url: string | null;
  book_id?: string | null;     // <— needed for pricing
  book_style?: string | null;  // "paperback" | "hardcover"
};

// --------------- Pricing/Discount tables ---------------
/** Prices are strings in INR that may include ₹ and commas; we'll parse to number (INR) */
const BOOK_PRICING: Record<string, { paperback: { price: string; shipping: string; taxes: string }, hardcover: { price: string; shipping: string; taxes: string } }> = {
  astro: {
    paperback: { price: "₹1,750", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,250", shipping: "0", taxes: "0" },
  },
  hero: {
    paperback: { price: "₹1,650", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,200", shipping: "0", taxes: "0" },
  },
  bloom: {
    paperback: { price: "₹1,650", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,200", shipping: "0", taxes: "0" },
  },
  wigu: {
    paperback: { price: "₹1,650", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,200", shipping: "0", taxes: "0" },
  },
  twin: {
    paperback: { price: "₹1,650", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,200", shipping: "0", taxes: "0" },
  },
  dream: {
    paperback: { price: "₹1,650", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,200", shipping: "0", taxes: "0" },
  },
  sports: {
    paperback: { price: "₹1,650", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,200", shipping: "0", taxes: "0" },
  },
  abcd: {
    paperback: { price: "₹1,650", shipping: "0", taxes: "0" },
    hardcover: { price: "₹2,200", shipping: "0", taxes: "0" },
  },
};

const DISCOUNT_PCT: Record<string, number> = {
  LHMM: 99.93,
  LHMM50: 50,
  SPECIAL10: 10,
  LEMON20: 20,
  TEST: 99.93,
  COLLAB: 99.93,
  SUKHKARMAN5: 5,
  WELCOME5: 5,
  SAM5: 5,
  SUBSCRIBER10: 10,
  MRSNAMBIAR15: 15,
  AKMEMON15: 15,
  TANVI15: 15,
  PERKY15: 15,
  SPECIAL15: 15,
  JISHU15: 15,
  JESSICA15: 15,
};

// ---------------- Utilities ----------------
const parseINR = (s?: string | null): number | undefined => {
  if (!s) return undefined;
  const cleaned = s.replace(/[₹,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

async function resolveBookMeta(jobId: string | null | undefined, apiBase: string) {
  if (!jobId) {
    console.warn("[META] No job_id provided, cannot resolve book meta");
    return { book_id: undefined, book_style: undefined };
  }
  const url = `${apiBase}/orders/meta/by-job/${encodeURIComponent(jobId)}`;
  console.log("[META] GET:", url);
  try {
    const res = await fetch(url, { method: "GET" });
    console.log("[META] status:", res.status);
    const json = await res.json().catch(() => null);
    console.log("[META] json:", json);
    if (!res.ok || !json) {
      console.warn("[META] failed to resolve book meta:", json);
      return { book_id: undefined, book_style: undefined };
    }
    const book_id = (json.book_id ?? json.bookId ?? "").toString() || undefined;
    const book_style = (json.book_style ?? json.bookStyle ?? "").toString() || undefined;
    return { book_id, book_style };
  } catch (e: any) {
    console.error("[META] exception while resolving book meta:", e?.message || e);
    return { book_id: undefined, book_style: undefined };
  }
}

const getBookPricing = (bookId?: string | null, style?: string | null) => {
  const key = (bookId || "").toLowerCase();
  const st = (style || "").toLowerCase() as "paperback" | "hardcover";
  const conf = BOOK_PRICING[key];
  if (!conf) return undefined;
  if (st !== "paperback" && st !== "hardcover") return undefined;
  return conf[st];
};

// ---------------- Component ----------------
export default function ReconcileUploader() {
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [details, setDetails] = useState<PaymentDetail[]>([]);
  const [detailsErr, setDetailsErr] = useState<string | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const [status] = useState<string>("");
  const [caseInsensitive] = useState(false);
  const [maxFetch] = useState<number>(50000);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  // ---------- Reconcile fetch ----------
  async function runReconcile() {
    console.log("[RECONCILE] Run");
    console.log("API_BASE:", API_BASE);
    setErr(null);
    setResult(null);
    setDetails([]);
    setDetailsErr(null);
    setLoading(true);

    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (caseInsensitive) qs.set("case_insensitive_ids", "true");
    if (maxFetch) qs.set("max_fetch", String(maxFetch));
    if (fromDate) qs.set("from_date", fromDate);
    if (toDate) qs.set("to_date", toDate);

    const url = `${API_BASE}/reconcile/vlookup-payment-to-orders/auto${qs.toString() ? `?${qs}` : ""}`;
    console.log("GET:", url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180_000);

    try {
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      console.log("Response status:", res.status);
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      console.log("Response JSON:", json);
      if (!res.ok || !json) {
        setErr((json as any)?.detail || (json as any)?.error || `Server error (${res.status})`);
        return;
      }
      setResult(json);
      const ids = json.na_payment_ids || [];
      console.log("NA count:", ids.length, "IDs:", ids.length);
    } catch (e: any) {
      setErr(e?.name === "AbortError" ? "Request timed out." : e?.message || "Network error");
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  const naIds = useMemo(() => result?.na_payment_ids ?? [], [result]);

  // ---------- Enriched details ----------
  useEffect(() => {
    if (!naIds || naIds.length === 0) {
      setDetails([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    (async () => {
      console.log("[DETAILS] Fetch NA payment details");
      console.log("POST:", `${API_BASE}/reconcile/na-payment-details`);
      console.log("IDs:", naIds);
      setLoadingDetails(true);
      setDetailsErr(null);
      setDetails([]);
      try {
        const res = await fetch(`${API_BASE}/reconcile/na-payment-details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ ids: naIds }),
        });
        console.log("Status:", res.status);
        const json = await res.json().catch(() => null);
        console.log("JSON items length:", json?.items?.length);
        if (!res.ok || !json) {
          setDetailsErr((json as any)?.detail || "Failed to fetch payment details");
          return;
        }
        const items = (json.items || []) as PaymentDetail[];
        setDetails(items);
        if (json.errors?.length) {
          setDetailsErr(`Some IDs failed to fetch (${json.errors.length}).`);
        }
      } catch (e: any) {
        setDetailsErr(e?.name === "AbortError" ? "Details fetch timed out." : e?.message || "Network error");
      } finally {
        clearTimeout(timer);
        setLoadingDetails(false);
      }
    })();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [naIds]);

  // ---------- CSV export ----------
  const downloadDetailsCSV = () => {
    if (!details?.length) return;
    const header = [
      "id","email","contact","created_at","amount","currency","status","method",
      "paid","preview_url","order_id","job_id","book_id","book_style",
      "vpa","flow","rrn","arn","auth_code","description"
    ];
    const rows = details.map(d => [
      d.id, d.email ?? "", d.contact ?? "", d.created_at ?? "",
      d.amount_display ?? "", d.currency ?? "", d.status ?? "", d.method ?? "",
      d.paid === null ? "" : d.paid ? "true" : "false",
      d.preview_url ?? "", d.order_id ?? "", d.job_id ?? "", d.book_id ?? "", d.book_style ?? "",
      d.vpa ?? "", d.flow ?? "", d.rrn ?? "", d.arn ?? "", d.auth_code ?? "", (d.description ?? "").replace(/\r?\n/g, " "),
    ]);
    const csv = [header.join(","), ...rows.map(r => r.map(v => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","))].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "na_payment_details.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateRowPaid = (pid: string) => {
    console.log("[UI] Marking row as paid:", pid);
    setDetails((prev) => prev.map((d) => (d.id === pid ? { ...d, paid: true } : d)));
  };

  
const autoVerify = async (d: PaymentDetail) => {
  const pid = d.id;
  const jobId = d.job_id;
  const orderId = d.order_id;

  if (!jobId) {
    console.error("[AUTO VERIFY] Missing job_id in row", d);
    return;
  }
  if (!orderId) {
    console.error("[AUTO VERIFY] Missing razorpay_order_id in row", d);
    return;
  }

  const t0 = performance.now();
  console.log("[AUTO VERIFY]", pid, "Row data:", d);

  try {
    // 1) Get server signature
    const signRes = await fetch(`${API_BASE}/reconcile/sign-razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: pid }),
    });
    const signJson = await signRes.json().catch(() => null);
    console.log("[SIGN RESPONSE]", signRes.status, signJson);
    if (!signRes.ok || !signJson?.razorpay_signature) {
      console.error("[SIGN ERROR]", pid, signJson);
      return;
    }

    // 2) Resolve discount_code from Razorpay
    console.log("[DISCOUNT] resolve for", pid);
    const discountRes = await fetch(`${API_BASE}/razorpay/payments/by-ids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [pid] }),
    });
    const discountJson = await discountRes.json().catch(() => null);
    console.log("[DISCOUNT RESPONSE]", discountRes.status, discountJson);

    const discount_code =
      discountJson?.items?.[0]?.notes?.discount_code?.toUpperCase?.() || "";
    const discountPct = DISCOUNT_PCT[discount_code] ?? 0; // <-- use the right map
    console.log("[DISCOUNT LOOKUP]", { code: discount_code, pct: discountPct });

    // 3) Book meta (prefer row; fall back to DB)
    let bookId = d.book_id || undefined;
    let bookStyle = d.book_style || undefined;
    if (!bookId || !bookStyle) {
      const meta = await resolveBookMeta(jobId, API_BASE);
      bookId = meta.book_id || bookId;
      bookStyle = meta.book_style || bookStyle;
    }
    console.log("[BOOK META]", { bookId, bookStyle });

    // 4) Pricing (use BOOK_PRICING via helper)
    const conf = getBookPricing(bookId, bookStyle); // returns { price, shipping, taxes } or undefined
    if (!conf) {
      console.warn("[PRICING] Missing mapping for", { book_id: bookId, book_style: bookStyle }, "— falling back to paid amount as actual_price");
    }

    const paidAmount = parseINR(d.amount_display) ?? 0;                // amount collected by Razorpay (total_price)
    const actualPrice = conf ? (parseINR(conf.price) ?? paidAmount) : paidAmount; // list price from table
    const shipping = conf ? (parseINR(conf.shipping) ?? 0) : 0;
    const taxes = conf ? (parseINR(conf.taxes) ?? 0) : 0;

    // 5) Compute discount & final
    const discountAmount = round2((discountPct / 100) * actualPrice);
    const finalAmount = round2(actualPrice - discountAmount + shipping + taxes);

    console.log("[PRICING CALC]", {
      actualPrice,
      paidAmount,
      discountPct,
      discountAmount,
      finalAmount,
      shipping,
      taxes,
    });

    // 6) Send to /verify-razorpay
    const payload = {
      razorpay_order_id: orderId,
      razorpay_payment_id: pid,
      razorpay_signature: signJson.razorpay_signature,
      job_id: jobId,

      // pricing fields
      actual_price: actualPrice,
      discount_code,
      discount_percentage: discountPct,
      discount_amount: discountAmount,
      final_amount: finalAmount,
      shipping_price: shipping,
      taxes,
    };

    console.log("[VERIFY REQUEST PAYLOAD]", payload);

    const verifyRes = await fetch('https://test-backend.diffrun.com/verify-razorpay', {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const verifyJson = await verifyRes.json().catch(() => null);
    console.log("[VERIFY RESPONSE]", verifyRes.status, verifyJson);

    // after:
if (verifyRes.ok && verifyJson?.success) {
  console.log("[UI] Marking row as paid:", pid);
  setDetails((prev) => prev.map((row) => (row.id === pid ? { ...row, paid: true } : row)));

  // NEW: mark reconciled
  try {
    const flagPayload = { job_id: jobId, razorpay_payment_id: pid };
    console.log("[RECONCILE FLAG] POST", `${API_BASE}/reconcile/mark`, "payload:", flagPayload);

    const flagRes = await fetch(`${API_BASE}/reconcile/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flagPayload),
    });
    const flagJson = await flagRes.json().catch(() => null);
    console.log("[RECONCILE FLAG] status:", flagRes.status, "json:", flagJson);

    if (!flagRes.ok || !flagJson?.ok) {
      console.error("[RECONCILE FLAG] failed:", flagJson);
    }
  } catch (e: any) {
    console.error("[RECONCILE FLAG] exception:", e?.message || e);
  }
} else {
  console.error("[VERIFY ERROR]", pid, verifyJson);
}

  } catch (err: any) {
    console.error("[AUTO VERIFY ERROR]", pid, err);
  } finally {
    const elapsed = performance.now() - t0;
    console.log(`[TIMING] ${pid} took ${elapsed.toFixed(2)} ms`);
  }
};



  // ---------- UI ----------
  return (
    <div className="space-y-5 p-5 border rounded-lg bg-white">
      <div className="grid md:grid-cols-4 gap-4 items-end">
        <div>
          <label className="block text-sm font-medium mb-1">From date (optional)</label>
          <input type="date" className="border rounded px-2 py-1 w-full" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">To date (optional)</label>
          <input type="date" className="border rounded px-2 py-1 w-full" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>

      <div className="flex items-center gap-6">
        <button onClick={runReconcile} className="px-4 py-2 rounded bg-black text-white disabled:opacity-50" disabled={loading}>
          {loading ? "Reconciling…" : "Run Reconcile"}
        </button>
        {!!result?.na_payment_ids?.length && (
          <button onClick={downloadDetailsCSV} className="px-3 py-2 rounded border text-sm">Download NA Details (CSV)</button>
        )}
      </div>

      {err && <p className="text-red-600">{err}</p>}

      {result && (
        <div className="mt-4 space-y-3">
          <div className="text-sm">
            <div>Payment Captured but Order not found (#N/A count): <strong className="text-red-700">{result.summary.na_count}</strong></div>
            <div>Date window: <strong>{result.summary.date_window.from_date}</strong> → <strong>{result.summary.date_window.to_date}</strong></div>
            
            <div>Payments fetched: <strong>{result.summary.total_payments_rows}</strong></div>
          </div>

          <div className="mt-2">
            <h2 className="font-medium mb-1 text-sm">NA Payment IDs</h2>
            {naIds.length === 0 ? (
              <p className="text-sm text-gray-600">No NA payment IDs 🎉</p>
            ) : (
              <ul className="text-xs max-h-64 overflow-auto list-disc pl-5">
                {naIds.map((id) => (<li key={id} className="break-all">{id}</li>))}
              </ul>
            )}
          </div>

          

          {!!naIds.length && (
            <div className="mt-6">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">NA Payment Details</h3>
                {loadingDetails && <span className="text-xs text-gray-500">Loading details…</span>}
                {detailsErr && <span className="text-xs text-red-600">{detailsErr}</span>}
              </div>

              {details.length === 0 && !loadingDetails ? (
                <p className="text-sm text-gray-600 mt-2">No details available.</p>
              ) : (
                <div className="overflow-auto border rounded mt-2">
                  <table className="min-w-[1350px] w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left">
                        <th className="px-2 py-2">Payment ID</th>
                        <th className="px-2 py-2">Email</th>
                       
                        <th className="px-2 py-2">Payment Date</th>
                        <th className="px-2 py-2">Amount (paid)</th>
                        
                        <th className="px-2 py-2">Paid</th>
                        <th className="px-2 py-2">Preview</th>
                        <th className="px-2 py-2">job_id</th>
                        
                        <th className="px-2 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {details.map((d) => {
                        const canVerify = d.paid === false && !!d.job_id;
                        const needsOrderId = !d.order_id;
                        return (
                          <tr key={d.id} className="border-t">
                            <td className="px-2 py-2 font-mono">{d.id}</td>
                            <td className="px-2 py-2">{d.email ?? "—"}</td>

                            <td className="px-2 py-2">{d.created_at || "—"}</td>
                            <td className="px-2 py-2">{d.amount_display || "—"}</td>

                            <td className="px-2 py-2">{d.paid === null ? "—" : d.paid ? "true" : "false"}</td>
                            <td className="px-2 py-2">
                              {d.preview_url ? (
                                <a href={d.preview_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">preview</a>
                              ) : "—"}
                            </td>
                            
                            <td className="px-2 py-2">{d.job_id ?? "—"}</td>
                            <td className="px-2 py-2">
                              {canVerify ? (
                                <button
                                  onClick={() => autoVerify(d)}
                                  disabled={needsOrderId}
                                  className="px-2 py-1.5 rounded border text-xs"
                                  title={needsOrderId ? "Missing razorpay_order_id — cannot auto-verify" : ""}
                                >
                                  Auto Verify
                                </button>
                              ) : (
                                <span className="text-xs text-gray-400">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
