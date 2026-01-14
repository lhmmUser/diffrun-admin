"use client";

import { useEffect, useMemo, useState } from "react";

type RangeKey = "1d" | "1w" | "1m" | "6m" | "this_month" | "custom";
type CountryCode = "IN" | "AE" | "CA" | "US" | "GB" | "IN_ONLY";

type OrderRow = {
  date: string;
  total: number;

  unapproved: number;
  unapproved_ids?: string[];

  sent_to_print: number;
  sent_to_print_ids?: string[];

  new: number;
  new_ids?: string[];

  shipped: number;
  shipped_ids?: string[];

  delivered: number;
  delivered_ids?: string[];

  cancelled: number;
  cancelled_ids?: string[];

  rejected: number;
  rejected_ids?: string[];

  refunded: number;
  refunded_ids?: string[];

  reprint: number;
  reprint_ids?: string[];
};

export default function OrderStatusPage() {
  const baseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

  const todayISO = new Date().toISOString().slice(0, 10);
  const monthAgoISO = new Date(Date.now() - 30 * 86400000)
    .toISOString()
    .slice(0, 10);

  const [range, setRange] = useState<RangeKey>("1m");
  const [startDate, setStartDate] = useState<string>(monthAgoISO);
  const [endDate, setEndDate] = useState<string>(todayISO);
  const [customApplied, setCustomApplied] = useState(false);

  const [country] = useState<CountryCode>("IN_ONLY");

  const [rows, setRows] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  const isCustomInvalid =
    range === "custom" && !!startDate && !!endDate && startDate > endDate;

  const canFetch = useMemo(() => {
    if (range !== "custom") return true;
    if (isCustomInvalid) return false;
    return customApplied;
  }, [range, isCustomInvalid, customApplied]);

  const buildOrderStatusUrl = (r: RangeKey) => {
    const params = new URLSearchParams();

    if (r === "custom") {
      params.append("start_date", startDate);
      params.append("end_date", endDate);
    } else {
      params.append("range", r);
    }

    params.append("printer", "all");
    params.append("loc", country);

    return `${baseUrl}/stats/order-status?${params.toString()}`;
  };

  const parseRows = (json: any): OrderRow[] => {
    const rows: any[] = Array.isArray(json?.rows) ? json.rows : [];

    return rows
      .map((r) => ({
        date: r.date,
        total: r.total ?? 0,

        unapproved: r.unapproved ?? 0,
        unapproved_ids: r.unapproved_ids ?? [],

        sent_to_print: r.sent_to_print ?? 0,
        sent_to_print_ids: r.sent_to_print_ids ?? [],

        new: r.new ?? 0,
        new_ids: r.new_ids ?? [],

        shipped: r.shipped ?? 0,
        shipped_ids: r.shipped_ids ?? [],

        delivered: r.delivered ?? 0,
        delivered_ids: r.delivered_ids ?? [],

        cancelled: r.cancelled ?? 0,
        cancelled_ids: r.cancelled_ids ?? [],

        rejected: r.rejected ?? 0,
        rejected_ids: r.rejected_ids ?? [],

        refunded: r.refunded ?? 0,
        refunded_ids: r.refunded_ids ?? [],

        reprint: r.reprint ?? 0,
        reprint_ids: r.reprint_ids ?? [],
      }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  };

  useEffect(() => {
    if (!canFetch) return;

    setLoading(true);
    setError("");

    fetch(buildOrderStatusUrl(range), { cache: "no-store" })
      .then((r) => {
        if (!r.ok)
          return r.text().then((txt) => Promise.reject(txt || r.status));
        return r.json();
      })
      .then((json) => {
        setRows(parseRows(json));
      })
      .catch((err) => {
        console.error("order-status fetch error:", err);
        setError(String(err));
      })
      .finally(() => setLoading(false));
  }, [baseUrl, range, startDate, endDate, canFetch, country]);

  const handleRefresh = () => {
    if (!canFetch) return;

    setLoading(true);
    setError("");

    fetch(buildOrderStatusUrl(range), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText || r.status)))
      .then((json) => setRows(parseRows(json)))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  };

  const goToOrders = (ids: string[]) => {
    if (!ids || ids.length === 0) return;

    const params = new URLSearchParams();
    ids.forEach((id) => params.append("order_ids", id));

    window.location.href = `/Shipment_orders?${params.toString()}`;
  };

  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800 mb-4">
        Order Status
      </h1>

      {/* Range Controls */}
      <div className="flex flex-col md:flex-row items-start md:items-end gap-3 mb-4">
        <div>
          <label className="block text-sm text-slate-600 mb-1">Range</label>
          <select
            value={range}
            onChange={(e) => {
              const val = e.target.value as RangeKey;
              setRange(val);
              if (val === "custom") setCustomApplied(false);
              else setCustomApplied(true);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm"
          >
            <option value="1d">1 day</option>
            <option value="1w">Last 7 days</option>
            <option value="1m">Last 30 days</option>
            <option value="this_month">This month</option>
            <option value="6m">6 months (~182d)</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        {range === "custom" && (
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Start date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setCustomApplied(false);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                End date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setCustomApplied(false);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={() => setCustomApplied(true)}
              disabled={isCustomInvalid}
              className={`h-10 px-4 rounded-lg text-white ${
                isCustomInvalid
                  ? "bg-slate-400 cursor-not-allowed"
                  : "bg-slate-800 hover:bg-slate-700"
              }`}
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-red-600 mb-2 text-sm">Error: {error}</p>}

      {!loading && rows.length > 0 && (
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 w-full">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-slate-800">
              Order Status India
            </h3>
            <button
              onClick={handleRefresh}
              className="text-sm px-3 py-1 rounded bg-slate-100 hover:bg-slate-200"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-y-auto h-[calc(100vh-280px)] border rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white z-10 shadow-sm">
                <tr className="text-left text-slate-600 border-b">
                  <th className="p-2">Date</th>
                  <th className="p-2">New</th>
                  <th className="p-2">Sent to Print</th>
                  <th className="p-2">Cancelled</th>
                  <th className="p-2">Rejected</th>
                  <th className="p-2">Refunded</th>
                  <th className="p-2">Reprint</th>
                  <th className="p-2">Shipped</th>
                  <th className="p-2">Delivered</th>
                  <th className="p-2">Total</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((r) => (
                  <tr key={r.date} className="border-t hover:bg-slate-50">
                    <td className="p-2">{r.date}</td>

                    {/* New */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.unapproved_ids || [])}
                    >
                      {r.unapproved}
                    </td>

                    {/* Sent to Print */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.sent_to_print_ids || [])}
                    >
                      {r.sent_to_print}
                    </td>

                    {/* Cancelled */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.cancelled_ids || [])}
                    >
                      {r.cancelled}
                    </td>

                    {/* Rejected */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.rejected_ids || [])}
                    >
                      {r.rejected}
                    </td>

                    {/* Refunded */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.refunded_ids || [])}
                    >
                      {r.refunded}
                    </td>

                    {/* Reprint */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.reprint_ids || [])}
                    >
                      {r.reprint}
                    </td>

                    {/* Shipped */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.shipped_ids || [])}
                    >
                      {r.shipped}
                    </td>

                    {/* Delivered */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => goToOrders(r.delivered_ids || [])}
                    >
                      {r.delivered}
                    </td>

                    {/* Total */}
                    <td className="p-2 font-medium">{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {loading && <p className="text-sm text-slate-500">Loading…</p>}
    </main>
  );
}
