"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

// ---------- Types ----------
type StatsResponse = {
  labels: string[];
  current: number[];
  previous: number[];
  exclusions: string[];
  granularity?: "hour" | "day";
};

type JobsStatsResponse = {
  labels: string[];
  current_jobs: number[];
  previous_jobs: number[];
  current_orders: number[];
  previous_orders: number[];
  conversion_current: number[];
  conversion_previous: number[];
  granularity: "hour" | "day";
};

// NEW: Revenue stats mirror Orders (current vs previous)
type RevenueStatsResponse = {
  labels: string[];
  current: number[];
  previous: number[];
  granularity: "hour" | "day";
};

type RangeKey = "1d" | "1w" | "1m" | "6m" | "this_month" | "custom";

// CHANGED: add 'revenue'
type Metric = "orders" | "jobs" | "conversion" | "revenue";

// NEW: Country codes and options (you asked for IN default, AE, CA, US, GB)
type CountryCode = "IN" | "AE" | "CA" | "US" | "GB";
const COUNTRY_OPTIONS: { label: string; value: CountryCode }[] = [
  { label: "India", value: "IN" },
  { label: "United Arab Emirates", value: "AE" },
  { label: "Canada", value: "CA" },
  { label: "United States", value: "US" },
  { label: "United Kingdom", value: "GB" },
];

