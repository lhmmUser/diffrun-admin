"use client";

import { useEffect, useMemo, useState } from "react";

type RangeKey = "1d" | "1w" | "1m" | "6m" | "this_month" | "custom";
type CountryCode = "IN" | "AE" | "CA" | "US" | "GB" | "IN_ONLY";

type ShipRow = {
  date: string;
  total: number;
  unapproved: number;
  sent_to_print: number;
  new_count: number;
  out_for_pickup: number;
  pickup_exception: number;
  in_transit: number;
  delivered: number;
  issue: number;
};

export default function ShipmentStatusPage() {
  const baseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

  const todayISO = new Date().toISOString().slice(0, 10);
  const weekAgoISO = new Date(Date.now() - 6 * 86400000)
    .toISOString()
    .slice(0, 10);

  const [range, setRange] = useState<RangeKey>("1w");
  const [startDate, setStartDate] = useState<string>(weekAgoISO);
  const [endDate, setEndDate] = useState<string>(todayISO);
  const [customApplied, setCustomApplied] = useState(false);

  // only India
  const [country] = useState<CountryCode>("IN_ONLY");

  const [shipRows, setShipRows] = useState<ShipRow[]>([]);
  const [shipError, setShipError] = useState<string>("");
  const [shipLoading, setShipLoading] = useState<boolean>(false);

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
    let rows: any[] = Array.isArray(json?.rows) ? json.rows : [];

    return rows
      .map((r) => {
        const dateStr = (r.date ?? r.label ?? "").toString();
        return {
          date: dateStr,
          total: Number.isFinite(r.total) ? Number(r.total) : 0,
          unapproved: Number.isFinite(r.unapproved) ? Number(r.unapproved) : 0,
          sent_to_print: Number.isFinite(r.sent_to_print)
            ? Number(r.sent_to_print)
            : 0,
          new_count: Number.isFinite(r.new ?? r.new_count)
            ? Number(r.new ?? r.new_count)
            : 0,
          out_for_pickup: Number.isFinite(r.out_for_pickup)
            ? Number(r.out_for_pickup)
            : 0,
          pickup_exception: Number.isFinite(r.pickup_exception)
            ? Number(r.pickup_exception)
            : 0,
          in_transit: Number.isFinite(r.in_transit) ? Number(r.in_transit) : 0,
          delivered: Number.isFinite(r.delivered) ? Number(r.delivered) : 0,
          issue: Number.isFinite(r.issue) ? Number(r.issue) : 0,
        } as ShipRow;
      })
      .sort((a, b) => {
        const da =
          a.date.length === 10
            ? new Date(a.date + "T00:00:00Z")
            : new Date(a.date);
        const db =
          b.date.length === 10
            ? new Date(b.date + "T00:00:00Z")
            : new Date(b.date);
        return db.getTime() - da.getTime(); // newest first
      });
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
        const rows = parseRows(json);
        setShipRows(rows);
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
      .then((json) => {
        const rows = parseRows(json);
        setShipRows(rows);
      })
      .catch((err) => setShipError(String(err)))
      .finally(() => setShipLoading(false));
  };

  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800 mb-4">
        Shipment Status
      </h1>

      {/* Range + Custom Controls */}
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

      {range === "custom" && isCustomInvalid && (
        <p className="mb-2 text-red-600 text-sm">
          Start date must be before or equal to End date.
        </p>
      )}

      {/* Shipment table */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
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

        {shipLoading && (
          <div className="text-sm text-slate-500">
            Loading shipment data…
          </div>
        )}
        {shipError && (
          <div className="text-sm text-red-600">Error: {shipError}</div>
        )}

        {!shipLoading && shipRows.length === 0 && !shipError && (
          <div className="text-sm text-slate-500">
            No data for selected range.
          </div>
        )}

        {!shipLoading && shipRows.length > 0 && (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-600 border-b">
                  <th className="p-2">Date</th>
                  <th className="p-2">Unapproved</th>
                  <th className="p-2">Sent to Print</th>
                  <th className="p-2">New</th>
                  <th className="p-2">Out for pickup</th>
                  <th className="p-2">Pickup Exception</th>
                  <th className="p-2">In Transit</th>
                  <th className="p-2">Delivered</th>
                  <th className="p-2">Issue</th>
                  <th className="p-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {shipRows.map((r) => (
                  <tr key={r.date} className="border-t hover:bg-slate-50">
                    <td className="p-2">{r.date}</td>
                    <td className="p-2">{r.unapproved}</td>
                    <td className="p-2">{r.sent_to_print}</td>
                    <td className="p-2">{r.new_count}</td>
                    <td className="p-2">{r.out_for_pickup}</td>
                    <td className="p-2">{r.pickup_exception}</td>
                    <td className="p-2">{r.in_transit}</td>
                    <td className="p-2">{r.delivered}</td>
                    <td className="p-2">{r.issue}</td>
                    <td className="p-2 font-medium">{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
