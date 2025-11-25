"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PrintProgress from "./PrintProgress";
import { useRouter, useSearchParams } from "next/navigation";

type OrdersViewProps = {
  defaultDiscountCode?: string;
  hideDiscountFilter?: boolean;
  title?: string;
  excludeTestDiscount?: boolean;
};

type RawOrder = {
  order_id: string;
  job_id: string;
  coverPdf: string;
  interiorPdf: string;
  previewUrl: string;
  name: string;
  city: string;
  price: number;
  paymentDate: string;
  approvalDate: string;
  status: string;
  bookId: string;
  bookStyle: string;
  printStatus: string;
  approved_at?: { $date?: { $numberLong?: string } } | string | null;
  feedback_email: boolean;
  print_approval?: boolean;
  discount_code?: string;
  currency?: string;
  locale?: string;
  shippedAt?: string;
  quantity?: number;
  printer?: string;
  shippingStatus?: string;
};

type Order = {
  orderId: string;
  jobId: string;
  coverPdf: string;
  interiorPdf: string;
  previewUrl: string;
  name: string;
  city: string;
  price: number;
  paymentDate: string;
  approvalDate: string;
  status: string;
  bookId: string;
  bookStyle: string;
  printStatus: string;
  feedback_email: boolean;
  printApproval: boolean | "not found";
  discountCode: string;
  currency: string;
  locale: string;
  shippedAt: string;
  shippingStatus: string; // <-- NEW
  quantity: number;
  printer: string;
};

type PrinterResponse = {
  order_id: string;
  status: "success" | "error" | "processing";
  message: string;
  step?: string;
  cloudprinter_reference?: string;
};

