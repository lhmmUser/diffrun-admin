"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

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

type RangeKey = "1d" | "1w" | "1m" | "6m";
type Metric = "orders" | "jobs" | "conversion";

export default function Home() {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string>("");

  const [jobsStats, setJobsStats] = useState<JobsStatsResponse | null>(null);
  const [jobsError, setJobsError] = useState<string>("");

  const [range, setRange] = useState<RangeKey>("1w");
  const [metric, setMetric] = useState<Metric>("orders");

  const exclusions = ["TEST", "LHMM", "COLLAB", "REJECTED"];

  const buildOrdersUrl = (r: RangeKey) => {
    const params = new URLSearchParams();
    exclusions.forEach((c) => params.append("exclude_codes", c));
    params.append("range", r);
    return `${baseUrl}/stats/orders?${params.toString()}`;
  };

  const buildJobsUrl = (r: RangeKey) => {
    const params = new URLSearchParams();
    params.append("range", r);
    return `${baseUrl}/stats/preview-vs-orders?${params.toString()}`;
  };

  // Orders fetch
  useEffect(() => {
    setError("");
    setStats(null);
    const url = buildOrdersUrl(range);
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, [baseUrl, range]);

  // Jobs/Conversion fetch
  useEffect(() => {
    setJobsError("");
    setJobsStats(null);
    const url = buildJobsUrl(range);
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) => {
        // Normalize to new shape if backend still returns old keys
        if (!("current_jobs" in data)) {
          const jobs = data.unpaid_with_preview ?? [];
          const orders = data.paid_with_preview ?? [];

          const zeros = (n: number) => Array(n).fill(0);

          data = {
            labels: data.labels ?? [],
            current_jobs: jobs,
            previous_jobs: zeros(jobs.length),        // until backend updated
            current_orders: orders,
            previous_orders: zeros(orders.length),    // until backend updated
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
  }, [baseUrl, range]);

  // ---------- date helpers ----------
  const parseYMD = (input: unknown) => {
    const s = String(input ?? "");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    return new Date(Date.UTC(y, mo, d));
  };

  const prettyIST = (ymd: string) => {
    const base = parseYMD(ymd);
    if (!base) return ymd || "";
    const ist = new Date(base.getTime() + 19800000); // +05:30
    if (range === "1m" || range === "6m") {
      return ist.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    }
    return ist.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
  };

  // ===== NEW: helpers for tooltip header =====
  const PREV_OFFSET_DAYS: Record<RangeKey, number> = {
    "1d": 7,     // previous week, same hour/day
    "1w": 7,     // previous week
    "1m": 30,    // previous 30 days
    "6m": 182,   // previous ~6 months
  };

  // parse "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm:ssZ"
  const parseAnyUTC = (s: string): Date | null => {
    if (!s) return null;
    if (s.length > 10) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    return parseYMD(s);
  };

  const formatDayIST = (d: Date) => {
    const ist = new Date(d.getTime() + 19800000); // +05:30
    return ist.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });
  };

  const buildPrevHeader = (raw: string, r: RangeKey) => {
    const base = parseAnyUTC(raw);
    if (!base) return raw || "";
    const prev = new Date(base.getTime() - PREV_OFFSET_DAYS[r] * 86400000);
    return `${formatDayIST(base)} • prev ${formatDayIST(prev)}`;
  };
  // ===== END NEW =====

  // ---------- labels ----------
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

  // ---------- choose labels for active metric ----------
  const activeLabels = useMemo(() => {
    if (metric === "orders") return ordersLabels;
    return jobsLabels;
  }, [metric, ordersLabels, jobsLabels]);

  type Series = { name: string; data: number[] }[];

  // ---------- series ----------
  const activeSeries: Series = useMemo(() => {
    if (metric === "orders") {
      if (!stats) return [];
      return [
        { name: "Current Orders", data: stats.current },
        { name: "Previous Orders", data: stats.previous },
      ];
    }

    if (metric === "jobs") {
      if (!jobsStats) return [];
      return [
        { name: "Current Jobs", data: jobsStats.current_jobs },
        { name: "Previous Jobs", data: jobsStats.previous_jobs },
      ];
    }

    if (!jobsStats) return [];
    return [
      { name: "Current Conversion %", data: jobsStats.conversion_current },
      { name: "Previous Conversion %", data: jobsStats.conversion_previous },
    ];
  }, [metric, stats, jobsStats]);

  const isPercent = metric === "conversion";
  const showDataLabels = ["1d", "1w", "1m", "6m"].includes(range);

  // ---------- chart options ----------
  const chartOptions = useMemo(() => {
    const colors =
      activeSeries.length === 2
        ? ["#2563eb", "#22c55e"] // current, previous
        : ["#2563eb"];

    const hourGran =
      metric === "orders"
        ? stats?.granularity === "hour"
        : jobsStats?.granularity === "hour";

    return {
      chart: {
        id: "unified-metric",
        toolbar: { show: false },
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
        animations: { enabled: true, easing: "easeinout", speed: 250 },
      },
      colors,
      xaxis: {
        categories: activeLabels,
        labels: {
          style: { colors: "#0f172a", fontWeight: 600 },
          rotate: range === "1m" || range === "6m" ? -30 : 0,
          hideOverlappingLabels: true,
          trim: true,
          maxHeight: 80,
        },
        axisBorder: { color: "#e2e8f0" },
        axisTicks: { color: "#e2e8f0" },
      },
      yaxis: {
        title: {
          text:
            metric === "orders"
              ? "Orders"
              : metric === "jobs"
              ? "Jobs (Preview Created)"
              : "Conversion %",
          style: { fontWeight: 600, color: "#334155" },
        },
        forceNiceScale: true,
        labels: {
          style: { colors: "#0f172a", fontWeight: 600 },
          formatter: (v: number) =>
            isPercent ? `${Math.round(v)}%` : `${Math.round(v)}`,
        },
        min: 0,
      },
      grid: {
        borderColor: "#e2e8f0",
        strokeDashArray: 3,
        padding: { left: 12, right: 12 },
      },
      stroke: {
        width: activeSeries.length === 2 ? [3, 3] : 3,
        curve: "smooth",
        dashArray: activeSeries.length === 2 ? [0, 6] : 0,
      },
      legend: {
        position: "top",
        horizontalAlign: "center",
        fontWeight: 600,
        labels: { colors: "#334155" },
        markers: { width: 10, height: 10, radius: 12 },
      },
      markers: {
        size: hourGran ? 0 : 3,
        hover: { size: 4 },
      },
      dataLabels: {
        enabled: showDataLabels,
        offsetY: -6,
        formatter: (val: number) =>
          isPercent ? `${Math.round(val)}%` : `${Math.round(val)}`,
        // do NOT set 'style.colors' -> lets badge background use series color
        style: { fontWeight: 700 },                // <— keep weight only
        background: {
          enabled: true,
          foreColor: "#fff",                       // <— readable text on colored pills
          borderRadius: 8,
          borderWidth: 0,
          opacity: 0.95,
        },
      },
      // ===== REPLACED: custom tooltip with header showing both dates =====
      tooltip: {
        shared: true,
        theme: "light",
        custom: (opts: any) => {
          const idx = opts?.dataPointIndex ?? 0;
          const rawLabels =
            metric === "orders" ? (stats?.labels ?? []) : (jobsStats?.labels ?? []);
          const raw = rawLabels[idx] ?? "";
          const header = buildPrevHeader(raw, range);

          // assume series[0] = current, series[1] = previous (your series order)
          const curVal = opts?.series?.[0]?.[idx];
          const prevVal = opts?.series?.[1]?.[idx];

          const fmt = (v: any) =>
            isPercent ? `${Number(v ?? 0).toFixed(2)}%` : `${Math.round(v ?? 0)}`;

          return `
            <div style="padding:8px 10px;min-width:220px">
              <div style="font-weight:600;margin-bottom:6px">${header}</div>

              <div style="display:flex;gap:8px;align-items:center;margin:4px 0">
                <span style="width:8px;height:8px;border-radius:50%;background:#2563eb;display:inline-block"></span>
                <span style="font-weight:600;margin-right:6px">Current:</span>
                <span>${fmt(curVal)}</span>
              </div>

              <div style="display:flex;gap:8px;align-items:center;margin:2px 0">
                <span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block"></span>
                <span style="font-weight:600;margin-right:6px">Previous:</span>
                <span>${fmt(prevVal)}</span>
              </div>
            </div>
          `;
        },
      },
      // ===== END REPLACED =====
    } as const;
  }, [
    metric,
    isPercent,
    activeLabels,
    activeSeries.length,
    range,
    stats?.granularity,
    jobsStats?.granularity,
    showDataLabels,
  ]);

  // ---------- UI ----------
  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <div className="mb-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800">
          Welcome to Diffrun Admin Dashboard
        </h1>

        <div className="flex items-center gap-3">
          <label className="text-sm text-slate-600">Metric</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <option value="orders">Orders</option>
            <option value="jobs">Jobs</option>
            <option value="conversion">Conversion</option>
          </select>

          <label htmlFor="range" className="text-sm text-slate-600 ml-2">
            Range
          </label>
          <select
            id="range"
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <option value="1d">1 day (24h)</option>
            <option value="1w">1 week (7d)</option>
            <option value="1m">1 month (30d)</option>
            <option value="6m">6 months (~182d)</option>
          </select>
        </div>
      </div>

      {(error || jobsError) && (
        <p className="mt-2 text-red-600">
          {error ? `Orders error: ${error}` : `Jobs/Conversion error: ${jobsError}`}
        </p>
      )}

      <section className="bg-gray-200 rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
        {(metric === "orders" && !stats) ||
        ((metric === "jobs" || metric === "conversion") && !jobsStats) ? (
          <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />
        ) : (
          <ReactApexChart
            key={`${metric}-${range}-${activeLabels.length}`}
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