export default function Home() {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string>("");

  const [jobsStats, setJobsStats] = useState<JobsStatsResponse | null>(null);
  const [jobsError, setJobsError] = useState<string>("");

  // NEW: revenue state
  const [revenueStats, setRevenueStats] = useState<RevenueStatsResponse | null>(null);
  const [revenueError, setRevenueError] = useState<string>("");

  const [range, setRange] = useState<RangeKey>("1w");
  const [metric, setMetric] = useState<Metric>("orders");

  // NEW: country state (India default)
  const [country, setCountry] = useState<CountryCode>("IN");

  const todayISO = new Date().toISOString().slice(0, 10);
  const weekAgoISO = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState<string>(weekAgoISO);
  const [endDate, setEndDate] = useState<string>(todayISO);

  // NEW: require explicit Apply for custom
  const [customApplied, setCustomApplied] = useState(false);

  const addDays = (ymd: string, days: number) => {
    const d = new Date(ymd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const exclusions = ["TEST", "LHMM", "COLLAB", "REJECTED"];

  // NEW: helper to build URLs and always include `loc`
  const withParams = (path: string, params: Record<string, string | number | undefined>) => {
    const url = new URL(path, baseUrl);
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    });
    qs.set("loc", country); // critical: pass selected country
    url.search = qs.toString();
    return url.toString();
  };

  const buildOrdersUrl = (r: RangeKey) => {
    const params: Record<string, string> = {};
    exclusions.forEach((c, i) => (params[`exclude_codes`] = c)); // not used here; you append below
    const usp = new URLSearchParams();
    exclusions.forEach((c) => usp.append("exclude_codes", c));
    if (r === "custom") {
      usp.append("start_date", startDate);
      usp.append("end_date", endDate);
    } else {
      usp.append("range", r);
    }
    // CHANGED: wrap with withParams to inject loc
    return withParams("/stats/orders", Object.fromEntries(usp.entries()));
  };

  const buildJobsUrl = (r: RangeKey) => {
    const usp = new URLSearchParams();
    if (r === "custom") {
      usp.append("start_date", startDate);
      usp.append("end_date", endDate);
    } else {
      usp.append("range", r);
    }
    // CHANGED: wrap with withParams to inject loc
    return withParams("/stats/preview-vs-orders", Object.fromEntries(usp.entries()));
  };

  // NEW: revenue URL builder (mirrors others)
  const buildRevenueUrl = (r: RangeKey) => {
    const usp = new URLSearchParams();
    if (r === "custom") {
      usp.append("start_date", startDate);
      usp.append("end_date", endDate);
    } else {
      usp.append("range", r);
    }
    return withParams("/stats/revenue", Object.fromEntries(usp.entries()));
  };

  const isCustomInvalid =
    range === "custom" && (!!startDate && !!endDate) && startDate > endDate;

  // NEW: helper—only fetch when ready
  const canFetch = useMemo(() => {
    if (range !== "custom") return true;
    if (isCustomInvalid) return false;
    return customApplied; // only after Apply
  }, [range, isCustomInvalid, customApplied]);

  // Fetch: Orders
  useEffect(() => {
    if (!canFetch) return;
    setError("");
    setStats(null);
    fetch(buildOrdersUrl(range), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setStats)
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, range, startDate, endDate, canFetch, country]); // CHANGED: include `country`

  // Fetch: Jobs & Conversion
  useEffect(() => {
    if (!canFetch) return;
    setJobsError("");
    setJobsStats(null);
    fetch(buildJobsUrl(range), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) => {
        if (!("current_jobs" in data)) {
          const jobs = data.unpaid_with_preview ?? [];
          const orders = data.paid_with_preview ?? [];
          const zeros = (n: number) => Array(n).fill(0);
          data = {
            labels: data.labels ?? [],
            current_jobs: jobs,
            previous_jobs: zeros(jobs.length),
            current_orders: orders,
            previous_orders: zeros(orders.length),
            conversion_current: orders.map((o: number, i: number) =>
              (jobs[i] ?? 0) > 0 ? +(o * 100 / jobs[i]).toFixed(2) : 0
            ),
            conversion_previous: zeros(orders.length),
            granularity: data.granularity ?? "day",
          };
        }
        setJobsStats(data);
      })
      .catch((e) => setJobsError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, range, startDate, endDate, canFetch, country]); // CHANGED: include `country`

  // NEW: Fetch Revenue (only when needed, to avoid extra traffic)
  useEffect(() => {
  if (!canFetch) return;
  setRevenueError("");
  setRevenueStats(null);
  fetch(buildRevenueUrl(range), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
    .then((data) => setRevenueStats(data))
    .catch((e) => setRevenueError(String(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [baseUrl, range, startDate, endDate, canFetch, country]); // ← no 'metric' and no guard

  // Helpers
  const parseYMD = (input: unknown) => {
    const s = String(input ?? "");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3]);
    return new Date(Date.UTC(y, mo, d));
  };

  const toDate = (raw: string): Date | null => {
    if (!raw) return null;
    if (raw.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return parseYMD(raw);
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  };

  const prettyIST = (ymd: string) => {
    const base = parseYMD(ymd);
    if (!base) return ymd || "";
    const ist = new Date(base.getTime() + 19800000);
    if (range === "1m" || range === "6m" || range === "custom" || range === "this_month")
      return ist.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    return ist.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
  };

  const fmtDay = (d: Date) =>
    d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });

  const subMonthsKeepDOM = (d: Date, n: number) => {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const targetIndex = m - n;
    const ty = y + Math.floor(targetIndex / 12);
    const tm = ((targetIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    const dom = Math.min(d.getUTCDate(), lastDay);
    return new Date(Date.UTC(ty, tm, dom, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  };

  // shift for ranges; custom uses window length in days
  const prevShiftDays = (r: RangeKey): number | null => {
    if (r === "1d") return 7;
    if (r === "1w") return 7;
    if (r === "1m") return 30;
    if (r === "6m") return 182;
    if (r === "this_month") return null;
    if (r === "custom") return Math.max(1,
      Math.ceil((new Date(endDate + "T00:00:00Z").getTime() - new Date(startDate + "T00:00:00Z").getTime()) / 86400000)
    );
    return 7;
  };

  // Labels
  const isHourlyOrders = stats?.granularity === "hour";
  const ordersRawLabels = stats?.labels ?? [];
  const ordersLabels = useMemo(() => {
    if (!stats) return [];
    return isHourlyOrders ? ordersRawLabels.map((s) => s.slice(11)) : ordersRawLabels.map(prettyIST);
  }, [stats, range]);

  const isHourlyJobs = jobsStats?.granularity === "hour";
  const jobsRawLabels = jobsStats?.labels ?? [];
  const jobsLabels = useMemo(() => {
    if (!jobsStats) return [];
    return isHourlyJobs ? jobsRawLabels.map((s) => s.slice(11)) : jobsRawLabels.map(prettyIST);
  }, [jobsStats, range]);

  // NEW: revenue labels
  const isHourlyRevenue = revenueStats?.granularity === "hour";
  const revenueRawLabels = revenueStats?.labels ?? [];
  const revenueLabels = useMemo(() => {
    if (!revenueStats) return [];
    return isHourlyRevenue ? revenueRawLabels.map((s) => s.slice(11)) : revenueRawLabels.map(prettyIST);
  }, [revenueStats, range]);

  // CHANGED: choose active labels by metric, including revenue
  const activeLabels = useMemo(() => {
    if (metric === "orders") return ordersLabels;
    if (metric === "jobs" || metric === "conversion") return jobsLabels;
    return revenueLabels; // revenue
  }, [metric, ordersLabels, jobsLabels, revenueLabels]);

  type Series = { name: string; data: number[] }[];

  // CHANGED: include revenue series
  const activeSeries: Series = useMemo(() => {
    if (metric === "orders") {
      if (!stats) return [];
      return [
        { name: "Current Orders", data: stats.current ?? [] },
        { name: "Previous Orders", data: stats.previous ?? [] },
      ];
    }
    if (metric === "jobs") {
      if (!jobsStats) return [];
      return [
        { name: "Current Jobs", data: jobsStats.current_jobs ?? [] },
        { name: "Previous Jobs", data: jobsStats.previous_jobs ?? [] },
      ];
    }
    if (metric === "conversion") {
      if (!jobsStats) return [];
      return [
        { name: "Current Conversion %", data: jobsStats.conversion_current ?? [] },
        { name: "Previous Conversion %", data: jobsStats.conversion_previous ?? [] },
      ];
    }
    // revenue
    if (!revenueStats) return [];
    return [
      { name: "Current Revenue", data: revenueStats.current ?? [] },
      { name: "Previous Revenue", data: revenueStats.previous ?? [] },
    ];
  }, [metric, stats, jobsStats, revenueStats]);

  // CHANGED: totals include revenue
  const totals = useMemo(() => {
    const sum = (arr?: number[]) => (arr ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const ordersCurrent = sum(stats?.current);
    const ordersPrev = sum(stats?.previous);
    const jobsCurrent = sum(jobsStats?.current_jobs);
    const jobsPrev = sum(jobsStats?.previous_jobs);
    const convCurrent = jobsCurrent > 0 ? +(ordersCurrent * 100 / jobsCurrent).toFixed(2) : 0;
    const convPrev = jobsPrev > 0 ? +(ordersPrev * 100 / jobsPrev).toFixed(2) : 0;
    const revenueCurrent = sum(revenueStats?.current);
    const revenuePrev = sum(revenueStats?.previous);
    return {
      orders: { current: ordersCurrent, prev: ordersPrev },
      jobs: { current: jobsCurrent, prev: jobsPrev },
      conversion: { current: convCurrent, prev: convPrev },
      revenue: { current: revenueCurrent, prev: revenuePrev },
    };
  }, [stats, jobsStats, revenueStats]);

  const isPercent = metric === "conversion";
  const showDataLabels = true;

  const chartOptions = useMemo(() => {
    const colors = activeSeries.length === 2 ? ["#2563eb", "#16a34a"] : ["#2563eb"];
    const hourGran =
      metric === "orders"
        ? stats?.granularity === "hour"
        : metric === "jobs" || metric === "conversion"
        ? jobsStats?.granularity === "hour"
        : revenueStats?.granularity === "hour";

    const rawLabels =
      metric === "orders"
        ? ordersRawLabels
        : metric === "jobs" || metric === "conversion"
        ? jobsRawLabels
        : revenueRawLabels;

    const shift = prevShiftDays(range);

    const customTooltip = (opts: any): string => {
      const i: number = opts.dataPointIndex;
      const r = rawLabels[i] as string | undefined;
      const currDate = r ? toDate(r) : null;

      let prevDate: Date | null = null;
      if (currDate) {
        if (range === "this_month") {
          prevDate = subMonthsKeepDOM(currDate, 1);
        } else if (typeof shift === "number") {
          prevDate = new Date(currDate.getTime());
          prevDate.setDate(prevDate.getDate() - shift);
        }
      }

      const title =
        currDate
          ? `${fmtDay(currDate)}${prevDate ? ` • prev ${fmtDay(prevDate)}` : ""}`
          : (activeLabels[i] ?? "");

      const s0 = opts.series[0]?.[i];
      const s1 = opts.series[1]?.[i];

      const dot = (c: string) =>
        `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:6px;"></span>`;

      const fmtVal = (v: any) => {
        const n = Number.isFinite(v) ? Number(v) : 0;
        if (isPercent) return `${Math.round(n)}%`;
        if (metric === "revenue") return `${n.toFixed(2)}`; // keep decimals for money-like values
        return `${Math.round(n)}`;
      };

      return `
        <div class="apexcharts-tooltip-custom" style="padding:10px 12px;">
          <div style="font-weight:600;margin-bottom:6px;">${title}</div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${typeof s0 !== "undefined" ? `<div style="display:flex;align-items:center;">${dot(colors[0])}<span style="margin-right:6px;">${activeSeries[0]?.name ?? "Current"}</span><strong>${fmtVal(s0)}</strong></div>` : ""}
            ${typeof s1 !== "undefined" ? `<div style="display:flex;align-items:center;">${dot(colors[1])}<span style="margin-right:6px;">${activeSeries[1]?.name ?? "Previous"}</span><strong>${fmtVal(s1)}</strong></div>` : ""}
          </div>
        </div>
      `;
    };

    return {
      chart: { id: "unified-metric", type: "line", toolbar: { show: false }, animations: { enabled: true, easing: "easeinout", speed: 250 } },
      colors,
      xaxis: {
        categories: activeLabels,
        labels: { rotate: (range === "1m" || range === "6m" || range === "custom" || range === "this_month") ? -30 : 0 },
        axisBorder: { color: "#e2e8f0" },
        axisTicks: { color: "#e2e8f0" },
      },
      yaxis: {
        title: {
          text:
            metric === "orders"
              ? "Orders"
              : metric === "jobs"
              ? "Jobs"
              : metric === "conversion"
              ? "Conversion %"
              : "Revenue",
        },
        labels: {
          formatter: (v: number) => {
            if (isPercent) return `${Math.round(v)}%`;
            if (metric === "revenue") return `${v.toFixed(0)}`; // compact; adjust if you need ₹/$ formatting
            return `${Math.round(v)}`;
          },
        },
        min: 0,
        forceNiceScale: true,
      },
      grid: { borderColor: "#e2e8f0", strokeDashArray: 3 },
      stroke: { width: activeSeries.length === 2 ? [3, 3] : 3, curve: "smooth", dashArray: [0, 6] },
      legend: { position: "top", horizontalAlign: "center" },
      markers: { size: hourGran ? 0 : 3, hover: { size: 4 } },
      dataLabels: {
        enabled: showDataLabels,
        offsetY: -6,
        formatter: (val: number) => {
          if (isPercent) return `${Math.round(val)}%`;
          if (metric === "revenue") return `${val.toFixed(0)}`;
          return `${Math.round(val)}`;
        },
        style: { fontWeight: 700 },
        background: { enabled: true, foreColor: "#fff", borderRadius: 8, borderWidth: 0, opacity: 0.95 },
      },
      tooltip: { shared: true, intersect: false, custom: customTooltip },
    } as const;
  }, [
    metric,
    stats?.granularity,
    jobsStats?.granularity,
    revenueStats?.granularity,
    activeLabels,
    activeSeries,
    ordersRawLabels,
    jobsRawLabels,
    revenueRawLabels,
    range,
    isPercent,
    showDataLabels,
  ]);

  // ---------- UI ----------
  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800 mb-4">Welcome to Diffrun Admin Dashboard</h1>

      <div className="flex flex-col md:flex-row items-start md:items-end gap-3 mb-4">
        {/* Range dropdown */}
        <div className="ml-0 md:ml-2">
          <label className="block text-sm text-slate-600 mb-1">Range</label>
          <select
            value={range}
            onChange={(e) => {
              const val = e.target.value as RangeKey;
              setRange(val);
              if (val === "custom") setCustomApplied(false);
              else setCustomApplied(true);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <option value="1d">1 day</option>
            <option value="1w">Last 7 days</option>
            <option value="1m">Last 30 days</option>
            <option value="this_month">This month</option>
            <option value="6m">6 months (~182d)</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        {/* Calendar controls for custom */}
        {range === "custom" && (
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-sm text-slate-600 mb-1">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setCustomApplied(false); }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">End date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setCustomApplied(false); }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={() => setCustomApplied(true)}
              disabled={isCustomInvalid}
              className={`h-10 px-4 rounded-lg text-white ${isCustomInvalid ? "bg-slate-400 cursor-not-allowed" : "bg-slate-800 hover:bg-slate-700"}`}
              title={isCustomInvalid ? "Start date must be before or equal to End date" : "Apply range"}
            >
              Apply
            </button>
          </div>
        )}

        {/* NEW: Country dropdown */}
        <div className="ml-0 md:ml-2">
          <label className="block text-sm text-slate-600 mb-1">Country</label>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value as CountryCode)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            aria-label="Select Country"
          >
            {COUNTRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {range === "custom" && isCustomInvalid && (
        <p className="mb-2 text-red-600 text-sm">Start date must be before or equal to End date.</p>
      )}

      {/* CHANGED: four metric tiles (Orders, Jobs, Conversion, Revenue) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-2">
        <button onClick={() => setMetric("orders")} className={`rounded-lg overflow-hidden shadow-sm border ${metric === "orders" ? "border-blue-500" : "border-slate-200"}`}>
          <div className="bg-blue-600 text-white px-4 py-3">
            <div className="text-sm opacity-90">Orders</div>
            <div className="text-3xl font-semibold leading-tight">{(totals.orders.current)}</div>
          </div>
          <div className="px-4 py-2 text-sm text-slate-700">Prev: {totals.orders.prev}</div>
        </button>

        <button onClick={() => setMetric("jobs")} className={`rounded-lg overflow-hidden shadow-sm border ${metric === "jobs" ? "border-red-500" : "border-slate-200"}`}>
          <div className="bg-red-600 text-white px-4 py-3">
            <div className="text-sm opacity-90">Jobs</div>
            <div className="text-3xl font-semibold leading-tight">{(totals.jobs.current)}</div>
          </div>
          <div className="px-4 py-2 text-sm text-slate-700">Prev: {totals.jobs.prev}</div>
        </button>

        <button onClick={() => setMetric("conversion")} className={`rounded-lg overflow-hidden shadow-sm border ${metric === "conversion" ? "border-amber-500" : "border-slate-200"}`}>
          <div className="bg-amber-500 text-white px-4 py-3">
            <div className="text-sm opacity-90">Conversion</div>
            <div className="text-3xl font-semibold leading-tight">
              {totals.conversion.current.toFixed(2)}%
            </div>
          </div>
          <div className="px-4 py-2 text-sm text-slate-700">Prev: {totals.conversion.prev.toFixed(2)}%</div>
        </button>

        {/* NEW: Revenue tile */}
        <button onClick={() => setMetric("revenue")} className={`rounded-lg overflow-hidden shadow-sm border ${metric === "revenue" ? "border-emerald-500" : "border-slate-200"}`}>
          <div className="bg-emerald-600 text-white px-4 py-3">
            <div className="text-sm opacity-90">Revenue</div>
            <div className="text-3xl font-semibold leading-tight">{(totals.revenue.current.toFixed(0))}</div>
          </div>
          <div className="px-4 py-2 text-sm text-slate-700">Prev: {totals.revenue.prev.toFixed(0)}</div>
        </button>
      </div>

      {(error || jobsError || revenueError) && (
        <p className="mb-3 text-red-600">
          {error ? `Orders error: ${error}` : jobsError ? `Jobs/Conversion error: ${jobsError}` : `Revenue error: ${revenueError}`}
        </p>
      )}

      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
        {(
          (metric === "orders" && !stats) ||
          ((metric === "jobs" || metric === "conversion") && !jobsStats) ||
          (metric === "revenue" && !revenueStats)
        ) ? (
          <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />
        ) : (
          <ReactApexChart
            key={`${metric}-${range}-${country}-${activeLabels.length}-${customApplied ? "applied" : "pending"}`}
            options={chartOptions as any}
            series={activeSeries as any}
            type="line"
            height={360}
          />
        )}
      </section>
    </main>
  );
}
