"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type MiniJob = {
  job_id: string;
  name: string;
  gender: string;
  age: string | number;
  email: string;
  created_at: string | null;
  book_id: string;
  preview_url: string;
  partial_preview?: string | null; // timestamp, not URL
  final_preview?: string | null;   // timestamp, not URL
  paid?: boolean;
  approved?: boolean;
  input_images: string[];

  // twin support
  is_twin?: boolean;
  child1_age?: string | number | null;
  child2_age?: string | number | null;

  // filenames (optional, keep for audit)
  child1_image_filenames?: string[];
  child2_image_filenames?: string[];

  // NEW: presigned URLs to show images
  child1_input_images?: string[];
  child2_input_images?: string[];
};

const ACCENT = "#5784ba";

const prettyIso = (s?: string | null): string => {
  if (!s) return "-";
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(s);
  const [, y, mo, d, hh, mm] = m;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = parseInt(hh, 10);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h >= 12 ? "pm" : "am";
  return `${parseInt(d, 10)} ${months[parseInt(mo, 10) - 1]} ${y}, ${String(h12).padStart(2, "0")}:${mm} ${ampm}`;
};

const Pill = ({ ok, label }: { ok?: boolean; label: string }) => (
  <span
    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
    style={{
      color: ok ? "#065f46" : "#92400e",
      backgroundColor: ok ? "#d1fae5" : "#fef3c7",
      border: `1px solid ${ok ? "#a7f3d0" : "#fde68a"}`
    }}
    title={label}
  >
    {label}: {ok ? "Yes" : "No"}
  </span>
);

