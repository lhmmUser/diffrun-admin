// src/app/(dashboard)/components/ReconcileUploader.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

// Backend base (no trailing slash)
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

// ---------- Local discount map (server should have its own copy as well) ----------
const DISCOUNT_MAP: Record<string, number> = {
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
  amount_display: string;     // e.g. "1.53"
  created_at: string;
  order_id: string | null;    // Razorpay order_id
  description: string | null;
  vpa: string | null;
  flow: string | null;
  rrn: string | null;
  arn: string | null;
  auth_code: string | null;
  job_id: string | null;      // From DB or extracted
  paid: boolean | null;       // From DB
  preview_url: string | null; // From DB

  // Optional if your backend enriches:
  discount_code?: string | null;
};

// -------------- Helpers --------------
const toNum = (v: string | undefined | null) => {
  if (v == null) return 0;
  const n = parseFloat(String(v).trim());
  return isNaN(n) ? 0 : n;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Resolve the discount code for a payment row without depending on Razorpay
 * percentage. We only infer the code text, then map to DISCOUNT_MAP.
 */
const extractDiscountCode = (d: PaymentDetail): string => {
  // 1) Prefer explicit field if present in the enriched detail
  if (d.discount_code) return String(d.discount_code).trim().toUpperCase();

  // 2) Try discovery from description (common in Razorpay notes/desc)
  const hay = (d.description || "").toUpperCase();
  for (const code of Object.keys(DISCOUNT_MAP)) {
    if (hay.includes(code)) return code;
  }

  // 3) Nothing found
  return "";
};

// --------------- Component ---------------
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

  // per-row verify state (auto only)
  const [verifyLoading, setVerifyLoading] = useState<Record<string, boolean>>({});
  const [verifyError, setVerifyError] = useState<Record<string, string | null>>({});
  const [verifySuccess, setVerifySuccess] = useState<Record<string, boolean>>({});

  // ---------- Reconcile fetch ----------
  async function runReconcile() {
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180_000);

    try {
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok || !json) {
        setErr((json as any)?.detail || (json as any)?.error || `Server error (${res.status})`);
        return;
      }
      setResult(json);
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
        const json = await res.json().catch(() => null);
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
      "paid","preview_url","order_id","job_id","vpa","flow","rrn","arn","auth_code","description"
    ];
    const rows = details.map(d => [
      d.id, d.email ?? "", d.contact ?? "", d.created_at ?? "",
      d.amount_display ?? "", d.currency ?? "", d.status ?? "", d.method ?? "",
      d.paid === null ? "" : d.paid ? "true" : "false",
      d.preview_url ?? "",
      d.order_id ?? "", d.job_id ?? "", d.vpa ?? "", d.flow ?? "",
      d.rrn ?? "", d.arn ?? "", d.auth_code ?? "", (d.description ?? "").replace(/\r?\n/g, " "),
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
    setDetails((prev) => prev.map((d) => (d.id === pid ? { ...d, paid: true } : d)));
  };

  // ---------- Auto verify flow (NO percentage from Razorpay; map from DISCOUNT_MAP only) ----------
  const autoVerify = async (d: PaymentDetail) => {
    const pid = d.id;
    const jobId = d.job_id;
    const orderId = d.order_id;

    if (!jobId) {
      setVerifyError((p) => ({ ...p, [pid]: "Missing job_id in row. Cannot verify." }));
      return;
    }
    if (!orderId) {
      setVerifyError((p) => ({ ...p, [pid]: "Missing razorpay_order_id in row. Cannot verify." }));
      return;
    }

    setVerifyLoading((p) => ({ ...p, [pid]: true }));
    setVerifyError((p) => ({ ...p, [pid]: null }));
    setVerifySuccess((p) => ({ ...p, [pid]: false }));

    // 1) Ask backend to sign (keeps secret server-side)
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), 30_000);
    try {
      const signRes = await fetch(`${API_BASE}/reconcile/sign-razorpay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl1.signal,
        body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: pid }),
      });
      const signJson = await signRes.json().catch(() => null);
      if (!signRes.ok || !signJson?.razorpay_signature) {
        setVerifyError((p) => ({ ...p, [pid]: (signJson as any)?.detail || `Failed to sign (HTTP ${signRes.status})` }));
        return;
      }

      // 2) Resolve discount code ONLY as text, then map percentage LOCALLY.
      const code = extractDiscountCode(d);          // e.g., "COLLAB"
      const pct = DISCOUNT_MAP[code] ?? 0;          // e.g., 99.93 for COLLAB

      // 3) Compute amounts ONLY from local map & displayed amount (no Razorpay percent)
      const actual = toNum(d.amount_display);       // "1.53" -> 1.53
      const shipping = 0;
      const taxes = 0;

      const discountAmount = round2((actual * pct) / 100);
      const finalAmount = round2(actual - discountAmount + shipping + taxes);

      // 4) Send payload to your backend; backend must treat server map as authoritative
      const payload: Record<string, any> = {
        razorpay_order_id: d.order_id,
        razorpay_payment_id: d.id,
        razorpay_signature: String(signJson.razorpay_signature),
        job_id: d.job_id,

        actual_price: actual.toFixed(2),
        discount_percentage: pct,                       // <-- from DISCOUNT_MAP only
        discount_amount: discountAmount.toFixed(2),
        shipping_price: shipping ? shipping : undefined,
        taxes: taxes ? taxes : undefined,
        final_amount: finalAmount.toFixed(2),
        discount_code: code || undefined,               // always include resolved code
      };

      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 60_000);
      try {
        const res = await fetch('https://test-backend.diffrun.com/verify-razorpay', {  // <-- use your configured backend
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl2.signal,
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json) {
          setVerifyError((p) => ({ ...p, [pid]: (json as any)?.error || `HTTP ${res.status}` }));
          return;
        }
        if (json.success === true) {
          setVerifySuccess((p) => ({ ...p, [pid]: true }));
          updateRowPaid(pid);
        } else {
          setVerifyError((p) => ({ ...p, [pid]: json.error || "Verification failed" }));
        }
      } finally {
        clearTimeout(t2);
      }
    } catch (e: any) {
      setVerifyError((p) => ({ ...p, [pid]: e?.name === "AbortError" ? "Signing timed out." : e?.message || "Signing failed" }));
    } finally {
      clearTimeout(t1);
      setVerifyLoading((p) => ({ ...p, [pid]: false }));
    }
  };

  // ---------- UI ----------
  return (
    <div className="space-y-5 p-5 border rounded-lg bg-white">
      <div className="grid md:grid-cols-4 gap-4 items-end">
        <div>
          <label className="block text-sm font-medium mb-1">From date (optional)</label>
          <input
            type="date"
            className="border rounded px-2 py-1 w-full"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">To date (optional)</label>
          <input
            type="date"
            className="border rounded px-2 py-1 w-full"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-6">
        <button
          onClick={runReconcile}
          className="px-4 py-2 rounded bg-black text-white disabled:opacity-50"
          disabled={loading}
        >
          {loading ? "Reconciling…" : "Run Reconcile"}
        </button>
        {!!result?.na_payment_ids?.length && (
          <button onClick={downloadDetailsCSV} className="px-3 py-2 rounded border text-sm">
            Download NA Details (CSV)
          </button>
        )}
      </div>

      {err && <p className="text-red-600">{err}</p>}

      {result && (
        <div className="mt-4 space-y-3">
          <div className="text-sm">
            <div>
              Payment Captured but Order not found (#N/A count):{" "}
              <strong className="text-red-700">{result.summary.na_count}</strong>
            </div>
            <div>
              Date window: <strong>{result.summary.date_window.from_date}</strong> →{" "}
              <strong>{result.summary.date_window.to_date}</strong>
            </div>
            <div>
              Orders (total docs scanned): <strong>{result.summary.total_orders_docs_scanned}</strong>
            </div>
            <div>
              Orders with <code>transaction_id</code>:{" "}
              <strong>{result.summary.orders_with_transaction_id}</strong>
            </div>
            <div>
              Payments fetched: <strong>{result.summary.total_payments_rows}</strong>
            </div>
          </div>

          <div className="mt-2">
            <h2 className="font-medium mb-1 text-sm">NA Payment IDs</h2>
            {naIds.length === 0 ? (
              <p className="text-sm text-gray-600">No NA payment IDs 🎉</p>
            ) : (
              <ul className="text-xs max-h-64 overflow-auto list-disc pl-5">
                {naIds.map((id) => (
                  <li key={id} className="break-all">{id}</li>
                ))}
              </ul>
            )}
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-gray-700">Show raw JSON</summary>
            <pre className="bg-gray-100 p-3 rounded text-xs overflow-auto mt-2">
{JSON.stringify(result, null, 2)}
            </pre>
          </details>

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
                  <table className="min-w-[1100px] w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left">
                        <th className="px-3 py-2">Payment ID</th>
                        <th className="px-3 py-2">Email</th>
                        <th className="px-3 py-2">Contact</th>
                        <th className="px-3 py-2">Payment Date</th>
                        <th className="px-3 py-2">Amount</th>
                        <th className="px-3 py-2">Currency</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Method</th>
                        <th className="px-3 py-2">Paid</th>
                        <th className="px-3 py-2">Preview</th>
                        <th className="px-3 py-2">job_id</th>
                        <th className="px-3 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {details.map((d) => {
                        const pid = d.id;
                        const vErr = verifyError[pid];
                        const vOk = !!verifySuccess[pid];
                        const vLoad = !!verifyLoading[pid];

                        const canVerify = d.paid === false && !!d.job_id;
                        const needsOrderId = !d.order_id;

                        return (
                          <tr key={pid} className="border-t">
                            <td className="px-3 py-2 font-mono">{d.id}</td>
                            <td className="px-3 py-2">{d.email ?? "—"}</td>
                            <td className="px-3 py-2">{d.contact ?? "—"}</td>
                            <td className="px-3 py-2">{d.created_at || "—"}</td>
                            <td className="px-3 py-2">{d.amount_display || "—"}</td>
                            <td className="px-3 py-2">{d.currency || "—"}</td>
                            <td className="px-3 py-2">{d.status || "—"}</td>
                            <td className="px-3 py-2">{d.method || "—"}</td>
                            <td className="px-3 py-2">{d.paid === null ? "—" : d.paid ? "true" : "false"}</td>
                            <td className="px-3 py-2">
                              {d.preview_url ? (
                                <a
                                  href={d.preview_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 underline"
                                >
                                  preview
                                </a>
                              ) : "—"}
                            </td>
                            <td className="px-3 py-2 font-mono">{d.job_id ?? "—"}</td>
                            <td className="px-3 py-2 space-x-2">
                              {canVerify ? (
                                <>
                                  <button
                                    onClick={() => autoVerify(d)}
                                    disabled={vLoad || needsOrderId}
                                    className="px-3 py-1.5 rounded border text-xs"
                                    title={needsOrderId ? "Missing razorpay_order_id — cannot auto-verify" : ""}
                                  >
                                    {vLoad ? "Verifying…" : "Auto Verify"}
                                  </button>
                                  {vOk && <span className="text-xs text-green-700 ml-2">✔ Paid</span>}
                                  {vErr && <span className="text-xs text-red-700 ml-2">{vErr}</span>}
                                </>
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
