"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

type StatsResponse = {
  labels: string[];
  current: number[];
  previous: number[];
  exclusions: string[];
};

export default function Home() {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string>("");

  const exclusions = ["TEST", "LHMM", "COLLAB", "REJECTED"];

  useEffect(() => {
    const params = new URLSearchParams();
    exclusions.forEach((c) => params.append("exclude_codes", c));
    fetch(`${baseUrl}/stats/orders-rolling7?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, [baseUrl]);

  const parseYMD = (input: unknown) => {
    const s = String(input ?? "");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    return new Date(Date.UTC(y, mo, d));
  };

  const shiftDays = (ymd: string, days: number) => {
    const base = parseYMD(ymd);
    if (!base) return ymd;
    const shifted = new Date(base.getTime() + days * 86400000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const d = String(shifted.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };

  const prettyIST = (ymd: string) => {
    const base = parseYMD(ymd);
    if (!base) return ymd || "";
    const ist = new Date(base.getTime() + 19800000);
    return ist.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });
  };

  const rawLabels = stats?.labels ?? [];
  const formattedLabels = useMemo(() => rawLabels.map(prettyIST), [stats]);

  const chartSeries = useMemo(() => {
    if (!stats) return [];
    return [
      { name: "Current 7 days", data: stats.current },
      { name: "Previous 7 days", data: stats.previous },
    ];
  }, [stats]);

  const chartOptions = useMemo(() => {
    return {
      chart: {
        id: "orders-rolling-7d",
        toolbar: { show: false },
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
      },
      colors: ["#2563eb", "#22c55e"],
      xaxis: {
        categories: formattedLabels,
        labels: {
          style: { colors: "#0f172a", fontWeight: 600 },
          formatter: (val: string) => val,
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
      markers: { size: 3, hover: { size: 5 } },
      dataLabels: {
        enabled: true,
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
            const prev = curr ? shiftDays(curr, -7) : "";
            const a = curr ? prettyIST(curr) : "";
            const b = prev ? prettyIST(prev) : "";
            return b ? `${a} • prev ${b}` : a;
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
  }, [formattedLabels, rawLabels]);

  return (
    <main className="min-h-screen p-6 sm:p-8 bg-slate-50">
      <h1 className="text-2xl sm:text-3xl font-semibold text-slate-800 mb-4">
        Welcome to Diffrun Admin Dashboard
      </h1>
      {error && <p className="mt-4 text-red-600">Error: {error}</p>}
      <section className="bg-gray-200 rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
        {stats ? (
          <ReactApexChart options={chartOptions as any} series={chartSeries as any} type="line" height={360} />
        ) : (
          <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />
        )}
      </section>
    </main>
  );
}