export default function OrdersView({
  defaultDiscountCode = "all",
  hideDiscountFilter = false,
  title = "Orders",
  excludeTestDiscount,
}: OrdersViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterBookStyle, setFilterBookStyle] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("processed_at");
  const [sortDir, setSortDir] = useState<string>("desc");
  const [printResults, setPrintResults] = useState<PrinterResponse[]>([]);
  const [showProgress, setShowProgress] = useState(false);
  const [sentFeedbackOrders, setSentFeedbackOrders] = useState<Set<string>>(
    new Set()
  );
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";
  const [currentPage, setCurrentPage] = useState(1);
  const [ordersPerPage, setOrdersPerPage] = useState(12);
  const [filterPrintApproval, setFilterPrintApproval] = useState("all");
  const [filterDiscountCode, setFilterDiscountCode] =
    useState<string>(defaultDiscountCode);
  const [detailOrder, setDetailOrder] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState<string>(searchParams.get("q") || "");
  const [typing, setTyping] = useState<NodeJS.Timeout | null>(null);
  const [shippingFetched, setShippingFetched] = useState<Set<string>>(
    new Set()
  );
  const [totalOrders, setTotalOrders] = useState(0);
  const totalPages = Math.ceil(totalOrders / ordersPerPage);
  const orderIdInUrl = searchParams.get("order_id") || null;
  const currentOrders = orders;

  const openOrder = (orderId: string) => {
    router.push(
      `/orders/order-detail?order_id=${encodeURIComponent(orderId)}`,
      {
        scroll: false,
      }
    );
  };

  const setUrlParam = (key: string, value: string | null) => {
    const sp = new URLSearchParams(window.location.search);
    if (value && value.trim() !== "") sp.set(key, value);
    else sp.delete(key);
    router.push(`?${sp.toString()}`, { scroll: false });
  };

  const closeOrder = () => {
    const sp = new URLSearchParams(window.location.search);
    sp.delete("order_id");
    router.push(`?${sp.toString()}`, { scroll: false });
  };

  useEffect(() => {
    const calculateOrdersPerPage = () => {
      const windowHeight = window.innerHeight;

      // Estimate height taken up by non-table elements
      const headerHeight = 200; // header + filters + buttons area
      const footerHeight = 80; // pagination
      const rowHeight = 43; // approx height of one row

      const usableHeight = windowHeight - headerHeight;
      const visibleRows = Math.floor(usableHeight / rowHeight);

      // Set minimum of 4 rows, max cap if needed
      setOrdersPerPage(Math.max(4, visibleRows));
    };

    calculateOrdersPerPage();
    window.addEventListener("resize", calculateOrdersPerPage);
    return () => window.removeEventListener("resize", calculateOrdersPerPage);
  }, []);

  useEffect(() => {
    if (detailOrder) {
      // initialize editable fields only
      setForm({
        name: detailOrder.name || "",
        email: detailOrder.email || "",
        phone: detailOrder.phone || "",
        gender: detailOrder.gender || "",
        book_style: detailOrder.book_style || "",
        discount_code: detailOrder.discount_code || "",
        quantity: detailOrder.quantity ?? 1,
        cust_status: detailOrder.cust_status || "",
        shipping_address: {
          street: detailOrder.shipping_address?.street || "",
          city: detailOrder.shipping_address?.city || "",
          state: detailOrder.shipping_address?.state || "",
          country: detailOrder.shipping_address?.country || "",
          postal_code: detailOrder.shipping_address?.zip || "",
        },
      });
      setDirty(false);
      setSaveError(null);
    }
  }, [detailOrder]);

  const updateForm = (path: string, value: any) => {
    setForm((prev: any) => {
      const next = structuredClone(prev);
      const parts = path.split(".");
      let ref = next;
      for (let i = 0; i < parts.length - 1; i++) ref = ref[parts[i]];
      ref[parts[parts.length - 1]] = value;
      return next;
    });
    setDirty(true);
  };

  const buildPayload = () => {
    const p: any = {};
    const compare = (curr: any, base: any, keyPrefix = "") => {
      for (const k of Object.keys(curr)) {
        const currV = curr[k];
        const baseV = base?.[k];
        const path = keyPrefix ? `${keyPrefix}.${k}` : k;
        if (currV && typeof currV === "object" && !Array.isArray(currV)) {
          compare(currV, baseV || {}, path);
        } else if (currV !== baseV) {
          // map shipping_address.postal_code back to backend name "postal_code"
          const setPath = path === "shipping_address.postal_code" ? path : path;
          // build nested JSON instead of dot paths
          const parts = setPath.split(".");
          let ref = p;
          for (let i = 0; i < parts.length - 1; i++) {
            ref[parts[i]] = ref[parts[i]] || {};
            ref = ref[parts[i]];
          }
          ref[parts[parts.length - 1]] = currV;
        }
      }
    };
    compare(form, {
      name: detailOrder.name || "",
      email: detailOrder.email || "",
      phone: detailOrder.phone || "",
      gender: detailOrder.gender || "",
      book_style: detailOrder.book_style || "",
      discount_code: detailOrder.discount_code || "",
      quantity: detailOrder.quantity ?? 1,
      cust_status: detailOrder.cust_status || "",
      shipping_address: {
        street: detailOrder.shipping_address?.street || "",
        city: detailOrder.shipping_address?.city || "",
        state: detailOrder.shipping_address?.state || "",
        country: detailOrder.shipping_address?.country || "",
        postal_code: detailOrder.shipping_address?.zip || "",
      },
    });
    return p;
  };

  const saveOrder = async () => {
    if (!orderIdInUrl || !form) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = buildPayload();
      if (Object.keys(payload).length === 0) {
        setSaving(false);
        setDirty(false);
        return;
      }
      const res = await fetch(
        `${baseUrl}/orders/${encodeURIComponent(orderIdInUrl)}`,
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
      setDetailOrder(data.order); // refresh drawer
      await fetchOrders(); // refresh table list
      setDirty(false);
      alert("✅ Saved");
    } catch (e: any) {
      setSaveError(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const hasApprovedOrders = () => {
    return Array.from(selectedOrders).some((orderId) => {
      const order = orders.find((o) => o.orderId === orderId);
      return order?.status === "Approved";
    });
  };

  const hasNonApprovedOrders = () => {
    return Array.from(selectedOrders).some((orderId) => {
      const order = orders.find((o) => o.orderId === orderId);
      return order?.status !== "Approved";
    });
  };

  const hasNonIndiaSelectedOrders = () => {
    return Array.from(selectedOrders).some((orderId) => {
      const order = orders.find((o) => o.orderId === orderId);
      return order && order.locale !== "IN";
    });
  };

  const fetchOrders = async () => {
    try {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.append("filter_status", filterStatus);
      if (filterBookStyle !== "all")
        params.append("filter_book_style", filterBookStyle);
      if (filterPrintApproval !== "all")
        params.append("filter_print_approval", filterPrintApproval);
      if (filterDiscountCode !== "all")
        params.append("filter_discount_code", filterDiscountCode);
      if (excludeTestDiscount) {
        params.append("exclude_discount_code", "TEST");
        params.append("exclude_discount_code", "REJECTED");
      }
      params.append("page", currentPage.toString());
      params.append("limit", ordersPerPage.toString());
      params.append("sort_by", sortBy);
      params.append("sort_dir", sortDir);
      if (search && search.trim() !== "") params.append("q", search.trim());

      const res = await fetch(`${baseUrl}/orders?${params.toString()}`);
      if (!res.ok) {
        console.error(
          "[fetchOrders] /orders returned",
          res.status,
          res.statusText
        );
        return;
      }

      const data = await res.json();
      console.log("Raw API response:", data);
      const rawData: RawOrder[] = data.orders;
      console.log("Raw data:", rawData[0]);

      const transformed: Order[] = rawData.map((order) => ({
        orderId: order.order_id || "N/A",
        jobId: order.job_id || "N/A",
        coverPdf: order.coverPdf || "",
        interiorPdf: order.interiorPdf || "",
        previewUrl: order.previewUrl || "",
        name: order.name || "",
        city: order.city || "",
        price: order.price || 0,
        paymentDate: order.paymentDate || "",
        approvalDate: order.approvalDate || "",
        status: order.status || "",
        bookId: order.bookId || "",
        bookStyle: order.bookStyle || "",
        feedback_email: order.feedback_email === true,
        printApproval:
          typeof order.print_approval === "boolean"
            ? order.print_approval
            : "not found",
        discountCode: order.discount_code || "",
        currency: order.currency || "INR",
        locale: order.locale || "",
        shippedAt: order.shippedAt || "",
        shippingStatus: (order.shippingStatus as string) || "",
        quantity: order.quantity || 1,
        printStatus: (order.printStatus ?? "") as string,
        printer: (order.printer ?? "") as string,
      }));

      setOrders(transformed);
      setTotalOrders(data.pagination.total);
    } catch (e) {
      console.error("❌ Failed to fetch orders:", e);
    }
  };

  useEffect(() => {
    if (!baseUrl) return;
    if (!orders.length) return;

    const targets = orders.filter(
      (o) =>
        (o.printer || "").toLowerCase() === "genesis" &&
        !o.shippedAt &&
        !shippingFetched.has(o.orderId)
    );

    if (!targets.length) return;

    const run = async () => {
      const fetchPromises = targets.map(async (order) => {
        try {
          const shipRes = await fetch(
            `${baseUrl}/shipping/${encodeURIComponent(order.orderId)}`
          );

          if (!shipRes.ok) {
            console.warn(
              `[SHIPPING] /shipping/${order.orderId} ->`,
              shipRes.status,
              shipRes.statusText
            );
            return {
              orderId: order.orderId,
              shippedAt: null,
              shippingStatus: null,
            };
          }

          const shipDoc = await shipRes.json();

          const shippedAtCandidate =
            shipDoc?.shiprocket_raw?.shipments?.shipped_date ||
            shipDoc?.shiprocket_raw?.shipments?.delivered_date ||
            shipDoc?.shiprocket_data?.shipments?.shipped_date ||
            shipDoc?.shipments?.shipped_date ||
            shipDoc?.shipped_date ||
            shipDoc?.shipped_at ||
            null;

          const lastScanLabel =
            Array.isArray(shipDoc?.shiprocket_data?.scans) &&
            shipDoc.shiprocket_data.scans.length
              ? shipDoc.shiprocket_data.scans.at(-1)["sr-status-label"] ||
                shipDoc.shiprocket_data.scans.at(-1)["sr-status_label"] ||
                shipDoc.shiprocket_data.scans.at(-1)["activity"] ||
                null
              : null;

          const lastRawScanLabel =
            Array.isArray(shipDoc?.shiprocket_data?.raw?.scans) &&
            shipDoc.shiprocket_data.raw.scans.length
              ? shipDoc.shiprocket_data.raw.scans.at(-1)["sr-status-label"] ||
                shipDoc.shiprocket_data.raw.scans.at(-1)["sr-status_label"] ||
                shipDoc.shiprocket_data.raw.scans.at(-1)["activity"] ||
                null
              : null;

          const statusFallback =
            shipDoc?.shiprocket_data?.current_status ||
            shipDoc?.shiprocket_data?.shipment_status ||
            shipDoc?.shiprocket_raw?.status ||
            shipDoc?.delivery_status ||
            null;

          const shippingStatusCandidate =
            lastScanLabel || lastRawScanLabel || statusFallback || null;

          return {
            orderId: order.orderId,
            shippedAt: shippedAtCandidate,
            shippingStatus: shippingStatusCandidate,
          };
        } catch (e) {
          console.error(
            `[SHIPPING] Failed to fetch shipping for ${order.orderId}`,
            e
          );
          return {
            orderId: order.orderId,
            shippedAt: null,
            shippingStatus: null,
          };
        }
      });

      const settled = await Promise.allSettled(fetchPromises);

      setOrders((prev) => {
        const byId = new Map(prev.map((p) => [p.orderId, p]));
        for (const s of settled) {
          if (s.status === "fulfilled" && s.value) {
            const { orderId, shippedAt, shippingStatus } = s.value;
            const old = byId.get(orderId);
            if (!old) continue;
            const updated = { ...old };
            if (shippedAt) updated.shippedAt = shippedAt;
            if (shippingStatus) updated.shippingStatus = shippingStatus;
            byId.set(orderId, updated);
          }
        }
        return Array.from(byId.values());
      });

      setShippingFetched((prev) => {
        const next = new Set(prev);
        targets.forEach((o) => next.add(o.orderId));
        return next;
      });
    };

    run();
  }, [orders, baseUrl, shippingFetched]);

  useEffect(() => {
    fetchOrders();
  }, [
    filterStatus,
    filterPrintApproval,
    filterDiscountCode,
    filterBookStyle,
    sortBy,
    sortDir,
    search,
    currentPage,
    ordersPerPage,
  ]);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    filterStatus,
    filterPrintApproval,
    filterDiscountCode,
    filterBookStyle,
    search,
    sortBy,
    sortDir,
  ]);

  useEffect(() => {
    if (!orderIdInUrl) {
      setDetailOrder(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    (async () => {
      try {
        setDetailLoading(true);
        setDetailError(null);
        setDetailOrder(null);

        const res = await fetch(
          `${baseUrl}/orders/${encodeURIComponent(orderIdInUrl)}`
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setDetailOrder(data);
      } catch (e: any) {
        setDetailError(e?.message || "Failed to load order details");
      } finally {
        setDetailLoading(false);
      }
    })();
  }, [orderIdInUrl, baseUrl]);

  const handleSelectOrder = (orderId: string) => {
    const newSelected = new Set(selectedOrders);
    if (newSelected.has(orderId)) {
      newSelected.delete(orderId);
    } else {
      newSelected.add(orderId);
    }
    setSelectedOrders(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedOrders.size === orders.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(orders.map((order) => order.orderId)));
    }
  };

  const handleAction = async (action: string) => {
    if (action === "approve") {
      try {
        setShowProgress(true);
        setPrintResults([]);

        const selectedOrderIds = Array.from(selectedOrders);
        console.log("[APPROVE] selectedOrderIds:", selectedOrderIds);
        setPrintResults(
          selectedOrderIds.map((orderId) => ({
            order_id: orderId,
            status: "processing",
            message: "Waiting to be processed...",
            step: "queued",
          }))
        );

        const response = await fetch(`${baseUrl}/orders/approve-printing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(selectedOrderIds),
        });

        console.log(
          "[APPROVE] approve-printing status:",
          response.status,
          response.statusText
        );

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const results: PrinterResponse[] = await response.json();
        console.log("[APPROVE] approve-printing results:", results);
        setPrintResults(results);

        const successfulOrders = results.filter((r) => r.status === "success");
        const failedOrders = results.filter((r) => r.status === "error");

        if (successfulOrders.length > 0) {
          alert(
            `Successfully sent ${successfulOrders.length} orders to printer`
          );
        }
        if (failedOrders.length > 0) {
          alert(
            `Failed to send ${failedOrders.length} orders to printer. Check console for details.`
          );
          console.error("[APPROVE] Failed orders:", failedOrders);
        }

        setSelectedOrders(new Set());

        const params = new URLSearchParams();
        if (filterStatus !== "all")
          params.append("filter_status", filterStatus);
        if (filterBookStyle !== "all")
          params.append("filter_book_style", filterBookStyle);
        params.append("sort_by", sortBy);
        params.append("sort_dir", sortDir);

        console.log(
          "[APPROVE] Refetching orders with params:",
          params.toString()
        );
        const ordersRes = await fetch(`${baseUrl}/orders?${params.toString()}`);
        console.log(
          "[APPROVE] orders GET status:",
          ordersRes.status,
          ordersRes.statusText
        );
        const data = await ordersRes.json();
        const rawData: RawOrder[] = data.orders;

        const transformed: Order[] = rawData.map((order: RawOrder): Order => {
          return {
            orderId: order.order_id || "N/A",
            jobId: order.job_id || "N/A",
            coverPdf: order.coverPdf || "",
            interiorPdf: order.interiorPdf || "",
            previewUrl: order.previewUrl || "",
            name: order.name || "",
            city: order.city || "",
            price: order.price || 0,
            paymentDate: order.paymentDate || "",
            approvalDate: order.approvalDate || "",
            status: order.status || "",
            bookId: order.bookId || "",
            bookStyle: order.bookStyle || "",
            printStatus: order.printStatus || "",
            feedback_email: false,
            printApproval: (() => {
              if (typeof order.print_approval === "boolean")
                return order.print_approval;
              console.warn(
                `⚠️ [APPROVE] print_approval missing or invalid for order:`,
                order
              );
              return "not found";
            })(),
            discountCode: order.discount_code || "",
            currency: order.currency || "INR",
            locale: order.locale || "",
            shippedAt: order.shippedAt || "",
            shippingStatus: (order.shippingStatus as string) || "",
            quantity: order.quantity || 1,
            printer: (order.printer ?? "") as string,
          };
        });

        setOrders(transformed);
        setTotalOrders(data.pagination.total);
      } catch (error) {
        console.error("[APPROVE] Error sending orders to printer:", error);
        setPrintResults([
          {
            order_id: "system",
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to send orders to printer",
            step: "api_request",
          },
        ]);
      }
    } else if (action === "send_to_genesis") {
      try {
        setShowProgress(true);
        setPrintResults([]);

        const selectedOrderIds = Array.from(selectedOrders);
        console.log("[GENESIS] selectedOrderIds:", selectedOrderIds);
        if (selectedOrderIds.length === 0) {
          console.warn("[GENESIS] No selected orders; aborting.");
          setShowProgress(false);
          return;
        }

        setPrintResults(
          selectedOrderIds.map((orderId) => ({
            order_id: orderId,
            status: "processing",
            message: "Queued for Genesis Google Sheets...",
            step: "queued",
          }))
        );

        const trySend = async (): Promise<Response> => {
          const url = `${baseUrl}/orders/send-to-google-sheet`;
          console.log("[GENESIS] POST", url, "body:", selectedOrderIds);

          let res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(selectedOrderIds),
          });

          console.log(
            "[GENESIS] First attempt status:",
            res.status,
            res.statusText
          );

          if (res.status === 422) {
            console.warn(
              "[GENESIS] 422 for array body — retrying with wrapped object"
            );
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ order_ids: selectedOrderIds }),
            });
            console.log(
              "[GENESIS] Second attempt status:",
              res.status,
              res.statusText
            );
          }

          return res;
        };

        const response = await trySend();

        if (!response.ok) {
          let errorText = `${response.status} ${response.statusText}`;
          try {
            const errJson = await response.json();
            errorText = errJson.detail || JSON.stringify(errJson);
          } catch {}
          throw new Error(`Failed to send to Genesis: ${errorText}`);
        }

        let results: any;
        try {
          results = await response.json();
        } catch {
          results = null;
        }
        console.log("[GENESIS] Response OK (200). Parsed results:", results);
        if (results) setPrintResults(results);

        try {
          const shiprocketOrderIds = selectedOrderIds;
          console.log(
            "[SHIPROCKET] Triggering with order_ids:",
            shiprocketOrderIds
          );

          const srPayload = {
            order_ids: shiprocketOrderIds,
            request_pickup: true,
          };
          console.log("[SHIPROCKET] POST payload:", srPayload);

          const srRes = await fetch(
            `${baseUrl}/shiprocket/create-from-orders`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(srPayload),
            }
          );

          console.log(
            "[SHIPROCKET] create-from-orders status:",
            srRes.status,
            srRes.statusText
          );

          if (!srRes.ok) {
            let srErrMsg = `${srRes.status} ${srRes.statusText}`;
            try {
              const err = await srRes.json();
              console.log("[SHIPROCKET] Error body:", err);
              srErrMsg = err.detail || JSON.stringify(err);
            } catch {
              // keep default message
            }
            throw new Error(srErrMsg);
          }

          const srJson = await srRes.json();
          console.log("[SHIPROCKET] Success body:", srJson);

          const created = Array.isArray(srJson.created)
            ? srJson.created.length
            : 0;
          const awbs = Array.isArray(srJson.awbs) ? srJson.awbs.length : 0;
          const errCount = Array.isArray(srJson.errors)
            ? srJson.errors.length
            : 0;
          const pickup = srJson.pickup ? "requested" : "skipped";

          alert(
            `Shiprocket → created: ${created}, AWBs: ${awbs}, pickup: ${pickup}${
              errCount ? `, errors: ${errCount}` : ""
            }`
          );
        } catch (e) {
          console.error("[SHIPROCKET] create-from-orders failed:", e);
          alert(
            `❌ Shiprocket create failed: ${
              e instanceof Error ? e.message : "Unknown error"
            }`
          );
        }

        try {
          if (Array.isArray(results)) {
            const successfulOrders = results.filter(
              (r: any) => r.status !== "error"
            );
            const failedOrders = results.filter(
              (r: any) => r.status === "error"
            );
            if (successfulOrders.length > 0) {
              alert(
                `Successfully queued ${successfulOrders.length} orders to Genesis`
              );
            }
            if (failedOrders.length > 0) {
              alert(
                `Failed to queue ${failedOrders.length} orders to Genesis. Check console for details.`
              );
              console.error("[GENESIS] Failed orders:", failedOrders);
            }
          } else {
            console.log(
              "[GENESIS] Non-array response; skipping success/error breakdown."
            );
          }
        } catch (e) {
          console.warn("[GENESIS] Summary parsing failed:", e);
        }

        setSelectedOrders(new Set());

        const params = new URLSearchParams();
        if (filterStatus !== "all")
          params.append("filter_status", filterStatus);
        if (filterBookStyle !== "all")
          params.append("filter_book_style", filterBookStyle);
        params.append("sort_by", sortBy);
        params.append("sort_dir", sortDir);

        console.log(
          "[GENESIS] Refetching orders with params:",
          params.toString()
        );
        const ordersRes = await fetch(`${baseUrl}/orders?${params.toString()}`);
        console.log(
          "[GENESIS] orders GET status:",
          ordersRes.status,
          ordersRes.statusText
        );

        const data = await ordersRes.json();
        const rawData: RawOrder[] = data.orders || [];

        const transformed: Order[] = rawData.map((order: RawOrder): Order => {
          return {
            orderId: order.order_id || "N/A",
            jobId: order.job_id || "N/A",
            coverPdf: order.coverPdf || "",
            interiorPdf: order.interiorPdf || "",
            previewUrl: order.previewUrl || "",
            name: order.name || "",
            city: order.city || "",
            price: order.price || 0,
            paymentDate: order.paymentDate || "",
            approvalDate: order.approvalDate || "",
            status: order.status || "",
            bookId: order.bookId || "",
            bookStyle: order.bookStyle || "",
            printStatus: order.printStatus || "",
            feedback_email: false,
            printApproval: (() => {
              if (typeof order.print_approval === "boolean")
                return order.print_approval;
              console.warn(
                `⚠️ [GENESIS] print_approval missing or invalid for order:`,
                order
              );
              return "not found";
            })(),
            discountCode: order.discount_code || "",
            currency: order.currency || "INR",
            locale: order.locale || "",
            shippedAt: order.shippedAt || "",
            shippingStatus: (order.shippingStatus as string) || "",
            quantity: order.quantity || 1,
            printer: (order.printer ?? "") as string,
          };
        });

        setOrders(transformed);

        // Hide progress after short delay
        setTimeout(() => setShowProgress(false), 5000);
      } catch (error) {
        console.error("[GENESIS] Error sending orders to Genesis:", error);
        setPrintResults([
          {
            order_id: "system",
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to send orders to Genesis",
            step: "api_request",
          },
        ]);
        // keep progress visible so user can read error; hide after 8s
        setTimeout(() => setShowProgress(false), 8000);
      }
    } else if (action === "send_to_yara") {
      try {
        setShowProgress(true);
        setPrintResults([]);

        const selectedOrderIds = Array.from(selectedOrders);
        console.log("[YARA] selectedOrderIds:", selectedOrderIds);
        if (selectedOrderIds.length === 0) {
          console.warn("[YARA] No selected orders; aborting.");
          setShowProgress(false);
          return;
        }

        setPrintResults(
          selectedOrderIds.map((orderId) => ({
            order_id: orderId,
            status: "processing",
            message: "Queued for Yara Google Sheets...",
            step: "queued",
          }))
        );

        // Try POST with JSON array first, fallback to wrapped object on 422
        const trySend = async (): Promise<Response> => {
          const url = `${baseUrl}/orders/send-to-yara`;
          console.log("[YARA] POST", url, "body:", selectedOrderIds);

          let res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(selectedOrderIds),
          });

          console.log(
            "[YARA] First attempt status:",
            res.status,
            res.statusText
          );

          if (res.status === 422) {
            console.warn(
              "[YARA] 422 for array body — retrying with wrapped object"
            );
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ order_ids: selectedOrderIds }),
            });
            console.log(
              "[YARA] Second attempt status:",
              res.status,
              res.statusText
            );
          }

          return res;
        };

        const response = await trySend();

        if (!response.ok) {
          let errorText = `${response.status} ${response.statusText}`;
          try {
            const errJson = await response.json();
            errorText = errJson.detail || JSON.stringify(errJson);
          } catch {
            // ignore JSON parse failures
          }
          throw new Error(`Failed to send to Yara: ${errorText}`);
        }

        let results: any;
        try {
          results = await response.json();
        } catch {
          results = null;
        }
        console.log("[YARA] Response OK (200). Parsed results:", results);
        if (results) setPrintResults(results);

        // 🔹 NEW RULE (same as genesis): If Yara returned 200, ALWAYS trigger Shiprocket
        try {
          const shiprocketOrderIds = selectedOrderIds;
          console.log(
            "[SHIPROCKET] Triggering with order_ids:",
            shiprocketOrderIds
          );

          const srPayload = {
            order_ids: shiprocketOrderIds,
            request_pickup: true,
          };
          console.log("[SHIPROCKET] POST payload:", srPayload);

          const srRes = await fetch(
            `${baseUrl}/shiprocket/create-from-orders`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(srPayload),
            }
          );

          console.log(
            "[SHIPROCKET] create-from-orders status:",
            srRes.status,
            srRes.statusText
          );

          if (!srRes.ok) {
            let srErrMsg = `${srRes.status} ${srRes.statusText}`;
            try {
              const err = await srRes.json();
              console.log("[SHIPROCKET] Error body:", err);
              srErrMsg = err.detail || JSON.stringify(err);
            } catch {
              // keep default msg
            }
            throw new Error(srErrMsg);
          }

          const srJson = await srRes.json();
          console.log("[SHIPROCKET] Success body:", srJson);

          const created = Array.isArray(srJson.created)
            ? srJson.created.length
            : 0;
          const awbs = Array.isArray(srJson.awbs) ? srJson.awbs.length : 0;
          const errCount = Array.isArray(srJson.errors)
            ? srJson.errors.length
            : 0;
          const pickup = srJson.pickup ? "requested" : "skipped";

          alert(
            `Shiprocket → created: ${created}, AWBs: ${awbs}, pickup: ${pickup}${
              errCount ? `, errors: ${errCount}` : ""
            }`
          );
        } catch (e) {
          console.error("[SHIPROCKET] create-from-orders failed:", e);
          alert(
            `❌ Shiprocket create failed: ${
              e instanceof Error ? e.message : "Unknown error"
            }`
          );
        }

        // Show success/failure summary for Yara (informational)
        try {
          if (Array.isArray(results)) {
            const successfulOrders = results.filter(
              (r: any) => r.status !== "error"
            );
            const failedOrders = results.filter(
              (r: any) => r.status === "error"
            );
            if (successfulOrders.length > 0) {
              alert(
                `Successfully queued ${successfulOrders.length} orders to Yara`
              );
            }
            if (failedOrders.length > 0) {
              alert(
                `Failed to queue ${failedOrders.length} orders to Yara. Check console for details.`
              );
              console.error("[YARA] Failed orders:", failedOrders);
            }
          } else {
            console.log(
              "[YARA] Non-array response; skipping success/error breakdown."
            );
          }
        } catch (e) {
          console.warn("[YARA] Summary parsing failed:", e);
        }

        // Clear selection and refresh orders
        setSelectedOrders(new Set());

        const params = new URLSearchParams();
        if (filterStatus !== "all")
          params.append("filter_status", filterStatus);
        if (filterBookStyle !== "all")
          params.append("filter_book_style", filterBookStyle);
        params.append("sort_by", sortBy);
        params.append("sort_dir", sortDir);

        console.log("[YARA] Refetching orders with params:", params.toString());
        const ordersRes = await fetch(`${baseUrl}/orders?${params.toString()}`);
        console.log(
          "[YARA] orders GET status:",
          ordersRes.status,
          ordersRes.statusText
        );

        const data = await ordersRes.json();
        const rawData: RawOrder[] = data.orders || [];

        const transformed: Order[] = rawData.map((order: RawOrder): Order => {
          return {
            orderId: order.order_id || "N/A",
            jobId: order.job_id || "N/A",
            coverPdf: order.coverPdf || "",
            interiorPdf: order.interiorPdf || "",
            previewUrl: order.previewUrl || "",
            name: order.name || "",
            city: order.city || "",
            price: order.price || 0,
            paymentDate: order.paymentDate || "",
            approvalDate: order.approvalDate || "",
            status: order.status || "",
            bookId: order.bookId || "",
            bookStyle: order.bookStyle || "",
            printStatus: order.printStatus || "",
            feedback_email: false,
            printApproval: (() => {
              if (typeof order.print_approval === "boolean")
                return order.print_approval;
              console.warn(
                `⚠️ [YARA] print_approval missing or invalid for order:`,
                order
              );
              return "not found";
            })(),
            discountCode: order.discount_code || "",
            currency: order.currency || "INR",
            locale: order.locale || "",
            shippedAt: order.shippedAt || "",
            shippingStatus: (order.shippingStatus as string) || "",
            quantity: order.quantity || 1,
            printer: (order.printer ?? "") as string,
          };
        });

        setOrders(transformed);

        setTimeout(() => setShowProgress(false), 5000);
      } catch (error) {
        console.error("[YARA] Error sending orders to Yara:", error);
        setPrintResults([
          {
            order_id: "system",
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to send orders to Yara",
            step: "api_request",
          },
        ]);
        setTimeout(() => setShowProgress(false), 8000);
      }
    } else if (action === "reject") {
      console.log(
        `[REJECT] Performing ${action} on orders:`,
        Array.from(selectedOrders)
      );
    } else if (action === "finalise") {
      console.log(
        `[FINALISE] Performing ${action} on orders:`,
        Array.from(selectedOrders)
      );
    } else if (action === "request_feedback") {
      try {
        for (const orderId of selectedOrders) {
          const jobId = orders.find((o) => o.orderId === orderId)?.jobId;
          if (!jobId) continue;

          const res = await fetch(`${baseUrl}/send-feedback-email/${jobId}`, {
            method: "POST",
          });
          console.log(
            "[FEEDBACK] POST status:",
            res.status,
            res.statusText,
            "baseUrl:",
            baseUrl
          );
          if (res.ok) {
            setSentFeedbackOrders((prev) => new Set(prev).add(jobId));
            await fetchOrders();
          } else {
            const err = await res.json();
            alert(
              `❌ Failed to send feedback email for ${orderId}: ${err.detail}`
            );
          }
        }
        alert(`✅ Feedback email sent for ${selectedOrders.size} orders`);
      } catch (err) {
        console.error("[FEEDBACK] Error sending feedback email:", err);
        alert("❌ Something went wrong while sending the email.");
      }
    } else if (action === "unapprove") {
      try {
        const selectedJobIds = Array.from(selectedOrders)
          .map((orderId) => orders.find((o) => o.orderId === orderId)?.jobId)
          .filter(Boolean);

        console.log("[UNAPPROVE] job_ids:", selectedJobIds);

        const response = await fetch(`${baseUrl}/orders/unapprove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_ids: selectedJobIds }),
        });

        console.log(
          "[UNAPPROVE] POST status:",
          response.status,
          response.statusText
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || "Failed to unapprove orders");
        }
        alert(`✅ Successfully unapproved ${selectedJobIds.length} orders`);
        setSelectedOrders(new Set());
        fetchOrders();
      } catch (error) {
        console.error("[UNAPPROVE] Error unapproving orders:", error);
        alert(
          `❌ Failed to unapprove orders: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    } else if (action === "mark_green" || action === "mark_red") {
      const status = action === "mark_green" ? "green" : "red";
      const orderIds = Array.from(selectedOrders);
      if (orderIds.length === 0) return;

      try {
        console.log(
          "[MARK] Setting status for orderIds:",
          orderIds,
          "to:",
          status
        );

        const results = await Promise.allSettled(
          orderIds.map(async (orderId) => {
            const res = await fetch(
              `${baseUrl}/orders/set-cust-status/${encodeURIComponent(
                orderId
              )}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status }),
              }
            );
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.detail || `HTTP ${res.status}`);
            }
            return orderId;
          })
        );

        const successes = results.filter(
          (r) => r.status === "fulfilled"
        ).length;
        const failures = results.filter((r) => r.status === "rejected");

        if (successes > 0) {
          alert(`Set ${status.toUpperCase()} for ${successes} order(s)`);
        }
        if (failures.length > 0) {
          console.error("[MARK] Failed to set status for:", failures);
          alert(
            `❌ Failed to set status for ${failures.length} order(s). Check console for details.`
          );
        }

        await fetchOrders();
        setSelectedOrders(new Set());
      } catch (e) {
        console.error("[MARK] Error updating statuses:", e);
        alert("❌ Something went wrong while updating statuses.");
      }
    }
  };

  const hasSentFeedbackOrders = () => {
    return Array.from(selectedOrders).some((orderId) => {
      const order = orders.find((o) => o.orderId === orderId);
      return order && sentFeedbackOrders.has(order.jobId);
    });
  };

  function getCurrencySymbol(code: string): string {
    const symbols: Record<string, string> = {
      INR: "₹",
      USD: "$",
      EUR: "€",
      GBP: "£",
      AUD: "A$",
      CAD: "C$",
      SGD: "S$",
      JPY: "¥",
    };
    return symbols[code] || code + " ";
  }

  const formatDate = (dateInput: any) => {
    if (!dateInput) return "";
    try {
      if (
        typeof dateInput === "object" &&
        dateInput.$date &&
        dateInput.$date.$numberLong
      ) {
        const dt = new Date(Number(dateInput.$date.$numberLong));
        return dt.toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
      }
      if (typeof dateInput === "string" && dateInput.trim() !== "") {
        const dt = new Date(dateInput);
        return dt.toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
      }
    } catch {
      return "";
    }
    return "";
  };

  function formatDayMonUTC(dateInput: any): string {
    if (!dateInput) return "";

    let dt: Date | null = null;
    try {
      if (typeof dateInput === "object" && dateInput.$date?.$numberLong) {
        dt = new Date(Number(dateInput.$date.$numberLong)); // epoch ms (UTC)
      } else if (typeof dateInput === "string" && dateInput.trim() !== "") {
        dt = new Date(dateInput); // ISO string
      }
    } catch {
      return "";
    }
    if (!dt || isNaN(dt.getTime())) return "";

    const s = dt.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });

    return s.replace(/\bSep\b/, "Sept");
  }

  return (
    <main className="py-2 px-4 space-y-3">
      <h2 className="text-2xl font-semibold text-black">{title}</h2>

      <div className="flex flex-wrap gap-2 items-center">
        <button
          onClick={() => handleAction("approve")}
          disabled={selectedOrders.size === 0 || hasNonApprovedOrders()}
          title={
            hasNonApprovedOrders()
              ? "All selected orders must be approved before printing"
              : ""
          }
          className={`px-4 py-2 rounded text-sm font-medium transition ${
            selectedOrders.size === 0 || hasNonApprovedOrders()
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-green-600 text-white hover:bg-green-700"
          }`}
        >
          Send to Cloudprinter
        </button>

        <button
          onClick={() => handleAction("send_to_genesis")}
          disabled={
            selectedOrders.size === 0 ||
            hasNonApprovedOrders() ||
            hasNonIndiaSelectedOrders()
          }
          title={
            hasNonApprovedOrders()
              ? "All selected orders must be approved before sending"
              : hasNonIndiaSelectedOrders()
              ? "Send to Genesis is available only for India (IN) orders"
              : ""
          }
          className={`px-4 py-2 rounded text-sm font-medium transition ${
            selectedOrders.size === 0 ||
            hasNonApprovedOrders() ||
            hasNonIndiaSelectedOrders()
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-green-600 text-white hover:bg-green-700"
          }`}
        >
          Send to Genesis
        </button>

        <button
          onClick={() => handleAction("send_to_yara")}
          disabled={
            selectedOrders.size === 0 ||
            hasNonApprovedOrders() ||
            hasNonIndiaSelectedOrders()
          }
          title={
            hasNonApprovedOrders()
              ? "All selected orders must be approved before sending"
              : hasNonIndiaSelectedOrders()
              ? "Send to Yara is available only for India (IN) orders"
              : ""
          }
          className={`px-4 py-2 rounded text-sm font-medium transition ${
            selectedOrders.size === 0 ||
            hasNonApprovedOrders() ||
            hasNonIndiaSelectedOrders()
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-green-600 text-white hover:bg-green-700"
          }`}
        >
          Send to Yara
        </button>

        <button
          onClick={() => handleAction("reject")}
          disabled={selectedOrders.size === 0}
          className={`px-4 py-2 rounded text-sm font-medium transition ${
            selectedOrders.size === 0
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-red-600 text-white hover:bg-red-700"
          }`}
        >
          Reject
        </button>

        <button
          onClick={() => handleAction("finalise")}
          disabled={selectedOrders.size === 0 || hasApprovedOrders()}
          title={
            hasApprovedOrders()
              ? "Cannot finalise orders that are already approved"
              : ""
          }
          className={`px-4 py-2 rounded text-sm font-medium transition ${
            selectedOrders.size === 0 || hasApprovedOrders()
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-yellow-600 text-white hover:bg-yellow-700"
          }`}
        >
          Finalise Book
        </button>

        <button
          onClick={() => handleAction("request_feedback")}
          disabled={selectedOrders.size === 0 || hasSentFeedbackOrders()}
          className={`px-4 py-2 rounded text-sm font-medium transition ${
            selectedOrders.size === 0 || hasSentFeedbackOrders()
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-indigo-600 text-white hover:bg-indigo-700"
          }`}
        >
          Request Feedback
        </button>

        <button
          onClick={() => handleAction("unapprove")}
          disabled={
            selectedOrders.size === 0 ||
            Array.from(selectedOrders).some((orderId) => {
              const order = orders.find((o) => o.orderId === orderId);
              return order?.status !== "Approved";
            })
          }
          className={`px-4 py-2 rounded test-sm font-medium transition ${
            selectedOrders.size === 0 ||
            Array.from(selectedOrders).some((orderId) => {
              const order = orders.find((o) => o.orderId === orderId);
              return order?.status !== "Approved";
            })
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-red-500 text-white hover:bg-red-600"
          }`}
        >
          Unapprove
        </button>

        <button
          type="button"
          onClick={() => handleAction("mark_red")}
          disabled={selectedOrders.size === 0} // <= was: selectedOrders.size !== 1
          className={`px-4 py-2 rounded text-sm font-medium transition ${
            selectedOrders.size === 0
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-rose-600 text-white hover:bg-rose-700"
          }`}
        >
          Mark Red
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-blue-200 text-black"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="all">All Statuses</option>
          <option value="approved">Approved</option>
          <option value="uploaded">Uploaded</option>
        </select>

        <select
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-blue-200 text-black"
          value={filterBookStyle}
          onChange={(e) => setFilterBookStyle(e.target.value)}
        >
          <option value="all">All Book Styles</option>
          <option value="paperback">Paperback</option>
          <option value="hardcover">Hardcover</option>
        </select>

        <select
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-blue-200 text-black"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="created_at">Sort by: Created At</option>
          <option value="name">Sort by: Name</option>
          <option value="city">Sort by: City</option>
          <option value="processed_at">Sort by: Payment At</option>
        </select>

        <select
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-blue-200 text-black"
          value={sortDir}
          onChange={(e) => setSortDir(e.target.value)}
        >
          <option value="desc">↓ Descending</option>
          <option value="asc">↑ Ascending</option>
        </select>

        <select
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-blue-200 text-black"
          value={filterPrintApproval}
          onChange={(e) => setFilterPrintApproval(e.target.value)}
        >
          <option value="all">All Print Approvals</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
          <option value="not_found">Not Found</option>
        </select>
        {!hideDiscountFilter && (
          <select
            value={filterDiscountCode}
            onChange={(e) => setFilterDiscountCode(e.target.value)}
            className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-blue-200 text-black"
          >
            <option value="all">All Discount Codes</option>
            <option value="LHMM">LHMM</option>
            {/* <option value="TEST">TEST</option> */}
            <option value="SPECIAL10">SPECIAL10</option>
            <option value="none">None</option>
          </select>
        )}
      </div>

      <div className="relative">
        <input
          type="text"
          value={search}
          onChange={(e) => {
            const v = e.target.value;
            setSearch(v);
            if (typing) clearTimeout(typing);
            const t = setTimeout(() => setUrlParam("q", v || null), 300);
            setTyping(t);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (typing) clearTimeout(typing);
              setUrlParam("q", search || null);
              fetchOrders();
            }
          }}
          placeholder="Search here..."
          className="sm:w-72 rounded border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {search && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setUrlParam("q", null);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs"
            aria-label="Clear"
          >
            ✕
          </button>
        )}
      </div>

      <div className="overflow-auto rounded border border-gray-200">
        <table className="min-w-full table-auto text-sm text-left">
          <thead className="bg-gray-100 sticky top-0 z-10">
            <tr className="text-gray-700 font-medium">
              <th className="p-3">
                <input
                  type="checkbox"
                  checked={
                    selectedOrders.size === orders.length && orders.length > 0
                  }
                  onChange={handleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              {[
                "Order ID",
                "Name",
                "City",
                "Loc",
                "Book ID",
                "Book Style",
                "Price",
                "Payment Date",
                "Approval Date",
                "Status",
                "Print Approval",
                "Preview",
                "Cover PDF",
                "Interior PDF",
                "Print Status",
                "Quantity",
                "Shipped At",
                "Shipping Status",
                "Discount Code",
                "Feedback Email",
              ].map((heading, i) => (
                <th key={i} className="p-3 whitespace-nowrap">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {currentOrders.map((order, index) => (
              <tr
                key={`${order.orderId}-${index}`}
                className="border-t hover:bg-gray-50 odd:bg-white even:bg-gray-50 transition-colors"
              >
                <td className="px-2 py-2 ">
                  <input
                    type="checkbox"
                    checked={selectedOrders.has(order.orderId)}
                    onChange={() => handleSelectOrder(order.orderId)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </td>
                <td className="px-2 text-xs">
                  {" "}
                  {order.orderId !== "N/A" ? (
                    <button
                      type="button"
                      onClick={() => openOrder(order.orderId)}
                      className="text-blue-600 hover:underline"
                      title="View full order details"
                    >
                      {" "}
                      {order.orderId}{" "}
                    </button>
                  ) : (
                    <span>N/A</span>
                  )}{" "}
                </td>

                <td className="px-2 text-black text-xs">{order.name}</td>
                <td className="px-2 text-black text-xs">{order.city}</td>
                <td className="px-2 text-black text-xs">{order.locale}</td>
                <td className="px-2 text-black text-xs">{order.bookId}</td>
                <td className="px-2 text-black text-xs">{order.bookStyle}</td>
                <td className="px-2 text-black text-xs">
                  {getCurrencySymbol(order.currency)}
                  {order.price.toLocaleString("en-IN")}
                </td>
                <td className="px-2 text-black text-xs">
                  {order.paymentDate && formatDate(order.paymentDate)}
                </td>
                <td className="px-2 text-black text-xs">
                  {order.approvalDate && formatDate(order.approvalDate)}
                </td>
                <td className="px-2">
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      order.status === "Approved"
                        ? "bg-green-100 text-green-800"
                        : "bg-yellow-100 text-yellow-800"
                    }`}
                  >
                    {order.status}
                  </span>
                </td>
                <td className="px-1">
                  {order.printApproval === true && (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800">
                      Yes
                    </span>
                  )}
                  {order.printApproval === false && (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800">
                      No
                    </span>
                  )}
                  {order.printApproval === "not found" && (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800">
                      Not Found
                    </span>
                  )}
                </td>
                <td className="px-1">
                  {order.previewUrl ? (
                    <a
                      href={order.previewUrl}
                      target="_blank"
                      className="text-blue-600 hover:underline"
                    >
                      Preview
                    </a>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="px-1">
                  {order.coverPdf ? (
                    <a
                      href={order.coverPdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      View
                    </a>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-2">
                  {order.interiorPdf ? (
                    <a
                      href={order.interiorPdf}
                      target="_blank"
                      className="text-blue-600 hover:underline"
                    >
                      View PDF
                    </a>
                  ) : (
                    "-"
                  )}
                </td>

                <td className="px-2">
                  {/* Show printer name (Genesis / Cloudprinter) when present, else fallback to '-' */}
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      // use a positive style when any "sent" status exists
                      order.printStatus && order.printStatus.startsWith("sent")
                        ? "bg-blue-100 text-blue-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                    title={
                      order.printer
                        ? `Printer: ${order.printer}`
                        : order.printStatus || ""
                    }
                  >
                    {order.printer
                      ? order.printer
                      : order.printStatus &&
                        order.printStatus.startsWith("sent")
                      ? "Sent"
                      : "-"}
                  </span>
                </td>
                <td className="px-2 text-xs text-center">
                  {order.quantity && order.quantity > 1
                    ? `${order.quantity}`
                    : "1"}
                </td>
                <td className="px-2 text-xs">
                  {order.shippedAt && formatDayMonUTC(order.shippedAt)}
                </td>
                <td className="px-2 text-xs">
                  {order.shippingStatus ? (
                    <span
                      className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800"
                      title={order.shippingStatus}
                    >
                      {order.shippingStatus}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-2">
                  {order.discountCode ? (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
                      {order.discountCode}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-2">
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      order.feedback_email
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {order.feedback_email ? "Sent" : "-"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-center items-center gap-2 py-4">
          <button
            onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
            disabled={currentPage === 1}
            className="px-3 py-1 rounded border bg-white text-sm disabled:opacity-50 text-black"
          >
            Prev
          </button>

          {currentPage > 2 && (
            <>
              <button
                onClick={() => setCurrentPage(1)}
                className={`px-3 py-1 rounded border text-sm ${
                  currentPage === 1 ? "bg-blue-600 text-white" : "bg-white"
                }`}
              >
                1
              </button>
              {currentPage > 3 && (
                <span className="px-2 text-sm text-gray-500">...</span>
              )}
            </>
          )}

          {/* Center Pages */}
          {[-1, 0, 1].map((offset) => {
            const page = currentPage + offset;
            if (page < 1 || page > totalPages) return null;
            return (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={`px-3 py-1 rounded border text-sm ${
                  currentPage === page
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-800"
                }`}
              >
                {page}
              </button>
            );
          })}

          {/* Last Page + Ellipsis */}
          {currentPage < totalPages - 1 && (
            <>
              {currentPage < totalPages - 2 && (
                <span className="px-2 text-sm text-gray-500">...</span>
              )}
              <button
                onClick={() => setCurrentPage(totalPages)}
                className={`px-3 py-1 rounded border text-sm ${
                  currentPage === totalPages
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-800"
                }`}
              >
                {totalPages}
              </button>
            </>
          )}

          <button
            onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
            disabled={currentPage === totalPages}
            className="px-3 py-1 rounded border bg-white text-sm disabled:opacity-50 text-black"
          >
            Next
          </button>
        </div>
      </div>

      <PrintProgress isVisible={showProgress} results={printResults} />

      {orderIdInUrl && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-200"
            onClick={closeOrder}
            aria-label="Close order details"
          />

          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl transition-transform duration-200">
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-white">
                <div>
                  <h3 className="text-xl font-semibold text-gray-900">
                    Order Details
                  </h3>
                  <p className="text-xl text-gray-700 mt-1 font-bold">
                    {orderIdInUrl}
                  </p>
                </div>
                <button
                  onClick={closeOrder}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors duration-150"
                  aria-label="Close"
                >
                  <svg
                    className="w-5 h-5 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                {detailLoading && (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-900"></div>
                    <span className="ml-2 text-sm text-gray-600">
                      Loading order details...
                    </span>
                  </div>
                )}

                {detailError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-sm text-red-800">
                      Error loading order: {detailError}
                    </p>
                  </div>
                )}

                {form && !detailLoading && !detailError && (
                  <form
                    className="space-y-4 text-sm"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveOrder();
                    }}
                  >
                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">
                        Customer
                      </h4>
                      <div className="space-y-3">
                        <div>
                          <label className="block font-medium">Name</label>
                          <input
                            value={form.name}
                            onChange={(e) => updateForm("name", e.target.value)}
                            className="w-full border rounded px-2 py-1"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block font-medium">Gender</label>
                            <select
                              value={form.gender}
                              onChange={(e) =>
                                updateForm("gender", e.target.value)
                              }
                              className="w-full border rounded px-2 py-1"
                            >
                              <option value="">-</option>
                              <option value="boy">boy</option>
                              <option value="girl">girl</option>
                            </select>
                          </div>
                          <div>
                            <label className="block font-medium">
                              Book Style
                            </label>
                            <select
                              value={form.book_style}
                              onChange={(e) =>
                                updateForm("book_style", e.target.value)
                              }
                              className="w-full border rounded px-2 py-1"
                            >
                              <option value="">-</option>
                              <option value="paperback">paperback</option>
                              <option value="hardcover">hardcover</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">
                        Contact
                      </h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block font-medium">Email</label>
                          <input
                            value={form.email}
                            onChange={(e) =>
                              updateForm("email", e.target.value)
                            }
                            className="w-full border rounded px-2 py-1"
                          />
                        </div>
                        <div>
                          <label className="block font-medium">Phone</label>
                          <input
                            value={form.phone}
                            onChange={(e) =>
                              updateForm("phone", e.target.value)
                            }
                            className="w-full border rounded px-2 py-1"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">
                        Book
                      </h4>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                          <label className="block font-medium">
                            Discount Code
                          </label>
                          <input
                            value={form.discount_code}
                            onChange={(e) =>
                              updateForm("discount_code", e.target.value)
                            }
                            className="w-full border rounded px-2 py-1"
                          />
                        </div>
                        <div>
                          <label className="block font-medium">Quantity</label>
                          <input
                            type="number"
                            min={1}
                            value={form.quantity}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === "") {
                                updateForm("quantity", "");
                                return;
                              }
                              const n = Number(v);
                              if (Number.isNaN(n)) return;
                              updateForm("quantity", Math.max(1, n));
                            }}
                            onBlur={() => {
                              if (
                                form.quantity === "" ||
                                Number.isNaN(Number(form.quantity))
                              ) {
                                updateForm("quantity", 1);
                              }
                            }}
                            className="w-full border rounded px-2 py-1"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">
                        Status
                      </h4>
                      <div>
                        <label className="block font-medium">
                          Customer Status
                        </label>
                        <select
                          value={form.cust_status}
                          onChange={(e) =>
                            updateForm("cust_status", e.target.value)
                          }
                          className="w-full border rounded px-2 py-1"
                        >
                          <option value="">-</option>
                          <option value="green">green</option>
                          <option value="red">red</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">
                        Shipping Address
                      </h4>
                      <div className="grid grid-cols-2 gap-3">
                        <input
                          placeholder="Street"
                          className="border rounded px-2 py-1 col-span-2"
                          value={form.shipping_address.street}
                          onChange={(e) =>
                            updateForm(
                              "shipping_address.street",
                              e.target.value
                            )
                          }
                        />
                        <input
                          placeholder="City"
                          className="border rounded px-2 py-1"
                          value={form.shipping_address.city}
                          onChange={(e) =>
                            updateForm("shipping_address.city", e.target.value)
                          }
                        />
                        <input
                          placeholder="State"
                          className="border rounded px-2 py-1"
                          value={form.shipping_address.state}
                          onChange={(e) =>
                            updateForm("shipping_address.state", e.target.value)
                          }
                        />
                        <input
                          placeholder="Country"
                          className="border rounded px-2 py-1"
                          value={form.shipping_address.country}
                          onChange={(e) =>
                            updateForm(
                              "shipping_address.country",
                              e.target.value
                            )
                          }
                        />
                        <input
                          placeholder="Postal Code"
                          className="border rounded px-2 py-1"
                          value={form.shipping_address.postal_code}
                          onChange={(e) =>
                            updateForm(
                              "shipping_address.postal_code",
                              e.target.value
                            )
                          }
                        />
                      </div>
                    </div>

                    {saveError && <p className="text-red-600">{saveError}</p>}
                  </form>
                )}
              </div>

              {form && !detailLoading && !detailError && (
                <div className="p-4 border-t bg-white flex gap-2 justify-end">
                  <button
                    onClick={() => setForm((f: any) => ({ ...f }))}
                    className="px-3 py-2 rounded text-sm border"
                    type="button"
                  >
                    Reset
                  </button>
                  <button
                    onClick={saveOrder}
                    disabled={saving || !dirty}
                    className={`px-3 py-2 rounded text-sm ${
                      saving || !dirty
                        ? "bg-gray-200 text-gray-500"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
                    type="button"
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
