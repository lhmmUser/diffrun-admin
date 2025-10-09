"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

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
    child?: ChildDetails;
    customer?: CustomerDetails;
    order?: OrderFinancial;
    timeline?: Timeline;
    cover_image?: string;
};

const TimelineItem = ({ label, date, isLast = false }: { label: string; date: string; isLast?: boolean }) => (<div className="flex items-start"> <div className="flex flex-col items-center mr-3"> <div className="w-2 h-2 rounded-full bg-[#5784ba]"></div> {!isLast && <div className="w-0.5 h-8 bg-gray-300"></div>} </div> <div className="flex-1 pb-2"> <p className="text-xs font-medium text-gray-900">{label}</p> <p className="text-xs text-gray-600">{date}</p> </div> </div>);

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
    const [form, setForm] = useState<any>(null);
    const [saving, setSaving] = useState(false);
    const [saveErr, setSaveErr] = useState<string | null>(null);
    const [coverErr, setCoverErr] = useState(false);

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
                setForm({
                    name: data.name || "",
                    email: data.email || "",
                    phone: data.phone || "",
                    gender: data.gender || "",
                    book_style: data.book_style || "",
                    discount_code: data.discount_code || "",
                    quantity: data.quantity ?? 1,
                    cust_status: data.cust_status || "",
                    shipping_address: {
                        street: data.shipping_address?.street || "",
                        city: data.shipping_address?.city || "",
                        state: data.shipping_address?.state || "",
                        country: data.shipping_address?.country || "",
                        postal_code: data.shipping_address?.zip || "",
                    },
                });
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
        const base = {
            name: order.name || "",
            email: order.email || "",
            phone: order.phone || "",
            gender: order.gender || "",
            book_style: order.book_style || "",
            discount_code: order.discount_code || "",
            quantity: order.quantity ?? 1,
            cust_status: order.cust_status || "",
            shipping_address: {
                street: order.shipping_address?.street || "",
                city: order.shipping_address?.city || "",
                state: order.shipping_address?.state || "",
                country: order.shipping_address?.country || "",
                postal_code: order.shipping_address?.zip || "",
            },
        };
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
        return out;
    };

    const save = async () => {
        if (!rawOrderId || !form) return;
        setSaving(true);
        setSaveErr(null);
        try {
            const payload = buildPayload();
            const res = await fetch(
                `${API_BASE}/orders/${encodeURIComponent(rawOrderId)}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                }
            );
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            const data = await res.json();
            const updated: OrderDetail = (data.order ?? data) as OrderDetail;
            setOrder(updated);
            setForm({
                name: updated.name || "",
                email: updated.email || "",
                phone: updated.phone || "",
                gender: updated.gender || "",
                book_style: updated.book_style || "",
                discount_code: updated.discount_code || "",
                quantity: updated.quantity ?? 1,
                cust_status: updated.cust_status || "",
                shipping_address: {
                    street: updated.shipping_address?.street || "",
                    city: updated.shipping_address?.city || "",
                    state: updated.shipping_address?.state || "",
                    country: updated.shipping_address?.country || "",
                    postal_code: updated.shipping_address?.zip || "",
                },
            });
            setIsEditing(false);
            alert("✅ Changes saved successfully");
        } catch (e: any) {
            setSaveErr(e?.message || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const cancelEdit = () => {
        if (order) {
            setForm({
                name: order.name || "",
                email: order.email || "",
                phone: order.phone || "",
                gender: order.gender || "",
                book_style: order.book_style || "",
                discount_code: order.discount_code || "",
                quantity: order.quantity ?? 1,
                cust_status: order.cust_status || "",
                shipping_address: {
                    street: order.shipping_address?.street || "",
                    city: order.shipping_address?.city || "",
                    state: order.shipping_address?.state || "",
                    country: order.shipping_address?.country || "",
                    postal_code: order.shipping_address?.zip || "",
                },
            });
        }
        setIsEditing(false);
        setSaveErr(null);
    };

    const formatIso = (iso?: string | null) => {
        if (!iso) return "-";
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return iso;
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
            return iso;
        }
    };

    const coverUrl = order?.cover_image || order?.order?.cover_image || "";

    const InfoField = ({
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
    }) => (
        <div className={`flex items-center justify-between gap-2 ${className}`}>
            <span className="text-xs font-bold text-gray-700 shrink-0">{label}:</span>
            {editable ? (
                type === "select" ? (
                    <select
                        className="border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-[#5784ba] text-xs w-full max-w-32"
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
                        className="border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-[#5784ba] text-xs w-full max-w-32"
                        value={value}
                        onChange={(e) => {
                            const num = Number.isFinite(+e.target.value)
                                ? parseInt(e.target.value || "1", 10)
                                : 1;
                            onChange?.(Math.max(1, num));
                        }}
                    />
                ) : (
                    <input
                        type={type}
                        className="border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-[#5784ba] text-xs w-full max-w-32"
                        value={value}
                        onChange={(e) => onChange?.(e.target.value)}
                    />
                )
            ) : (
                <p className="text-xs text-gray-900 py-0.5 break-words whitespace-normal w-full text-right md:text-left max-w-32">
                    {value || "-"}
                </p>
            )}
        </div>
    );

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

                {order && !loading && !loadErr && (
                    <div className="space-y-3">
                        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
                            <div className="lg:col-span-3 space-y-3">
                                <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">
                                        Order Information
                                    </h3>

                                    <div className="flex flex-col md:flex-row justify-between gap-3">
                                        {/* Order details - tighter layout */}
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 flex-1">
                                            <InfoField label="Order ID" value={order.order_id} />
                                            <InfoField label="Book ID" value={order.book_id || "-"} />
                                            <InfoField
                                                label="Quantity"
                                                value={form?.quantity || 1}
                                                editable={isEditing}
                                                onChange={(value) => updateForm("quantity", value)}
                                                type="number"
                                            />
                                            <InfoField
                                                label="Book Style"
                                                value={form?.book_style || ""}
                                                editable={isEditing}
                                                onChange={(value) => updateForm("book_style", value)}
                                            />
                                            <InfoField label="Total Price" value={order.order?.total_price || "-"} />
                                            <InfoField
                                                label="Discount Code"
                                                value={form?.discount_code || ""}
                                                editable={isEditing}
                                                onChange={(value) => updateForm("discount_code", value)}
                                            />
                                        </div>

                                        <div className="flex justify-center md:justify-end mt-2 md:mt-0">
                                            {coverUrl && !coverErr ? (
                                                <img
                                                    src={coverUrl}
                                                    alt="Cover"
                                                    className="w-32 h-auto object-contain rounded border border-gray-200"
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
                                    <div className="flex flex-col md:flex-row justify-evenly gap-4">
                                        <div className="flex-1">
                                            <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">
                                                Order Timeline
                                            </h3>
                                            <div className="flex flex-col flex-wrap gap-1">
                                                <TimelineItem label="Storybook Created" date={formatIso(order.timeline?.created_at)} />
                                                <TimelineItem label="Order Processed" date={formatIso(order.timeline?.processed_at)} />
                                                <TimelineItem label="Order Approved" date={formatIso(order.timeline?.approved_at)} />
                                                <TimelineItem label="Sent for Printing" date={formatIso(order.timeline?.print_sent_at)} />
                                                <TimelineItem label="Order Shipped" date={formatIso(order.timeline?.shipped_at)} isLast={true} />
                                            </div>
                                        </div>

                                        <div className="flex-1">
                                            <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">
                                                Shipping Address
                                            </h3>
                                            <div className="flex flex-col gap-2">
                                                <InfoField
                                                    label="Street"
                                                    value={form?.shipping_address?.street || ""}
                                                    editable={isEditing}
                                                    onChange={(value) => updateForm("shipping_address.street", value)}
                                                />
                                                <InfoField
                                                    label="City"
                                                    value={form?.shipping_address?.city || ""}
                                                    editable={isEditing}
                                                    onChange={(value) => updateForm("shipping_address.city", value)}
                                                />
                                                <InfoField
                                                    label="State"
                                                    value={form?.shipping_address?.state || ""}
                                                    editable={isEditing}
                                                    onChange={(value) => updateForm("shipping_address.state", value)}
                                                />
                                                <InfoField
                                                    label="Country"
                                                    value={form?.shipping_address?.country || ""}
                                                    editable={isEditing}
                                                    onChange={(value) => updateForm("shipping_address.country", value)}
                                                />
                                                <InfoField
                                                    label="Postal Code"
                                                    value={form?.shipping_address?.postal_code || ""}
                                                    editable={isEditing}
                                                    onChange={(value) => updateForm("shipping_address.postal_code", value)}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Child Details</h3>
                                    <div className="space-y-2">
                                        <InfoField label="Name" value={order.child?.name || "-"} />
                                        <InfoField label="Age" value={order.child?.age || "-"} />
                                        <InfoField label="Gender" value={order.child?.gender || "-"} />
                                        {(order.child?.saved_file_urls?.length || 0) > 0 ? (
                                            <div className="mt-1">
                                                <div className="grid grid-cols-3 gap-1">
                                                    {order.child!.saved_file_urls!.slice(0, 3).map((url, i) => (
                                                        <a
                                                            key={`saved-url-${i}`}
                                                            href={url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="block"
                                                            title={url}
                                                        >
                                                            <img
                                                                src={url}
                                                                alt={`child_saved_${i + 1}`}
                                                                className="w-auto h-16 object-contain rounded border border-gray-200 hover:border-[#5784ba]"
                                                            />
                                                        </a>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : (
                                            (order.child?.saved_files?.length || 0) > 0 && (
                                                <div className="mt-1">
                                                    <ul className="list-disc ml-4 text-xs text-gray-700">
                                                        {order.child!.saved_files!.slice(0, 3).map((name, i) => (
                                                            <li key={`saved-name-${i}`} className="break-all">{name}</li>
                                                        ))}
                                                    </ul>
                                                    <p className="text-xs text-gray-500 mt-1">
                                                        No image URLs yet. Ensure backend returns <code>saved_file_urls</code>.
                                                    </p>
                                                </div>
                                            )
                                        )}
                                    </div>
                                </div>

                                <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Links</h3>
                                    <div className="space-y-2">
                                        {order.preview_url && (
                                            <a
                                                href={order.preview_url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="block text-[#5784ba] hover:text-[#4a76a8] hover:underline font-medium text-xs break-words transition-colors duration-200"
                                            >
                                                Preview URL
                                            </a>
                                        )}
                                        {order.order?.book_url && (
                                            <a
                                                href={order.order.book_url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="block text-[#5784ba] hover:text-[#4a76a8] hover:underline font-medium text-xs break-words transition-colors duration-200"
                                            >
                                                Interior PDF
                                            </a>
                                        )}
                                        {order.order?.cover_url && (
                                            <a
                                                href={order.order.cover_url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="block text-[#5784ba] hover:text-[#4a76a8] hover:underline font-medium text-xs break-words transition-colors duration-200"
                                            >
                                                Coverpage PDF
                                            </a>
                                        )}
                                    </div>
                                </div>

                                <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Customer Details</h3>
                                    <div className="space-y-2">
                                        <InfoField
                                            label="Name"
                                            value={order.customer?.user_name || ""}
                                            editable={isEditing}
                                            onChange={(value) => updateForm("user_name", value)}
                                        />
                                        <InfoField
                                            label="Email"
                                            value={form?.email || ""}
                                            editable={isEditing}
                                            onChange={(value) => updateForm("email", value)}
                                            type="email"
                                        />
                                        <InfoField
                                            label="Phone"
                                            value={form?.phone || ""}
                                            editable={isEditing}
                                            onChange={(value) => updateForm("phone", value)}
                                            type="tel"
                                        />
                                        <InfoField label="City" value={form?.shipping_address?.city || ""} />
                                    </div>
                                </div>

                                <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
                                    <h3 className="text-base font-semibold text-gray-900 mb-3 pb-1 border-b border-gray-100">Payment Information</h3>
                                    <dl className="space-y-2 text-xs">
                                        {order.order?.transaction_id ? (
                                            <div className="grid grid-cols-[auto,1fr] items-start gap-x-2">
                                                <dt className="text-gray-600 font-medium whitespace-nowrap">Transaction ID:</dt>
                                                <dd className="text-gray-900 break-all">{order.order.transaction_id}</dd>
                                            </div>
                                        ) : (
                                            <>
                                                <div className="grid grid-cols-[auto,1fr] items-start gap-x-2">
                                                    <dt className="text-gray-600 font-medium whitespace-nowrap">PayPal Order ID:</dt>
                                                    <dd className="text-gray-900 break-all">{order.order?.paypal_order_id || "-"}</dd>
                                                </div>
                                                <div className="grid grid-cols-[auto,1fr] items-start gap-x-2">
                                                    <dt className="text-gray-600 font-medium whitespace-nowrap">PayPal Capture ID:</dt>
                                                    <dd className="text-gray-900 break-all">{order.order?.paypal_capture_id || "-"}</dd>
                                                </div>
                                            </>
                                        )}
                                    </dl>
                                </div>
                            </div>
                        </div>

                        {isEditing && (
                            <div className="flex justify-end gap-2">
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
                            </div>
                        )}

                        {saveErr && (
                            <div className="bg-red-50 border border-red-200 rounded p-2">
                                <p className="text-red-800 text-xs break-words">{saveErr}</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </main>
    );
}