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
  unpaid_with_preview: number[];
  paid_with_preview: number[];
  granularity: "hour" | "day";
};

type RangeKey = "1d" | "1w" | "1m" | "6m";

export default function Home() {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string>("");

  const [jobsStats, setJobsStats] = useState<JobsStatsResponse | null>(null);
  const [jobsError, setJobsError] = useState<string>("");

  const [range, setRange] = useState<RangeKey>("1w");

  const exclusions = ["TEST", "LHMM", "COLLAB", "REJECTED"];

  const buildUrl = (r: RangeKey) => {
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

  useEffect(() => {
    setError("");
    setStats(null);

    const url = buildUrl(range);
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, [baseUrl, range]);

  useEffect(() => {
    setJobsError("");
    setJobsStats(null);

    const url = buildJobsUrl(range);
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setJobsStats)
      .catch((e) => setJobsError(String(e)));
  }, [baseUrl, range]);

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
    const ist = new Date(base.getTime() + 19800000);
    if (range === "1m" || range === "6m") {
      return ist.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    }
    return ist.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
  };

  const isHourly = stats?.granularity === "hour";
  const rawLabels = stats?.labels ?? [];

  const formattedLabels = useMemo(() => {
    if (isHourly) {
      return rawLabels.map((s) => s.slice(11));
    }
    return rawLabels.map(prettyIST);
  }, [stats, range]);

  const chartSeries = useMemo(() => {
    if (!stats) return [];
    return [
      { name: "Current", data: stats.current },
      { name: "Previous", data: stats.previous },
    ];
  }, [stats]);

  const chartOptions = useMemo(() => {
    return {
      chart: {
        id: "orders-range",
        toolbar: { show: false },
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
        animations: { enabled: true, easing: "easeinout", speed: 250 },
      },
      colors: ["#2563eb", "#22c55e"],
      xaxis: {
        categories: formattedLabels,
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
        title: { text: "Orders", style: { fontWeight: 600, color: "#334155" } },
        forceNiceScale: true,
        labels: { style: { colors: "#0f172a", fontWeight: 600 } },
      },
      grid: {
        borderColor: "#e2e8f0",
        strokeDashArray: 3,
        padding: { left: 12, right: 12 },
      },
      stroke: { width: [3, 3], curve: "smooth", dashArray: [0, 6] },
      legend: {
        position: "top",
        horizontalAlign: "center",
        fontWeight: 600,
        labels: { colors: "#334155" },
        markers: { width: 10, height: 10, radius: 12 },
      },
      markers: { size: isHourly ? 0 : 3, hover: { size: 4 } },
      dataLabels: {
        enabled: range === "1d" || range === "1w",
        offsetY: -6,
        style: { fontWeight: 700, colors: ["#1e293b"] },
        background: {
          enabled: true,
          borderRadius: 8,
          borderWidth: 0,
          opacity: 0.9,
          foreColor: "#fff",
        },
      },
      tooltip: {
        shared: true,
        x: {
          formatter: (_val: any, opts: any) => {
            const idx = opts?.dataPointIndex ?? 0;
            const curr = rawLabels[idx];
            if (isHourly) {
              const hh = curr?.slice(11) ?? "";
              const ymd = curr?.slice(0, 10) ?? "";
              const prevYmd = ymd
                ? ((): string => {
                    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
                    if (!m) return "";
                    const y = Number(m[1]),
                      mo = Number(m[2]) - 1,
                      d = Number(m[3]);
                    const prev = new Date(Date.UTC(y, mo, d) - 7 * 86400000);
                    const prevY = prev.getUTCFullYear();
                    const prevM = String(prev.getUTCMonth() + 1).padStart(2, "0");
                    const prevD = String(prev.getUTCDate()).padStart(2, "0");
                    return `${prevY}-${prevM}-${prevD}`;
                  })()
                : "";
              const prevDayPretty = prevYmd
                ? (() => {
                    const base = parseYMD(prevYmd);
                    if (!base) return "";
                    const ist = new Date(base.getTime() + 19800000);
                    return ist.toLocaleDateString("en-GB", {
                      weekday: "short",
                      day: "2-digit",
                      month: "short",
                      timeZone: "UTC",
                    });
                  })()
                : "";
              return prevDayPretty ? `${hh} • prev ${prevDayPretty} ${hh}` : `${hh}`;
            }
            const prevOffsetDays = (r: RangeKey) => {
              switch (r) {
                case "1d":
                  return -1;
                case "1w":
                  return -7;
                case "1m":
                  return -30;
                case "6m":
                  return -182;
              }
            };
            const offset = prevOffsetDays(range);
            const currBase = curr || "";
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currBase);
            if (m) {
              const a = prettyIST(currBase);
              const y = Number(m[1]),
                mo = Number(m[2]) - 1,
                d = Number(m[3]);
              const prev = new Date(Date.UTC(y, mo, d) + (offset ?? -7) * 86400000);
              const prevY = prev.getUTCFullYear();
              const prevM = String(prev.getUTCMonth() + 1).padStart(2, "0");
              const prevD = String(prev.getUTCDate()).padStart(2, "0");
              const b = prettyIST(`${prevY}-${prevM}-${prevD}`);
              return `${a} • prev ${b}`;
            }
            return curr ?? "";
          },
        },

        y: {
          formatter: (val: number, opts: any) => {
            const seriesName = opts?.w?.globals?.seriesNames?.[opts?.seriesIndex] || "";
            return `${seriesName}: ${val}`;
          },
        },
        style: { fontSize: "14px" },
        theme: "light",
      },
    } as const;
  }, [formattedLabels, rawLabels, range, isHourly]);

  const jobsIsHourly = jobsStats?.granularity === "hour";
  const jobsFormattedLabels = useMemo(() => {
    if (!jobsStats) return [];
    return jobsIsHourly ? jobsStats.labels.map((s) => s.slice(11)) : jobsStats.labels.map(prettyIST);
  }, [jobsStats, range]);

  const jobsCounts = jobsStats?.unpaid_with_preview ?? [];
  const ordersCounts = jobsStats?.paid_with_preview ?? [];

  const conversionPct = useMemo(() => {
    const len = Math.max(jobsCounts.length, ordersCounts.length);
    const out: number[] = new Array(len).fill(0);
    for (let i = 0; i < len; i++) {
      const jobs = Number(jobsCounts[i] ?? 0);
      const orders = Number(ordersCounts[i] ?? 0);
      out[i] = jobs > 0 ? +(orders * 100 / jobs).toFixed(2) : 0;
    }
    return out;
  }, [jobsCounts, ordersCounts]);

  const jobsSeries = useMemo(() => {
    if (!jobsStats) return [];
    return [
      { name: "Jobs", data: jobsCounts },
      { name: "Conversion", data: conversionPct },
    ];
  }, [jobsStats, jobsCounts, conversionPct]);

  const showJobsDataLabels = range === "1d" || range === "1w";

  const jobsOptions = useMemo(() => {
  return {
    chart: {
      id: "preview-vs-orders",
      toolbar: { show: false },
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
      animations: { enabled: true, easing: "easeinout", speed: 250 },
    },
    colors: ["#2563eb", "#22c55e"], // blue = Jobs, green = Conversion
    xaxis: {
      categories: jobsFormattedLabels,
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
    yaxis: [
      {
        title: { text: "Jobs (Preview Created)", style: { fontWeight: 600, color: "#2563eb" } },
        labels: { style: { colors: "#2563eb", fontWeight: 600 } },
        forceNiceScale: true,
      },
      {
        opposite: true,
        title: { text: "Conversion %", style: { fontWeight: 600, color: "#22c55e" } },
        labels: {
          style: { colors: "#22c55e", fontWeight: 600 },
          formatter: (v: number) => `${v.toFixed(0)}%`,
        },
        min: 0,
        max: 40,
        tickAmount: 5,
      },
    ],
    grid: {
      borderColor: "#e2e8f0",
      strokeDashArray: 3,
      padding: { left: 12, right: 12 },
    },
    stroke: { width: [3, 3], curve: "smooth", dashArray: [0, 0] }, // dotted conversion
    legend: {
      position: "top",
      horizontalAlign: "center",
      fontWeight: 600,
      labels: { colors: "#334155" },
      markers: { width: 10, height: 10, radius: 12 },
    },
    markers: { size: jobsIsHourly ? 0 : 3, hover: { size: 4 } },

    // >>> NEW: show labels like the first chart
    dataLabels: {
      enabled: showJobsDataLabels,
      enabledOnSeries: [0, 1],
      offsetY: -6,
      formatter: (val: number, opts: any) => {
        const idx = opts?.seriesIndex ?? 0;
        if (idx === 1) return `${Math.round(val)}%`; // Conversion
        return `${Math.round(val)}`;                 // Jobs
      },
      style: { fontWeight: 700, colors: ["#1e293b"] },
      background: {
        enabled: true,
        borderRadius: 8,
        borderWidth: 0,
        opacity: 0.9,
        foreColor: "#fff",
      },
    },

    tooltip: {
      shared: true,
      theme: "light",
      y: {
        formatter: (val: number, opts: any) => {
          const name = opts?.w?.globals?.seriesNames?.[opts?.seriesIndex] || "";
          if (name === "Conversion") return `${name}: ${val.toFixed(2)}%`;
          return `${name}: ${val}`;
        },
      },
    },
  } as const;
}, [jobsFormattedLabels, range, jobsIsHourly, showJobsDataLabels]);


  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800">
          Welcome to Diffrun Admin Dashboard
        </h1>
        <div className="flex items-center gap-2">
          <label htmlFor="range" className="text-sm text-slate-600">Range</label>
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

      {error && <p className="mt-2 text-red-600">Error: {error}</p>}

      <section className="bg-gray-200 rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
        {stats ? (
          <ReactApexChart
            key={`${range}-${stats.labels.length}`}
            options={chartOptions as any}
            series={chartSeries as any}
            type="line"
            height={360}
          />
        ) : (
          <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />
        )}
      </section>

      <div className="h-6" />

      {jobsError && <p className="mt-2 text-red-600">Error: {jobsError}</p>}

      <section className="bg-gray-200 rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
        <h2 className="text-lg sm:text-xl font-semibold text-slate-800 mb-3">
          Preview vs Orders (Jobs)
        </h2>
        {jobsStats ? (
          <ReactApexChart
            key={`jobs-${range}-${jobsStats.labels.length}`}
            options={jobsOptions as any}
            series={jobsSeries as any}
            type="line"
            height={360}
          />
        ) : (
          <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />
        )}
      </section>
    </main>
  );
}
