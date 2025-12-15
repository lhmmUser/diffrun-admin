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

  new_count: number;
  new_ids?: string[];

  out_for_pickup: number;
  out_for_pickup_ids?: string[];

  pickup_exception: number;
  pickup_exception_ids?: string[];

  in_transit: number;
  in_transit_ids?: string[];

  delivered: number;
  delivered_ids?: string[];

  issue: number;
  issue_ids?: string[];
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

  const [country] = useState<CountryCode>("IN_ONLY");

  const [shipRows, setShipRows] = useState<ShipRow[]>([]);
  const [shipError, setShipError] = useState<string>("");
  const [shipLoading, setShipLoading] = useState<boolean>(false);

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
        const dateStr = (r.date ?? "").toString();

        return {
          date: dateStr,
          total: r.total ?? 0,

          unapproved: r.unapproved ?? 0,
          unapproved_ids: r.unapproved_ids ?? [],

          sent_to_print: r.sent_to_print ?? 0,
          sent_to_print_ids: r.sent_to_print_ids ?? [],

          new_count: r.new ?? 0,
          new_ids: r.new_ids ?? [],

          out_for_pickup: r.out_for_pickup ?? 0,
          out_for_pickup_ids: r.out_for_pickup_ids ?? [],

          pickup_exception: r.pickup_exception ?? 0,
          pickup_exception_ids: r.pickup_exception_ids ?? [],

          in_transit: r.in_transit ?? 0,
          in_transit_ids: r.in_transit_ids ?? [],

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
      .then((json) => setShipRows(parseRows(json)))
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

  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800 mb-4">
        Shipment Status
      </h1>

      {/* Range Selector */}
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

      {/* Error */}
      {shipError && (
        <p className="text-red-600 mb-2 text-sm">Error: {shipError}</p>
      )}

      {!shipLoading && shipRows.length > 0 && (
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

          {/* Scrollable table with sticky header */}
          <div className="overflow-y-auto max-h-[600px] border rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white z-10 shadow-sm">
                <tr className="text-left text-slate-600 border-b">
                  <th className="p-2">Date</th>
                  <th className="p-2">Unapproved</th>
                  <th className="p-2">Sent to Print</th>
                  <th className="p-2">New</th>
                  <th className="p-2">Out for pickup</th>
                  <th className="p-2">Pickup Exception</th>
                  <th className="p-2">In Transit</th>
                  <th className="p-2">Issue</th>
                  <th className="p-2">Delivered</th>
                  <th className="p-2">Total</th>
                </tr>
              </thead>

              <tbody>
                {shipRows.map((r) => (
                  <tr key={r.date} className="border-t hover:bg-slate-50">
                    <td className="p-2">{r.date}</td>

                    {/* Unapproved */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() =>
                        openModal(r.date, "Unapproved", r.unapproved_ids || [])
                      }
                    >
                      {r.unapproved}
                    </td>

                    {/* Sent to Print */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() =>
                        openModal(r.date, "Sent to Print", r.sent_to_print_ids || [])
                      }
                    >
                      {r.sent_to_print}
                    </td>

                    {/* New */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() => openModal(r.date, "New", r.new_ids || [])}
                    >
                      {r.new_count}
                    </td>

                    {/* Out for Pickup */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() =>
                        openModal(
                          r.date,
                          "Out for Pickup",
                          r.out_for_pickup_ids || []
                        )
                      }
                    >
                      {r.out_for_pickup}
                    </td>

                    {/* Pickup Exception */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() =>
                        openModal(
                          r.date,
                          "Pickup Exception",
                          r.pickup_exception_ids || []
                        )
                      }
                    >
                      {r.pickup_exception}
                    </td>

                    {/* In Transit */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() =>
                        openModal(r.date, "In Transit", r.in_transit_ids || [])
                      }
                    >
                      {r.in_transit}
                    </td>

                    {/* Issue */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() =>
                        openModal(r.date, "Issue", r.issue_ids || [])
                      }
                    >
                      {r.issue}
                    </td>

                    {/* Delivered */}
                    <td
                      className="p-2 text-blue-600 cursor-pointer"
                      onClick={() =>
                        openModal(r.date, "Delivered", r.delivered_ids || [])
                      }
                    >
                      {r.delivered}
                    </td>

                    <td className="p-2 font-medium">{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}


      {/* Loading */}
      {shipLoading && <p className="text-sm text-slate-500">Loading…</p>}

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