const JobDetail = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobIdFromQS = searchParams.get("job_id");
  const backendUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";
  const [data, setData] = useState<MiniJob | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string>("");

  const endpoint = useMemo(() => {
    if (!jobIdFromQS) return null;
    return `${backendUrl}/jobs/${encodeURIComponent(jobIdFromQS)}/mini`;
  }, [backendUrl, jobIdFromQS]);

  const fetchData = async () => {
    if (!endpoint) return;
    setLoading(true);
    setErr("");
    const ctrl = new AbortController();
    try {
      const res = await fetch(endpoint, { signal: ctrl.signal });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Request failed (${res.status})`);
      }
      const j: MiniJob = await res.json();
      setData(j);
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
    return () => ctrl.abort();
  };

  useEffect(() => {
    fetchData();
  }, [endpoint]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch { }
  };

  if (!jobIdFromQS) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-5xl mx-auto px-3 py-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h1 className="text-xl font-semibold text-gray-900">Job Details</h1>
            <p className="mt-2 text-sm text-gray-600">
              Pass a <code className="px-1 py-0.5 rounded bg-gray-100">job_id</code> in the URL query to view details.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // show either single Age OR per-child ages
  const showChildAges =
    Boolean(data?.is_twin) ||
    (data?.child1_age !== undefined && data?.child1_age !== null && String(data?.child1_age).trim() !== "") ||
    (data?.child2_age !== undefined && data?.child2_age !== null && String(data?.child2_age).trim() !== "");

  const overviewRows = [
    { label: "Name", value: data?.name ?? "" },
    { label: "Gender", value: (data?.gender || "-") as string },
    ...(showChildAges
      ? [
        { label: "Child 1 Age", value: data?.child1_age ? String(data.child1_age) : "-" },
        { label: "Child 2 Age", value: data?.child2_age ? String(data.child2_age) : "-" },
      ]
      : [{ label: "Age", value: data?.age ? String(data.age) : "-" }]),
    { label: "Email", value: data?.email ?? "", copyable: true },
    { label: "Book ID", value: data?.book_id || "-" },
    { label: "Created", value: prettyIso(data?.created_at ?? null) },
    { label: "Partial Preview Generated", value: prettyIso(data?.partial_preview ?? null) },
    { label: "Final Preview Generated", value: prettyIso(data?.final_preview ?? null) },
  ];

  // helpers to render a simple thumbnail grid
  const ThumbGrid = ({ urls }: { urls: string[] }) => (
    <div className="grid grid-cols-3 gap-2">
      {urls.map((u, i) => (
        <a key={i} href={u} target="_blank" rel="noreferrer" className="group block" title="Open original">
          <div className="aspect-square overflow-hidden rounded-lg border border-gray-100 bg-gray-50">
            <img
              src={u}
              alt={`Input ${i + 1}`}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          </div>
        </a>
      ))}
    </div>
  );

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-3 py-6">
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <h1 className="text-xs md:text-2xl font-bold text-gray-900 leading-tight">
              Job • <span style={{ color: ACCENT }}>{jobIdFromQS}</span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.back()}
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-100 transition"
            >
              Back
            </button>
            <button
              onClick={fetchData}
              className="px-3 py-1.5 rounded-lg text-white text-sm transition"
              style={{ backgroundColor: ACCENT }}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-100 px-4 sm:px-6 py-4 bg-gray-50/60">
            <div className="flex items-center justify-between">
              <h2 className="text-base sm:text-lg font-semibold text-gray-900">Overview</h2>
              {loading ? (
                <div className="h-2 w-20 rounded-full bg-gray-200 animate-pulse" />
              ) : (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ color: ACCENT, backgroundColor: "#eaf1f8" }}
                >
                  {data ? "Loaded" : "Not found"}
                </span>
              )}
            </div>
          </div>

          <div className="p-4 sm:p-6">
            {err && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {err}
              </div>
            )}

            {loading ? (
              <Skeleton />
            ) : data ? (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <Pill ok={data.paid} label="Paid" />
                  <Pill ok={data.approved} label="Approved" />
                </div>

                <DetailsGrid rows={overviewRows} onCopy={copy} accent={ACCENT} />

                <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-900">Preview</h3>
                      {data.preview_url ? (
                        <button
                          onClick={() => window.open(data.preview_url, "_blank", "noopener,noreferrer")}
                          className="rounded-md px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 transition"
                          style={{ backgroundColor: ACCENT }}
                        >
                          Open Preview
                        </button>
                      ) : (
                        <span className="text-sm text-gray-500">Unavailable</span>
                      )}
                    </div>
                    <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-4 text-sm text-gray-500">
                      {data.preview_url ? "A direct link to the preview file." : "No preview URL found for this job."}
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-900">Input Images</h3>
                      <span className="text-xs text-gray-500">
                        {data.input_images?.length || 0} file(s)
                      </span>
                    </div>

                    {data.input_images?.length ? (
                      <div className="mb-4">
                        <ThumbGrid urls={data.input_images} />
                      </div>
                    ) : (data?.child1_input_images?.length || data?.child2_input_images?.length) ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <div className="text-sm font-semibold text-gray-900 mb-2">Child 1</div>
                          {data.child1_input_images?.length ? (
                            <ThumbGrid urls={data.child1_input_images} />
                          ) : (
                            <div className="text-sm text-gray-400">No files</div>
                          )}
                        </div>

                        {(data.is_twin || data.child2_input_images?.length) ? (
                          <div>
                            <div className="text-sm font-semibold text-gray-900 mb-2">Child 2</div>
                            {data.child2_input_images?.length ? (
                              <ThumbGrid urls={data.child2_input_images} />
                            ) : (
                              <div className="text-sm text-gray-400">No files</div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="h-[140px] rounded-lg border border-dashed border-gray-200 bg-gray-50 flex items-center justify-center text-sm text-gray-400 mb-4">
                        No input images
                      </div>
                    )}
                  </div>

                </div>
              </>
            ) : (
              <div className="py-12 text-center text-gray-500">No data found for this job.</div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
};

const DetailsGrid = ({
  rows,
  onCopy,
  accent,
}: {
  rows: { label: string; value: string; copyable?: boolean }[];
  onCopy: (text: string) => void;
  accent: string;
}) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
    {rows.map((r, idx) => (
      <div
        key={idx}
        className="flex items-start justify-between gap-2 rounded-lg border border-gray-100 p-3 hover:shadow-sm transition"
      >
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500">{r.label}</div>
          <div className="mt-0.5 text-sm font-medium text-gray-900 break-all">{r.value || "-"}</div>
        </div>
        {r.copyable && r.value ? (
          <button
            onClick={() => onCopy(r.value)}
            className="ml-2 mt-1 rounded-md px-2 py-1 text-xs font-medium text-white hover:opacity-90 transition"
            style={{ backgroundColor: accent }}
            title="Copy"
          >
            Copy
          </button>
        ) : null}
      </div>
    ))}
  </div>
);

const Skeleton = () => (
  <div className="animate-pulse">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-gray-100 p-3">
          <div className="h-3 w-20 bg-gray-200 rounded mb-2" />
          <div className="h-4 w-40 bg-gray-200 rounded" />
        </div>
      ))}
    </div>
  </div>
);

export default JobDetail;