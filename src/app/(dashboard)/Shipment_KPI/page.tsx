"use client";

import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

const formatDateShort = (value: string) => {
  const d = new Date(value);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
};

/* ---------------- Types ---------------- */

type RangeType = "last_7" | "last_30" | "this_month" | "custom";
type ProdGraphRange = | "today" | "last_7" | "last_30" | "this_month" | "custom";


type CohortSummary = {
  processed_date: string;
  delivered_pct: number;
  undelivered_pct: number;
  total_orders: number;
};

type OrderRow = {
  order_id: string;
  processed_at: string;
  current_status: string;
  delivered_in_8_days: "YES" | "NO";
  delivered_at?: string | null;
};

type LatencyRow = {
  processed_date: string;
  total_orders: number;
  delivered_orders: number;
  day_le_3: number;
  day_4: number;
  day_5: number;
  day_6: number;
  day_7: number;
  day_8: number;
  day_9: number;
  day_10_plus: number;
};

/* ---------------- Helpers ---------------- */

const formatYMD = (d: Date) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};


const getTodayMidnight = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const DAY_COLORS = [
  "bg-blue-200",
  "bg-blue-200",
  "bg-blue-300",
  "bg-blue-400 text-white",
  "bg-blue-500 text-white",
  "bg-blue-600 text-white",
  "bg-blue-700 text-white",
  "bg-gray-500 text-white",
];




/* ---------------- Component ---------------- */

