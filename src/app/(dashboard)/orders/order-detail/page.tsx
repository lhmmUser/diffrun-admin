"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

const LOCALE_TO_CURRENCY_CODE: Record<string, string> = {
    US: "USD",
    CA: "CAD",
    IN: "INR",
    AU: "AUD",
    NZ: "NZD",
    GB: "GBP",
    AE: "AED",
};
const LOCALE_TO_NUMBER_LOCALE: Record<string, string> = {
    US: "en-US",
    CA: "en-CA",
    IN: "en-IN",
    AU: "en-AU",
    NZ: "en-NZ",
    GB: "en-GB",
    AE: "en-AE",
};

function formatMoney(amount: string | number | "", locale?: string) {
    const cleanLocale = String(locale || "US").toUpperCase();
    const code = LOCALE_TO_CURRENCY_CODE[cleanLocale] || "USD";
    const nfLocale = LOCALE_TO_NUMBER_LOCALE[cleanLocale] || "en-US";

    const n = typeof amount === "number" ? amount : Number(String(amount).trim());
    if (!Number.isFinite(n)) return String(amount ?? "");

    return new Intl.NumberFormat(nfLocale, {
        style: "currency",
        currency: code,
        currencyDisplay: "symbol",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(n);
}

type ShippingAddress = {
    street?: string;
    city?: string;
    state?: string;
    country?: string;
    zip?: string;
    phone?: string;
};

type ChildDetails = {
    name?: string;
    age?: string | number;
    gender?: string;
    saved_files?: string[];
    saved_file_urls?: string[];
    is_twin?: boolean;
    child1_age?: string | number | null;
    child2_age?: string | number | null;
    child1_image_filenames?: string[];
    child2_image_filenames?: string[];
    child1_input_images?: string[];
    child2_input_images?: string[];
};


type CustomerDetails = {
    user_name?: string;
    email?: string;
    phone_number?: string;
};

type OrderFinancial = {
    order_id?: string;
    discount_code?: string;
    total_price?: string | number;
    transaction_id?: string;
    cover_url?: string;
    book_url?: string;
    paypal_capture_id?: string;
    paypal_order_id?: string;
    cover_image?: string;
};

type Timeline = {
    created_at?: string | null;
    processed_at?: string | null;
    approved_at?: string | null;
    print_sent_at?: string | null;
    shipped_at?: string | null;
};

type OrderDetail = {
    order_id: string;
    name?: string;
    email?: string;
    phone?: string;
    gender?: string;
    user_name?: string;
    book_id?: string;
    book_style?: string;
    discount_code?: string;
    quantity?: number;
    cust_status?: "red" | "green" | "" | undefined;
    shipping_address?: ShippingAddress;
    preview_url?: string;
    job_id?: string;
    locale?: string; // <-- used to format Total Price
    child?: ChildDetails;
    customer?: CustomerDetails;
    order?: OrderFinancial;
    timeline?: Timeline;
    cover_image?: string;
};

type FormState = {
    name: string;
    age: string | number | "";
    gender: string;
    book_id: string;
    order_id: string;
    book_style: string;
    discount_code: string;
    quantity: number;
    preview_url: string;
    total_price: string | number | "";
    transaction_id: string;
    paypal_capture_id: string;
    paypal_order_id: string;
    cover_url: string;
    book_url: string;
    user_name: string;
    email: string;
    phone: string;
    cust_status: string;
    shipping_address: {
        street: string;
        city: string;
        state: string;
        country: string;
        postal_code: string;
    };
    timeline: {
        created_at: string;
        processed_at: string;
        approved_at: string;
        print_sent_at: string;
        shipped_at: string;
    };
};

function ThumbGrid({ urls }: { urls: string[] }) {
    if (!urls?.length) return null;
    return (
        <div className="grid grid-cols-3 gap-1">
            {urls.map((u, i) => (
                <a key={i} href={u} target="_blank" rel="noreferrer" className="block" title={u}>
                    <img
                        src={u}
                        alt={`child_input_${i + 1}`}
                        className="w-20 h-20 object-cover rounded border border-gray-200 hover:border-[#5784ba]"
                    />
                </a>
            ))}
        </div>
    );
}

const TimelineItem = ({ label, date, isLast = false }: { label: string; date: string; isLast?: boolean }) => (
    <div className="flex items-start">
        <div className="flex flex-col items-center mr-3">
            <div className="w-2 h-2 rounded-full bg-[#5784ba]"></div>
            {!isLast && <div className="w-0.5 h-8 bg-gray-300"></div>}
        </div>
        <div className="flex-1 pb-2">
            <p className="text-xs font-medium text-gray-900">{label}</p>
            <p className="text-xs text-gray-600">{date}</p>
        </div>
    </div>
);

export default function OrderDetailPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const orderIdFromQS = searchParams.get("order_id");
    const rawOrderId = useMemo(() => {
        try {
            return decodeURIComponent(orderIdFromQS || "");
        } catch {
            return orderIdFromQS || "";
        }
    }, [orderIdFromQS]);

    const [loading, setLoading] = useState(false);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [order, setOrder] = useState<OrderDetail | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [form, setForm] = useState<FormState | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveErr, setSaveErr] = useState<string | null>(null);
    const [coverErr, setCoverErr] = useState(false);

    const toFormState = (o: OrderDetail): FormState => ({
        name: o.name || o.child?.name || "",
        age: (o.child?.age as any) ?? (o as any).age ?? "",
        gender: (o.child?.gender || o.gender || "").toString(),
        book_id: o.book_id || "",
        book_style: o.book_style || "",
        discount_code: o.discount_code || "",
        quantity: o.quantity ?? 1,
        preview_url: o.preview_url || "",
        order_id: o.order_id || "",
        total_price: (o.order?.total_price as any) ?? (o as any).total_price ?? "",
        transaction_id: o.order?.transaction_id || (o as any).transaction_id || "",
        paypal_capture_id: o.order?.paypal_capture_id || "",
        paypal_order_id: o.order?.paypal_order_id || "",
        cover_url: o.order?.cover_url || "",
        book_url: o.order?.book_url || "",
        user_name: o.user_name || o.customer?.user_name || "",
        email: o.email || o.customer?.email || "",
        phone: o.phone || o.customer?.phone_number || "",
        cust_status: (o as any).cust_status || "",
        shipping_address: {
            street: o.shipping_address?.street || "",
            city: o.shipping_address?.city || "",
            state: o.shipping_address?.state || "",
            country: o.shipping_address?.country || "",
            postal_code: o.shipping_address?.zip || "",
        },
        timeline: {
            created_at: o.timeline?.created_at || "",
            processed_at: o.timeline?.processed_at || "",
            approved_at: o.timeline?.approved_at || "",
            print_sent_at: o.timeline?.print_sent_at || "",
            shipped_at: o.timeline?.shipped_at || "",
        },
    });

    useEffect(() => {
        if (!rawOrderId) return;
        (async () => {
            setLoading(true);
            setLoadErr(null);
            setOrder(null);
            try {
                const url = `${API_BASE}/orders/${encodeURIComponent(rawOrderId)}`;
                const res = await fetch(url, { cache: "no-store" });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${res.status}`);
                }
                const data: OrderDetail = await res.json();
                setOrder(data);
                setForm(toFormState(data));
            } catch (e: any) {
                setLoadErr(e?.message || "Failed to load order");
            } finally {
                setLoading(false);
            }
        })();
    }, [rawOrderId]);

    const updateForm = (path: string, value: any) => {
        setForm((prev: any) => {
            const next = structuredClone(prev ?? {});
            const parts = path.split(".");
            let ref = next;
            for (let i = 0; i < parts.length - 1; i++) {
                ref[parts[i]] = ref[parts[i]] ?? {};
                ref = ref[parts[i]];
            }
            ref[parts[parts.length - 1]] = value;
            return next;
        });
    };

    const buildPayload = () => {
        if (!order || !form) return {};
        const base = toFormState(order);
        const out: any = {};
        const walk = (curr: any, baseObj: any, prefix = "") => {
            for (const k of Object.keys(curr)) {
                const currV = curr[k];
                const baseV = baseObj?.[k];
                if (currV && typeof currV === "object" && !Array.isArray(currV)) {
                    walk(currV, baseV || {}, prefix ? `${prefix}.${k}` : k);
                } else if (currV !== baseV) {
                    const parts = (prefix ? `${prefix}.${k}` : k).split(".");
                    let ref = out;
                    for (let i = 0; i < parts.length - 1; i++) {
                        ref[parts[i]] = ref[parts[i]] || {};
                        ref = ref[parts[i]];
                    }
                    ref[parts[parts.length - 1]] = currV;
                }
            }
        };
        walk(form, base);
        delete (out as any).child;
        delete (out as any).order;
        delete (out as any).saved_files;
        delete (out as any).cover_image;
        return out;
    };

    const save = async () => {
        if (!rawOrderId || !form) return;
        setSaving(true);
        setSaveErr(null);
        try {
            const payload = buildPayload();
            delete (payload as any).child;
            delete (payload as any).order;
            delete (payload as any).saved_files;
            delete (payload as any).cover_image;
            if (Object.keys(payload).length === 0) {
                setIsEditing(false);
                alert("No changes to save.");
                return;
            }
            const res = await fetch(`${API_BASE}/orders/${encodeURIComponent(rawOrderId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            const data = await res.json();
            const updated: OrderDetail = (data.order ?? data) as OrderDetail;
            setOrder(updated);
            setForm(toFormState(updated));
            setIsEditing(false);
            alert("✅ Changes saved successfully");
        } catch (e: any) {
            setSaveErr(e?.message || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const cancelEdit = () => {
        if (order) setForm(toFormState(order));
        setIsEditing(false);
        setSaveErr(null);
    };

    const formatIso = (iso?: string | null) => {
        if (!iso) return "-";
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return iso as string;
            const formatted = new Intl.DateTimeFormat("en-IN", {
                timeZone: "Asia/Kolkata",
                year: "numeric",
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
            }).format(d);
            return `${formatted}`;
        } catch {
            return iso as string;
        }
    };

    const prettyDate = (s?: string | null): string => {
        if (!s) return "-";
        const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?/);
        if (!m) return String(s);
        const [, y, mo, d, hh, mm] = m;
        const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
        const ist = new Date(dt.getTime() + 330 * 60 * 1000);
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const day = ist.getUTCDate();
        const mon = months[ist.getUTCMonth()];
        const yr = ist.getUTCFullYear();
        const hrs = ist.getUTCHours();
        const mins = String(ist.getUTCMinutes()).padStart(2, "0");
        const h12 = hrs % 12 === 0 ? 12 : hrs % 12;
        const ampm = hrs >= 12 ? "pm" : "am";
        return `${day} ${mon} ${yr}, ${String(h12).padStart(2, "0")}:${mins} ${ampm}`;
    };

    const coverUrl = order?.cover_image || order?.order?.cover_image || "";

    function InfoField({
        label,
        value,
        editable = false,
        onChange,
        type = "text",
        className = "",
    }: {
        label: string;
        value: string | number;
        editable?: boolean;
        onChange?: (value: any) => void;
        type?: string;
        className?: string;
    }) {
        const isLink = type === "link";
        return (
            <div className={`grid grid-cols-[auto,1fr] items-center gap-2 ${className}`}>
                <span className="text-xs font-bold text-gray-700">{label}:</span>
                {editable ? (
                    type === "select" ? (
                        <select
                            className="border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-[#5784ba] text-xs w-full"
                            value={value as string}
                            onChange={(e) => onChange?.(e.target.value)}
                        >
                            <option value="boy">boy</option>
                            <option value="girl">girl</option>
                        </select>
                    ) : type === "number" ? (
                        <input
                            type="number"
                            min={1}
                            className="border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-[#5784ba] text-xs w-full"
                            value={value}
                            onChange={(e) => {
                                const num = Number.isFinite(+e.target.value) ? parseInt(e.target.value || "1", 10) : 1;
                                onChange?.(Math.max(1, num));
                            }}
                        />
                    ) : (
                        <input
                            type={isLink ? "url" : type}
                            className="border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-[#5784ba] text-xs w-full"
                            value={value as any}
                            onChange={(e) => onChange?.(e.target.value)}
                        />
                    )
                ) : isLink && value ? (
                    <a href={String(value)} target="_blank" rel="noreferrer" className="text-xs text-[#5784ba] underline">
                        Open
                    </a>
                ) : (
                    <span className="text-xs text-gray-900">{value || "-"}</span>
                )}
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-gray-50 py-4">
            <div className="max-w-7xl mx-auto px-2">
                <div className="flex items-center justify-between mb-4">
                    <div className="min-w-0">
                        <h1 className="text-xl sm:text-3xl font-bold text-gray-900 leading-tight break-words">
                            {orderIdFromQS ? `${rawOrderId}` : "No order selected"}
                        </h1>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => router.push("/orders")}
                            className="px-2.5 py-1 border border-gray-300 rounded text-gray-700 hover:bg-gray-100 text-xs"
                        >
                            Back
                        </button>
                        {!isEditing && order && (
                            <button
                                onClick={() => setIsEditing(true)}
                                className="px-2.5 py-1 bg-[#5784ba] text-white rounded hover:bg-[#4a76a8] text-xs font-medium"
                            >
                                Edit
                            </button>
                        )}
                        {isEditing && (
                            <>
                                <button
                                    onClick={cancelEdit}
                                    className="px-2.5 py-1 border border-gray-300 rounded text-gray-700 hover:bg-gray-100 text-xs"
                                    disabled={saving}
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={save}
                                    className="px-2.5 py-1 bg-[#5784ba] text-white rounded hover:bg-[#4a76a8] text-xs font-medium disabled:opacity-60"
                                    disabled={saving}
                                >
                                    {saving ? "Saving..." : "Save"}
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {loading && (
                    <div className="flex justify-center items-center py-6">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#5784ba]"></div>
                    </div>
                )}

                {loadErr && (
                    <div className="bg-red-50 border border-red-200 rounded p-3 text-center">
                        <p className="text-red-800 font-medium text-xs">Error loading order</p>
                        <p className="text-red-600 mt-1 text-xs break-words">{loadErr}</p>
                    </div>
                )}

                {order && form && !loading && !loadErr && (
                    <div className="grid grid-cols-1 xl:grid-cols-4 gap-3">
                        <div className="xl:col-span-3 space-y-3">
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                                <div className="lg:col-span-2 bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Order Information</h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5">
                                        <InfoField label="Order ID" value={order.order_id} editable={isEditing} onChange={(v) => updateForm("order_id", v)} />
                                        <InfoField label="Book ID" value={form.book_id} editable={isEditing} onChange={(v) => updateForm("book_id", v)} />
                                        <InfoField label="Quantity" value={form.quantity} editable={isEditing} onChange={(v) => updateForm("quantity", v)} type="number" />
                                        <InfoField label="Book Style" value={form.book_style} editable={isEditing} onChange={(v) => updateForm("book_style", v)} />

                                        {/* Read-only additions */}
                                        <InfoField label="Job ID" value={order.job_id || "-"} />
                                        <InfoField label="Locale" value={order.locale || "-"} />

                                        {/* Total Price with currency symbol (₹ for IN, etc.). Editable shows raw input. */}
                                        <InfoField
                                            label="Total Price"
                                            value={isEditing ? (form.total_price || "") : formatMoney(form.total_price || "", order.locale)}
                                            editable={isEditing}
                                            onChange={(v) => updateForm("total_price", v)}
                                        />

                                        <InfoField label="Discount Code" value={form.discount_code} editable={isEditing} onChange={(v) => updateForm("discount_code", v)} />
                                        <InfoField label="Preview URL" value={form.preview_url} editable={isEditing} onChange={(v) => updateForm("preview_url", v)} type="link" />
                                        <InfoField label="Status" value={form.cust_status} editable={isEditing} onChange={(v) => updateForm("cust_status", v)} />
                                    </div>
                                </div>

                                <div className="">
                                    <div className="flex justify-center">
                                        {coverUrl && !coverErr ? (
                                            <img
                                                src={coverUrl}
                                                alt="Cover"
                                                className="w-50 h-auto object-contain rounded "
                                                onError={() => setCoverErr(true)}
                                                loading="lazy"
                                                referrerPolicy="no-referrer"
                                                crossOrigin="anonymous"
                                            />
                                        ) : (
                                            <a
                                                href={coverUrl || "#"}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="inline-block px-2 py-1 border border-gray-300 rounded text-gray-700 hover:bg-gray-100 text-xs self-start"
                                            >
                                                Open cover image
                                            </a>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Order Timeline and Shipping Detail</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <div className="flex flex-col flex-wrap gap-1">
                                            <TimelineItem label="Storybook Created" date={formatIso(order.timeline?.created_at)} />
                                            <TimelineItem label="Order Processed" date={formatIso(order.timeline?.processed_at)} />
                                            <TimelineItem label="Order Approved" date={formatIso(order.timeline?.approved_at)} />
                                            <TimelineItem label="Sent for Printing" date={prettyDate(order.timeline?.print_sent_at)} />
                                            <TimelineItem label="Order Shipped" date={formatIso(order.timeline?.shipped_at)} isLast />
                                        </div>
                                        {isEditing && (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 mt-3">
                                                <InfoField label="created_at" value={form.timeline.created_at} editable onChange={(v) => updateForm("timeline.created_at", v)} />
                                                <InfoField label="processed_at" value={form.timeline.processed_at} editable onChange={(v) => updateForm("timeline.processed_at", v)} />
                                                <InfoField label="approved_at" value={form.timeline.approved_at} editable onChange={(v) => updateForm("timeline.approved_at", v)} />
                                                <InfoField label="print_sent_at" value={form.timeline.print_sent_at} editable onChange={(v) => updateForm("timeline.print_sent_at", v)} />
                                                <InfoField label="shipped_at" value={form.timeline.shipped_at} editable onChange={(v) => updateForm("timeline.shipped_at", v)} />
                                            </div>
                                        )}
                                    </div>
                                    <div>
                                        <div className="flex flex-col gap-2">
                                            <InfoField label="Street" value={form.shipping_address.street} editable={isEditing} onChange={(v) => updateForm("shipping_address.street", v)} />
                                            <InfoField label="City" value={form.shipping_address.city} editable={isEditing} onChange={(v) => updateForm("shipping_address.city", v)} />
                                            <InfoField label="State" value={form.shipping_address.state} editable={isEditing} onChange={(v) => updateForm("shipping_address.state", v)} />
                                            <InfoField label="Country" value={form.shipping_address.country} editable={isEditing} onChange={(v) => updateForm("shipping_address.country", v)} />
                                            <InfoField label="Postal Code" value={form.shipping_address.postal_code} editable={isEditing} onChange={(v) => updateForm("shipping_address.postal_code", v)} />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                                <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Customer Detail</h3>
                                    <div className="space-y-2">
                                        <InfoField label="Name" value={form.user_name} editable={isEditing} onChange={(v) => updateForm("user_name", v)} />
                                        <InfoField label="Email" value={form.email} editable={isEditing} onChange={(v) => updateForm("email", v)} type="email" />
                                        <InfoField label="Phone" value={form.phone} editable={isEditing} onChange={(v) => updateForm("phone", v)} type="tel" />
                                    </div>
                                </div>

                                <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Transaction ID</h3>
                                    <div className="space-y-2">
                                        <InfoField label="Transaction ID" value={form.transaction_id} editable={isEditing} onChange={(v) => updateForm("transaction_id", v)} />
                                        <InfoField label="PayPal Order ID" value={form.paypal_order_id} editable={isEditing} onChange={(v) => updateForm("paypal_order_id", v)} />
                                        <InfoField label="PayPal Capture ID" value={form.paypal_capture_id} editable={isEditing} onChange={(v) => updateForm("paypal_capture_id", v)} />
                                    </div>
                                </div>
                            </div>

                            {saveErr && (
                                <div className="bg-red-50 border border-red-200 rounded p-2">
                                    <p className="text-red-800 text-xs break-words">{saveErr}</p>
                                </div>
                            )}
                        </div>

                        <div className="xl:col-span-1 space-y-3">
                            <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Child Detail</h3>
                                <div className="space-y-2">
                                    <InfoField label="Name" value={form.name} editable={isEditing} onChange={(v) => updateForm("name", v)} />

                                    {/* Show either single age (editable) OR per-child ages (read-only) */}
                                    {order.child?.is_twin ||
                                        order.child?.child1_age !== undefined ||
                                        order.child?.child2_age !== undefined ? (
                                        <>
                                            <InfoField label="Child 1 Age" value={(order.child?.child1_age as any) ?? "-"} />
                                            <InfoField label="Child 2 Age" value={(order.child?.child2_age as any) ?? "-"} />
                                        </>
                                    ) : (
                                        <InfoField label="Age" value={form.age || ""} editable={isEditing} onChange={(v) => updateForm("age", v)} />
                                    )}

                                    <InfoField label="Gender" value={form.gender} editable={isEditing} onChange={(v) => updateForm("gender", v)} type="select" />

                                    {/* Legacy thumbnails (kept for backward compatibility) */}
                                    {(order.child?.saved_file_urls?.length || 0) > 0 ? (
                                        <div className="mt-1">
                                            <ThumbGrid urls={order.child!.saved_file_urls!.slice(0, 3)} />
                                        </div>
                                    ) : (
                                        (order.child?.saved_files?.length || 0) > 0 && (
                                            <div className="mt-1">
                                                <ul className="list-disc ml-4 text-xs text-gray-700">
                                                    {order.child!.saved_files!.slice(0, 3).map((name, i) => (
                                                        <li key={`saved-name-${i}`} className="break-all">{name}</li>
                                                    ))}
                                                </ul>
                                                <p className="text-xs text-gray-500 mt-1">No image URLs yet.</p>
                                            </div>
                                        )
                                    )}

                                    {(order.child?.child1_input_images?.length || order.child?.child2_input_images?.length) ? (
                                        <div className="mt-2 flex flex-col gap-4">
                                            <div>
                                                <div className="text-xs font-semibold text-gray-800 mb-1">Child 1 Inputs</div>
                                                {order.child?.child1_input_images?.length ? (
                                                    <ThumbGrid urls={order.child.child1_input_images} />
                                                ) : (
                                                    <div className="text-xs text-gray-400">No files</div>
                                                )}
                                            </div>
                                            {(order.child?.is_twin || order.child?.child2_input_images?.length) ? (
                                                <div>
                                                    <div className="text-xs font-semibold text-gray-800 mb-1">Child 2 Inputs</div>
                                                    {order.child?.child2_input_images?.length ? (
                                                        <ThumbGrid urls={order.child.child2_input_images} />
                                                    ) : (
                                                        <div className="text-xs text-gray-400">No files</div>
                                                    )}
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Links</h3>
                                <div className="space-y-2">
                                    <InfoField label="Preview URL" value={form.preview_url} editable={isEditing} onChange={(v) => updateForm("preview_url", v)} type="link" />
                                    <InfoField label="Interior PDF" value={form.book_url} editable={isEditing} onChange={(v) => updateForm("book_url", v)} type="link" />
                                    <InfoField label="Cover PDF" value={form.cover_url} editable={isEditing} onChange={(v) => updateForm("cover_url", v)} type="link" />
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </main>
    );
}