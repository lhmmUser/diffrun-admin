"use client";

import { useEffect, useMemo, useState } from "react";

type RangeKey = "1d" | "1w" | "1m" | "6m" | "this_month" | "custom";
type CountryCode = "IN" | "AE" | "CA" | "US" | "GB" | "IN_ONLY";

type ShipRow = {
  date: string;
  total: number;

  unapproved: number;
  unapproved_ids?: string[];

  sent_to_print: number;
  sent_to_print_ids?: string[];

  new: number;
  new_ids?: string[];

  out_for_pickup: number;
  out_for_pickup_ids?: string[];

  pickup_exception: number;
  pickup_exception_ids?: string[];

  shipped: number;
  shipped_ids?: string[];

  delivered: number;
  delivered_ids?: string[];

  issue: number;
  issue_ids?: string[];
};

type PendingAgeRow = {
  label: string;
  value: number;
  order_ids: string[];
};


export default function ShipmentStatusPage() {
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

  const [shipRows, setShipRows] = useState<ShipRow[]>([]);
  const [shipError, setShipError] = useState<string>("");
  const [shipLoading, setShipLoading] = useState<boolean>(false);

  const [pendingAgeChart, setPendingAgeChart] = useState<PendingAgeRow[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalDate, setModalDate] = useState("");
  const [modalStatus, setModalStatus] = useState("");
  const [modalIds, setModalIds] = useState<string[]>([]);

  const isCustomInvalid =
    range === "custom" && !!startDate && !!endDate && startDate > endDate;

  const canFetch = useMemo(() => {
    if (range !== "custom") return true;
    if (isCustomInvalid) return false;
    return customApplied;
  }, [range, isCustomInvalid, customApplied]);

  const buildShipStatusUrl = (r: RangeKey) => {
    const params = new URLSearchParams();
    if (r === "custom") {
      params.append("start_date", startDate);
      params.append("end_date", endDate);
    } else {
      params.append("range", r);
    }
    params.append("printer", "all");
    params.append("loc", country);
    return `${baseUrl}/stats/ship-status-v2?${params.toString()}`;
  };

  const parseRows = (json: any): ShipRow[] => {
    const rows: any[] = Array.isArray(json?.rows) ? json.rows : [];

    return rows
      .map((r) => {
        return {
          date: r.date,
          total: r.total ?? 0,

          unapproved: r.unapproved ?? 0,
          unapproved_ids: r.unapproved_ids ?? [],

          sent_to_print: r.sent_to_print ?? 0,
          sent_to_print_ids: r.sent_to_print_ids ?? [],

          new: r.new ?? 0,
          new_ids: r.new_ids ?? [],

          out_for_pickup: r.out_for_pickup ?? 0,
          out_for_pickup_ids: r.out_for_pickup_ids ?? [],

          pickup_exception: r.pickup_exception ?? 0,
          pickup_exception_ids: r.pickup_exception_ids ?? [],

          shipped: r.shipped ?? 0,
          shipped_ids: r.shipped_ids ?? [],

          delivered: r.delivered ?? 0,
          delivered_ids: r.delivered_ids ?? [],

          issue: r.issue ?? 0,
          issue_ids: r.issue_ids ?? [],
        } as ShipRow;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  };

  useEffect(() => {
    if (!canFetch) return;

    setShipLoading(true);
    setShipError("");

    fetch(buildShipStatusUrl(range), { cache: "no-store" })
      .then((r) => {
        if (!r.ok)
          return r.text().then((txt) => Promise.reject(txt || r.status));
        return r.json();
      })
      .then((json) => {
        setShipRows(parseRows(json));
        setPendingAgeChart(json.pending_age_chart || []);
      })
      .catch((err) => {
        console.error("ship-status-v2 fetch error:", err);
        setShipError(String(err));
      })
      .finally(() => setShipLoading(false));
  }, [baseUrl, range, startDate, endDate, canFetch, country]);

  const handleRefresh = () => {
    if (!canFetch) return;
    setShipLoading(true);
    setShipError("");

    fetch(buildShipStatusUrl(range), { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(r.statusText || r.status)
      )
      .then((json) => setShipRows(parseRows(json)))
      .catch((err) => setShipError(String(err)))
      .finally(() => setShipLoading(false));
  };

  const openModal = (date: string, status: string, ids: string[]) => {
    setModalDate(date);
    setModalStatus(status);
    setModalIds(ids);
    setModalOpen(true);
  };

  const goToShipmentOrders = (ids: string[]) => {
    if (!ids || ids.length === 0) return;
    const params = new URLSearchParams();
    ids.forEach(id => params.append("order_ids", id));
    window.location.href = `/Shipment_orders?${params.toString()}`;
  };

  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800 mb-4">
        Shipment Status
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
              className={`h-10 px-4 rounded-lg text-white ${isCustomInvalid
                ? "bg-slate-400 cursor-not-allowed"
                : "bg-slate-800 hover:bg-slate-700"
                }`}
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {shipError && (
        <p className="text-red-600 mb-2 text-sm">Error: {shipError}</p>
      )}

      {/* TABLE + NEW REQUIREMENT */}
      {!shipLoading && shipRows.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* LEFT: EXISTING TABLE — UNCHANGED */}
          <div>
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 w-full">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-slate-800">
                  Shipment Status India
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
                      <th className="p-2">Out for Pickup</th>
                      <th className="p-2">Pickup Exception</th>
                      <th className="p-2">Shipped</th>
                      <th className="p-2">Issue</th>
                      <th className="p-2">Delivered</th>
                      <th className="p-2">Total</th>
                    </tr>
                  </thead>

                  <tbody>
                    {shipRows.map((r) => (
                      <tr key={r.date} className="border-t hover:bg-slate-50">
                        <td className="p-2">{r.date}</td>

                        <td className="p-2 text-blue-600 cursor-pointer"
                          onClick={() => goToShipmentOrders(r.unapproved_ids || [])}>
                          {r.unapproved}
                        </td>

                        <td className="p-2 text-blue-600 cursor-pointer"
                          onClick={() => goToShipmentOrders(r.sent_to_print_ids || [])}>
                          {r.sent_to_print}
                        </td>

                        <td className="p-2 text-blue-600 cursor-pointer"
                          onClick={() => goToShipmentOrders(r.out_for_pickup_ids || [])}>
                          {r.out_for_pickup}
                        </td>

                        <td className="p-2 text-blue-600 cursor-pointer"
                          onClick={() => goToShipmentOrders(r.pickup_exception_ids || [])}>
                          {r.pickup_exception}
                        </td>

                        <td className="p-2 text-blue-600 cursor-pointer"
                          onClick={() => goToShipmentOrders(r.shipped_ids || [])}>
                          {r.shipped}
                        </td>

                        <td className="p-2 text-blue-600 cursor-pointer"
                          onClick={() => goToShipmentOrders(r.issue_ids || [])}>
                          {r.issue}
                        </td>

                        <td className="p-2 text-blue-600 cursor-pointer"
                          onClick={() => goToShipmentOrders(r.delivered_ids || [])}>
                          {r.delivered}
                        </td>

                        <td className="p-2 font-medium">{r.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div>
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
              <h3 className="text-lg font-medium text-slate-800 mb-4">
                Orders by Age
              </h3>

              {pendingAgeChart.length === 0 ? (
                <p className="text-sm text-slate-500">No pending orders</p>
              ) : (
                <>
                  {(() => {
                    // ✅ define max ONCE (fixes TS error + performance)
                    const max = Math.max(
                      ...pendingAgeChart.map((d) => d.value),
                      1
                    );

                    return (
                      <div className="overflow-y-auto h-[calc(100vh-340px)] pr-2 space-y-4">
                        {pendingAgeChart.map((row) => (
                          <div
                            key={row.label}   // ✅ fixes React key warning
                            className="flex items-center gap-3"
                          >
                            {/* Label */}
                            <div className="w-16 text-sm font-medium text-blue-600">
                              {row.label}
                            </div>

                            {/* Bar + Count */}
                            <div className="flex items-center gap-2 flex-1">
                              <div
                                className="h-4 bg-blue-600 rounded-sm cursor-pointer"
                                style={{
                                  width: `${(row.value / max) * 100}%`,
                                }}
                                onClick={() =>
                                  goToShipmentOrders(row.order_ids)
                                }
                              />
                              <span className="text-sm text-slate-800 font-medium">
                                {row.value}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </>
              )}
            </section>
          </div>
        </div>
      )}


      {/* Loading */}
      {shipLoading && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center p-4 z-[9999]">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-semibold mb-3">
              {modalStatus} Orders on {modalDate}
            </h2>

            {modalIds.length === 0 ? (
              <p className="text-sm text-slate-500">No orders.</p>
            ) : (
              <ul className="list-disc ml-6 text-sm">
                {modalIds.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            )}

            <button
              className="mt-4 px-4 py-2 bg-slate-800 text-white rounded"
              onClick={() => setModalOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