export default function SLACohortsPage() {
  /* ---- Range & Dates ---- */
  const [range, setRange] = useState<RangeType>("last_7");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  /* ---- Data ---- */
  const [summary, setSummary] = useState<CohortSummary[]>([]);
  const [tableRows, setTableRows] = useState<OrderRow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [latencyData, setLatencyData] = useState<LatencyRow[]>([]);
  const [slaSummary, setSlaSummary] = useState<{
    delivered: number;
    undelivered: number;
  } | null>(null);
  const [productionKpis, setProductionKpis] = useState<{
    in_production: {
      genesis: number;
      yara: number;
    };
    shipped: {
      genesis: number;
      yara: number;
    };
    total_sent: {
      genesis: number;
      yara: number;
    };
  } | null>(null);

  // ---- Production Graph (ONLY) ----
  const [prodRange, setProdRange] =
    useState<ProdGraphRange>("last_7");

  const [prodStartDate, setProdStartDate] = useState("");
  const [prodEndDate, setProdEndDate] = useState("");

  const [productionGraphKpis, setProductionGraphKpis] =
    useState<{
      in_production: {
        genesis: number;
        yara: number;
      };
      shipped: {
        genesis: number;
        yara: number;
      };
    } | null>(null);


  /* ---------------- AUTO DATE CALCULATION (ONLY CHANGE) ---------------- */

  useEffect(() => {
    const today = getTodayMidnight();
    let start: Date;
    let end: Date;

    switch (range) {
      case "last_7":
        end = new Date(today);
        end.setDate(end.getDate() - 8);
        start = new Date(today);
        start.setDate(start.getDate() - 14);
        break;

      case "last_30":
        end = new Date(today);
        end.setDate(end.getDate() - 8);
        start = new Date(today);
        start.setDate(start.getDate() - 38);
        break;

      case "this_month":
        end = new Date(today);
        end.setDate(end.getDate() - 8); // SLA-safe end date
        start = new Date(today.getFullYear(), today.getMonth(), 1); // 1st of current month
        break;

      case "custom":
        return;
    }

    setStartDate(formatYMD(start));
    setEndDate(formatYMD(end));
  }, [range]);

  useEffect(() => {
    const today = getTodayMidnight();
    let start: Date;
    let end: Date = new Date(today);

    switch (prodRange) {
      case "today":
        start = new Date(today);
        break;

      case "last_7":
        start = new Date(today);
        start.setDate(start.getDate() - 6);
        break;

      case "last_30":
        start = new Date(today);
        start.setDate(start.getDate() - 29);
        break;

      case "this_month":
        start = new Date(today.getFullYear(), today.getMonth(), 1);
        break;

      case "custom":
        return;
    }

    setProdStartDate(formatYMD(start));
    setProdEndDate(formatYMD(end));
  }, [prodRange]);


  /* ---------------- API calls ---------------- */

  const fetchSummary = async () => {
    if (!startDate || !endDate) return;

    setLoading(true);
    setSelectedDate(null);
    setTableRows([]);

    const res = await fetch(
      `${API_BASE}/stats/sla-cohorts?start_date=${startDate}&end_date=${endDate}`
    );
    const data = await res.json();
    setSummary(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  const fetchLatencyCohorts = async () => {
    const res = await fetch(
      `${API_BASE}/stats/delivery-latency-cohorts?start_date=${startDate}&end_date=${endDate}`
    );
    const data = await res.json();
    setLatencyData(Array.isArray(data) ? data : []);
  };

  const fetchTable = async (date: string) => {
    setSelectedDate(date);

    const res = await fetch(
      `${API_BASE}/stats/sla-cohorts?start_date=${startDate}&end_date=${endDate}&cohort_date=${date}`
    );
    const data = await res.json();
    setTableRows(Array.isArray(data) ? data : []);
  };

  const fetchSlaSummary = async () => {
    if (!startDate || !endDate) return;

    const res = await fetch(
      `${API_BASE}/stats/sla-summary?start_date=${startDate}&end_date=${endDate}`
    );
    const data = await res.json();

    setSlaSummary({
      delivered: data.delivered_within_8_days,
      undelivered: data.not_delivered_within_8_days,
    });
  };

  const fetchProductionKpis = async () => {
    const res = await fetch(`${API_BASE}/stats/production-kpis`);
    const data = await res.json();
    setProductionKpis(data);
  };

  const fetchProductionGraphKpis = async () => {
    if (!prodStartDate || !prodEndDate) return;

    const res = await fetch(
      `${API_BASE}/stats/production-kpis-graph?start_date=${prodStartDate}&end_date=${prodEndDate}`
    );

    const data = await res.json();
    setProductionGraphKpis(data);
  };


  const productionChartData = productionGraphKpis
    ? [
      {
        name: "In Production – Genesis",
        count: productionGraphKpis.in_production.genesis,
        fill: "#2563EB", // blue
      },
      {
        name: "In Production – Yara",
        count: productionGraphKpis.in_production.yara,
        fill: "#DC2626", // red
      },
      {
        name: "Shipped – Genesis",
        count: productionGraphKpis.shipped.genesis,
        fill: "#F59E0B", // orange
      },
      {
        name: "Shipped – Yara",
        count: productionGraphKpis.shipped.yara,
        fill: "#059669", // green
      },
    ]
    : [];



  useEffect(() => {
    fetchSummary();
    fetchLatencyCohorts();
    fetchSlaSummary();
    fetchProductionKpis();
  }, [startDate, endDate]);

  useEffect(() => {
    fetchProductionGraphKpis();
  }, [prodStartDate, prodEndDate]);


  const notDeliveredForSelectedDate = tableRows.filter(
    (r) => r.delivered_in_8_days === "NO"
  ).length;


  /* ---------------- UI ---------------- */

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800 mb-4">Production & Shipment Fulfillment Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          Track order flow, production status, and delivery timelines
        </p>
      </div>

      {/* -------- Filters -------- */}
      <div className="flex gap-3 items-center">
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as RangeType)}
          className="border px-3 py-2 rounded text-sm"
        >
          <option value="last_7">Last 7 days</option>
          <option value="last_30">Last 30 days</option>
          <option value="this_month">This month</option>
          <option value="custom">Custom</option>
        </select>

        {range === "custom" && (
          <>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="border px-3 py-2 rounded text-sm"
            />
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="border px-3 py-2 rounded text-sm"
            />
          </>
        )}

        <button
          onClick={fetchSummary}
          className="bg-blue-600 text-white px-4 py-2 rounded text-sm"
        >
          Apply
        </button>
      </div>

      <div className="border rounded-xl p-6 space-y-6 bg-violet-50">
        <h2 className="text-2xl font-semibold text-gray-800">
          Production Fulfillment
        </h2>
        {productionKpis && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">

            {/* ================= NEW IN PRODUCTION ================= */}
            <div className="relative rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white p-5 shadow-sm hover:shadow-md transition">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-blue-600" />

              <div className="text-xs uppercase tracking-wide text-blue-700 font-semibold">
                New in Production
              </div>

              <div className="mt-2 text-4xl font-bold text-gray-900">
                {productionKpis.in_production.genesis +
                  productionKpis.in_production.yara}
              </div>

              <div className="mt-1 text-sm text-gray-500">
                Orders not yet shipped
              </div>
            </div>

            {/* ================= IN PRODUCTION – GENESIS ================= */}
            <div className="relative rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm hover:shadow-md transition">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-amber-500" />

              <div className="text-xs uppercase tracking-wide text-amber-700 font-semibold">
                In Production – Genesis
              </div>

              <div className="mt-2 text-3xl font-bold text-gray-900">
                {productionKpis.in_production.genesis}
              </div>

              <div className="mt-1 text-sm text-gray-500">
                Awaiting shipment
              </div>
            </div>

            {/* ================= IN PRODUCTION – YARA ================= */}
            <div className="relative rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm hover:shadow-md transition">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-amber-500" />

              <div className="text-xs uppercase tracking-wide text-amber-700 font-semibold">
                In Production – Yara
              </div>

              <div className="mt-2 text-3xl font-bold text-gray-900">
                {productionKpis.in_production.yara}
              </div>

              <div className="mt-1 text-sm text-gray-500">
                Awaiting shipment
              </div>
            </div>

            {/* ================= TOTAL ORDERS – GENESIS ================= */}
            <div className="relative rounded-xl border border-purple-200 bg-gradient-to-br from-purple-50 to-white p-5 shadow-sm hover:shadow-md transition">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-purple-600" />

              <div className="text-xs uppercase tracking-wide text-purple-700 font-semibold">
                Total Orders – Genesis
              </div>

              <div className="mt-2 text-3xl font-bold text-gray-900">
                {productionKpis.total_sent.genesis}
              </div>

              <div className="mt-1 text-sm text-gray-500">
                Lifetime volume
              </div>
            </div>

            {/* ================= TOTAL ORDERS – YARA ================= */}
            <div className="relative rounded-xl border border-purple-200 bg-gradient-to-br from-purple-50 to-white p-5 shadow-sm hover:shadow-md transition">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-purple-600" />

              <div className="text-xs uppercase tracking-wide text-purple-700 font-semibold">
                Total Orders – Yara
              </div>

              <div className="mt-2 text-3xl font-bold text-gray-900">
                {productionKpis.total_sent.yara}
              </div>

              <div className="mt-1 text-sm text-gray-500">
                Lifetime volume
              </div>
            </div>

          </div>
        )}


        {productionKpis && (
          <div className="grid grid-cols-12 gap-4">
            <div className="relative col-span-12 lg:col-span-6 rounded-xl border border-amber-100 bg-gradient-to-br from-amber-50/40 to-white/70 p-5 shadow-sm hover:shadow-md transition">
              {/* ===== Header ===== */}
              <div className="flex items-center justify-between mb-6">
                {/* Left spacer for perfect centering */}
                <div className="w-32" />

                {/* Centered heading */}
                <h2 className="flex-1 text-center font-medium">
                  Orders Summary
                </h2>

                {/* Filters */}
                <div className="flex gap-2 items-center w-32 justify-end">
                  <select
                    value={prodRange}
                    onChange={(e) =>
                      setProdRange(e.target.value as ProdGraphRange)
                    }
                    className="border px-2 py-1 rounded text-sm"
                  >
                    <option value="today">Today</option>
                    <option value="last_7">Last 7 Days</option>
                    <option value="last_30">Last 30 Days</option>
                    <option value="this_month">This Month</option>
                    <option value="custom">Custom</option>
                  </select>

                  {prodRange === "custom" && (
                    <>
                      <input
                        type="date"
                        value={prodStartDate}
                        onChange={(e) =>
                          setProdStartDate(e.target.value)
                        }
                        className="border px-2 py-1 rounded text-sm"
                      />
                      <input
                        type="date"
                        value={prodEndDate}
                        onChange={(e) =>
                          setProdEndDate(e.target.value)
                        }
                        className="border px-2 py-1 rounded text-sm"
                      />
                    </>
                  )}
                </div>
              </div>

              {/* ===== Chart with spacing ===== */}
              <div className="mt-4">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={productionChartData}>
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip />

                    <Bar dataKey="count">
                      {productionChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

            </div>
          </div>
        )}
      </div>

      <div className="border rounded-xl p-6 space-y-6 bg-violet-50">
        <h2 className="text-2xl font-semibold text-gray-800">
          Shipment Fulfillment
        </h2>
        {/* -------- Layout -------- */}
        <div className="grid grid-cols-12 gap-4">
          {/* ---- Table ---- */}
          <div className="col-span-12 lg:col-span-4 bg-white p-4 border rounded">
            <h2
              className={`text-sm font-semibold ${selectedDate ? "-mb-3" : "mb-8"
                }`}
            >
              {selectedDate
                ? new Date(selectedDate)
                  .toLocaleDateString("en-GB")
                  .replace(/\//g, "-")
                : "Click a bar to view orders"}
            </h2>

            {selectedDate && (
              <div className="mb-3 text-center">
                <div className="text-3xl font-semibold text-red-600">
                  {notDeliveredForSelectedDate}
                </div>
                <div className="text-sm text-gray-600">
                  Orders not delivered within 8 days
                </div>
              </div>
            )}

            {!selectedDate ? (
              slaSummary && (
                <div className="flex flex-col items-center gap-6">
                  {/* Delivered */}
                  <div className="w-full max-w-xs flex flex-col items-center justify-center p-5 rounded-lg bg-green-50 border border-green-200">
                    <div className="text-4xl font-bold text-green-600">
                      {slaSummary.delivered}
                    </div>
                    <div className="text-sm text-gray-600 mt-1 text-center">
                      Orders delivered within 8 days
                    </div>
                  </div>

                  {/* Undelivered */}
                  <div className="w-full max-w-xs flex flex-col items-center justify-center p-5 rounded-lg bg-red-50 border border-red-200">
                    <div className="text-4xl font-bold text-red-600">
                      {slaSummary.undelivered}
                    </div>
                    <div className="text-sm text-gray-600 mt-1 text-center">
                      Orders not delivered within 8 days
                    </div>
                  </div>
                </div>
              )
            ) : (

              <div className="max-h-[300px] overflow-y-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b">
                      <th className="text-left py-1">Order ID</th>
                      <th className="text-left py-1">Processed At</th>
                      <th className="text-left py-1">Status</th>
                      <th className="text-left py-1">Delivered Date</th>
                      <th className="text-left py-1">Within 8 Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...tableRows]
                      .sort(
                        (a, b) =>
                          new Date(b.processed_at).getTime() -
                          new Date(a.processed_at).getTime()
                      )
                      .map((r) => (
                        <tr key={r.order_id} className="border-b">
                          <td className="py-2">{r.order_id}</td>
                          <td className="py-2">
                            {new Date(r.processed_at).toLocaleDateString("en-GB")}
                          </td>
                          <td className="py-2">{r.current_status}</td>
                          <td className="py-2">
                            {r.delivered_at
                              ? new Date(r.delivered_at).toLocaleDateString("en-GB")
                              : "—"}
                          </td>
                          <td className="py-2">
                            {r.delivered_in_8_days === "YES" ? "✅" : "❌"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---- Chart ---- */}
          <div className="col-span-12 lg:col-span-8 bg-white p-4 border rounded">
            <h2 className="flex-1 font-medium mb-6">
              Delivered vs Undelivered (%)
            </h2>

            {loading ? (
              <div>Loading...</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={summary}>
                  <XAxis
                    dataKey="processed_date"
                    tickFormatter={formatDateShort}
                    tick={{ fontSize: 12 }}
                  />

                  <YAxis domain={[0, 100]} />
                  <Tooltip />
                  <Legend />

                  <Bar
                    dataKey="undelivered_pct"
                    name="Undelivered %"
                    fill="#0E7490"
                    onClick={(d) =>
                      fetchTable((d as any).payload.processed_date)
                    }
                  />
                  <Bar
                    dataKey="delivered_pct"
                    name="Delivered %"
                    fill="#16a34a"
                    onClick={(d) =>
                      fetchTable((d as any).payload.processed_date)
                    }
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
        <div className="inline-block bg-white p-4 border rounded overflow-x-auto">
          <h2 className="font-medium mb-3">
            Delivery Time Cohort (% of Orders)
          </h2>

          <table className="border-collapse text-sm">
            <thead>
              <tr>
                <th className="border px-3 py-2 text-left">Processed Date</th>
                <th className="border px-3 py-2 text-right">Total Orders</th>
                <th className="border px-3 py-2 text-right">Delivered Orders</th>
                <th className="border px-3 py-2 text-right">Day ≤3</th>
                <th className="border px-3 py-2 text-right">Day 4</th>
                <th className="border px-3 py-2 text-right">Day 5</th>
                <th className="border px-3 py-2 text-right">Day 6</th>
                <th className="border px-3 py-2 text-right">Day 7</th>
                <th className="border px-3 py-2 text-right">Day 8</th>
                <th className="border px-3 py-2 text-right">Day 9</th>
                <th className="border px-3 py-2 text-right">Day ≥10</th>
              </tr>
            </thead>

            <tbody>
              {latencyData.map((row) => (
                <tr
                  key={row.processed_date}
                  className={row.processed_date === "TOTAL"
                    ? "font-semibold bg-gray-100 border-t-2 border-gray-400"
                    : ""}
                >

                  <td className="border px-3 py-2 text-left font-semibold">
                    {row.processed_date === "TOTAL"
                      ? "TOTAL"
                      : formatDateShort(row.processed_date)}
                  </td>


                  <td className="border px-3 py-2 text-right font-medium">
                    {row.total_orders}
                  </td>

                  <td className="border px-3 py-2 text-right">
                    {row.delivered_orders}
                  </td>

                  {[
                    row.day_le_3,
                    row.day_4,
                    row.day_5,
                    row.day_6,
                    row.day_7,
                    row.day_8,
                    row.day_9,
                    row.day_10_plus,
                  ].map((pct, i) => (
                    <td
                      key={i}
                      className={`border px-3 py-2 text-right ${row.processed_date === "TOTAL"
                        ? "bg-gray-200 font-semibold"
                        : pct > 0
                          ? DAY_COLORS[i]
                          : "bg-gray-100 text-gray-400"
                        }`}
                    >

                      {pct > 0 ? `${pct}%` : "—"}
                    </td>
                  ))}

                </tr>
              ))}
            </tbody>

          </table>
        </div>
      </div>
    </div>
  );
}
