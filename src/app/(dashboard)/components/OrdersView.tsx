"use client";

import { useEffect, useState } from "react";
import Link from 'next/link';
import PrintProgress from './PrintProgress';
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
  quantity: number;
};

type PrinterResponse = {
  order_id: string;
  status: 'success' | 'error' | 'processing';
  message: string;
  step?: string;
  cloudprinter_reference?: string;
};

export default function OrdersView({ defaultDiscountCode = "all", hideDiscountFilter = false, title = "Orders", excludeTestDiscount }: OrdersViewProps) {

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
  const [sentFeedbackOrders, setSentFeedbackOrders] = useState<Set<string>>(new Set());
  const [selectedFeedbackOrders, setSelectedFeedbackOrders] = useState<Set<string>>(new Set());
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";
  const [currentPage, setCurrentPage] = useState(1);
  const [ordersPerPage, setOrdersPerPage] = useState(12);
  const [filterPrintApproval, setFilterPrintApproval] = useState("all");
  const [filterDiscountCode, setFilterDiscountCode] = useState<string>(defaultDiscountCode);
  const [detailOrder, setDetailOrder] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState<string>(searchParams.get("q") || "");
  const [typing, setTyping] = useState<NodeJS.Timeout | null>(null);

  const totalPages = Math.ceil(orders.length / ordersPerPage);
  const orderIdInUrl = searchParams.get("order_id") || null;

  const openOrder = (orderId: string) => {
    router.push(`/orders/order-detail?order_id=${encodeURIComponent(orderId)}`, {
      scroll: false,
    });
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
          const setPath =
            path === "shipping_address.postal_code" ? path : path;
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
      const res = await fetch(`${baseUrl}/orders/${encodeURIComponent(orderIdInUrl)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setDetailOrder(data.order);       // refresh drawer
      await fetchOrders();              // refresh table list
      setDirty(false);
      alert("✅ Saved");
    } catch (e: any) {
      setSaveError(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Check if any selected order is already approved
  const hasApprovedOrders = () => {
    return Array.from(selectedOrders).some(orderId => {
      const order = orders.find(o => o.orderId === orderId);
      return order?.status === "Approved";
    });
  };

  // Check if any selected order is not approved
  const hasNonApprovedOrders = () => {
    return Array.from(selectedOrders).some(orderId => {
      const order = orders.find(o => o.orderId === orderId);
      return order?.status !== "Approved";
    });
  };

  const fetchOrders = async () => {
    try {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.append("filter_status", filterStatus);
      if (filterBookStyle !== "all") params.append("filter_book_style", filterBookStyle);
      if (filterPrintApproval !== "all") params.append("filter_print_approval", filterPrintApproval);
      if (filterDiscountCode !== "all") params.append("filter_discount_code", filterDiscountCode);
      if (excludeTestDiscount) {
        params.append("exclude_discount_code", "TEST");
        params.append("exclude_discount_code", "REJECTED");
      }
      params.append("sort_by", sortBy);
      params.append("sort_dir", sortDir);
      if (search && search.trim() !== "") params.append("q", search.trim());

      const res = await fetch(`${baseUrl}/orders?${params.toString()}`);
      const rawData: RawOrder[] = await res.json();

      // ... map to your Order[] exactly as before ...
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
        printStatus: order.printStatus || "",
        feedback_email: order.feedback_email === true,
        printApproval: typeof order.print_approval === "boolean" ? order.print_approval : "not found",
        discountCode: order.discount_code || "",
        currency: order.currency || "INR",
        locale: order.locale || "",
        shippedAt: order.shippedAt || "",
        quantity: order.quantity || 1,
      }));

      setOrders(transformed);
    } catch (e) {
      console.error("❌ Failed to fetch orders:", e);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [filterStatus, filterPrintApproval, filterDiscountCode, filterBookStyle, sortBy, sortDir, search]);

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

        const res = await fetch(`${baseUrl}/orders/${encodeURIComponent(orderIdInUrl)}`);
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
      setSelectedOrders(new Set(orders.map(order => order.orderId)));
    }
  };

  const handleAction = async (action: string) => {
    if (action === 'approve') {
      try {
        setShowProgress(true);
        setPrintResults([]);

        // Initialize progress for all selected orders
        const selectedOrderIds = Array.from(selectedOrders);
        console.log('selectedOrderIds', selectedOrderIds);
        setPrintResults(selectedOrderIds.map(orderId => ({
          order_id: orderId,
          status: 'processing',
          message: 'Waiting to be processed...',
          step: 'queued'
        })));

        const response = await fetch(`${baseUrl}/orders/approve-printing`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(selectedOrderIds),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const results: PrinterResponse[] = await response.json();
        setPrintResults(results);

        // Handle the results
        const successfulOrders = results.filter(r => r.status === 'success');
        const failedOrders = results.filter(r => r.status === 'error');

        if (successfulOrders.length > 0) {
          alert(`Successfully sent ${successfulOrders.length} orders to printer`);
        }

        if (failedOrders.length > 0) {
          alert(`Failed to send ${failedOrders.length} orders to printer. Check console for details.`);
          console.error('Failed orders:', failedOrders);
        }

        // Clear selection and refresh orders
        setSelectedOrders(new Set());

        // Trigger a refetch of orders to update their status
        const params = new URLSearchParams();
        if (filterStatus !== "all") params.append("filter_status", filterStatus);
        if (filterBookStyle !== "all") params.append("filter_book_style", filterBookStyle);
        params.append("sort_by", sortBy);
        params.append("sort_dir", sortDir);

        const ordersRes = await fetch(`${baseUrl}/orders?${params.toString()}`);
        console.log(baseUrl, 'baseUrl');
        const rawData: RawOrder[] = await ordersRes.json();

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
              if (typeof order.print_approval === "boolean") return order.print_approval;
              console.warn(`⚠️ print_approval missing or invalid for order:`, order);
              return "not found";
            })(),

            discountCode: order.discount_code || "",
            currency: order.currency || "INR", // fallback to INR
            locale: order.locale || "", // default locale
            shippedAt: order.shippedAt || "",
            quantity: order.quantity || 1,
          };
        });

        setOrders(transformed);

        // Hide progress after 5 seconds of success
        setTimeout(() => {
          setShowProgress(false);
        }, 5000);
      } catch (error) {
        console.error('Error sending orders to printer:', error);
        setPrintResults([{
          order_id: 'system',
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to send orders to printer',
          step: 'api_request'
        }]);
      }
    } else if (action === 'reject') {
      console.log(`Performing ${action} on orders:`, Array.from(selectedOrders));
    } else if (action === 'finalise') {
      console.log(`Performing ${action} on orders:`, Array.from(selectedOrders));
    } else if (action === 'request_feedback') {
      try {
        for (const orderId of selectedOrders) {
          const jobId = orders.find(o => o.orderId === orderId)?.jobId;
          if (!jobId) continue;

          const res = await fetch(`${baseUrl}/send-feedback-email/${jobId}`, { method: 'POST' });
          console.log(baseUrl, 'baseUrl');
          if (res.ok) {
            setSentFeedbackOrders(prev => new Set(prev).add(jobId));
            await fetchOrders();
          } else {
            const err = await res.json();
            alert(`❌ Failed to send feedback email for ${orderId}: ${err.detail}`);
          }
        }
        alert(`✅ Feedback email sent for ${selectedOrders.size} orders`);
      } catch (err) {
        console.error("Error sending feedback email:", err);
        alert("❌ Something went wrong while sending the email.");
      }
    } else if (action === 'unapprove') {
      try {
        const selectedJobIds = Array.from(selectedOrders)
          .map(orderId => orders.find(o => o.orderId === orderId)?.jobId)
          .filter(Boolean);

        const response = await fetch(`${baseUrl}/orders/unapprove`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ job_ids: selectedJobIds }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || 'Failed to unapprove orders');
        }
        alert(`✅ Successfully unapproved ${selectedJobIds.length} orders`);
        setSelectedOrders(new Set()); // Clear selection after unapproval
        fetchOrders(); // Refresh orders to reflect changes
      } catch (error) {
        console.error("Error unapproving orders:", error);
        alert(`❌ Failed to unapprove orders: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (action === "mark_green" || action === "mark_red") {
      const status = action === "mark_green" ? "green" : "red";
      const orderIds = Array.from(selectedOrders);
      if (orderIds.length === 0) return;

      try {
        const results = await Promise.allSettled(
          orderIds.map(async (orderId) => {
            const res = await fetch(
              `${baseUrl}/orders/set-cust-status/${encodeURIComponent(orderId)}`,
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

        const successes = results.filter(r => r.status === "fulfilled").length;
        const failures = results.filter(r => r.status === "rejected");

        if (successes > 0) {
          alert(`Set ${status.toUpperCase()} for ${successes} order(s)`);
        }
        if (failures.length > 0) {
          console.error("Failed to set status for:", failures);
          alert(`❌ Failed to set status for ${failures.length} order(s). Check console for details.`);
        }

        // Refresh table and clear selection
        await fetchOrders();
        setSelectedOrders(new Set());
      } catch (e) {
        console.error(e);
        alert("❌ Something went wrong while updating statuses.");
      }
    }

  }

  const hasSentFeedbackOrders = () => {
    return Array.from(selectedOrders).some(orderId => {
      const order = orders.find(o => o.orderId === orderId);
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
      JPY: "¥"
    };
    return symbols[code] || code + " "; // fallback to showing the code
  }

  const formatDate = (dateInput: any) => {
    if (!dateInput) return "";
    try {
      if (typeof dateInput === "object" && dateInput.$date && dateInput.$date.$numberLong) {
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

  function convertToIST24HourFormat(utcDateStr: string): string {
    const date = new Date(utcDateStr);
    if (isNaN(date.getTime())) return "Invalid date";

    const istDate = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));

    const day = istDate.getDate().toString().padStart(2, '0');
    const month = istDate.toLocaleString('en-US', { month: 'short' });
    const hours = istDate.getHours().toString().padStart(2, '0');
    const minutes = istDate.getMinutes().toString().padStart(2, '0');

    return `${day} ${month}, ${hours}:${minutes}`;
  }


  const startIdx = (currentPage - 1) * ordersPerPage;
  const currentOrders = orders.slice(startIdx, startIdx + ordersPerPage);

  function formatDayMonUTC(dateInput: any): string {
    if (!dateInput) return "";

    let dt: Date | null = null;
    try {
      if (typeof dateInput === "object" && dateInput.$date?.$numberLong) {
        dt = new Date(Number(dateInput.$date.$numberLong));  // epoch ms (UTC)
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
          onClick={() => handleAction('approve')}
          disabled={selectedOrders.size === 0 || hasNonApprovedOrders()}
          title={hasNonApprovedOrders() ? "All selected orders must be approved before printing" : ""}
          className={`px-4 py-2 rounded text-sm font-medium transition ${selectedOrders.size === 0 || hasNonApprovedOrders()
            ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
            : 'bg-green-600 text-white hover:bg-green-700'
            }`}
        >
          Approve Printing
        </button>

        <button
          onClick={() => handleAction('reject')}
          disabled={selectedOrders.size === 0}
          className={`px-4 py-2 rounded text-sm font-medium transition ${selectedOrders.size === 0
            ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
            : 'bg-red-600 text-white hover:bg-red-700'
            }`}
        >
          Reject
        </button>

        <button
          onClick={() => handleAction('finalise')}
          disabled={selectedOrders.size === 0 || hasApprovedOrders()}
          title={hasApprovedOrders() ? "Cannot finalise orders that are already approved" : ""}
          className={`px-4 py-2 rounded text-sm font-medium transition ${selectedOrders.size === 0 || hasApprovedOrders()
            ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
            : 'bg-yellow-600 text-white hover:bg-yellow-700'
            }`}
        >
          Finalise Book
        </button>

        <button
          onClick={() => handleAction('request_feedback')}
          disabled={selectedOrders.size === 0 || hasSentFeedbackOrders()}
          className={`px-4 py-2 rounded text-sm font-medium transition ${selectedOrders.size === 0 || hasSentFeedbackOrders()
            ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
            : 'bg-indigo-600 text-white hover:bg-indigo-700'
            }`}
        >
          Request Feedback
        </button>

        <button
          onClick={() => handleAction('unapprove')}
          disabled={
            selectedOrders.size === 0 ||
            Array.from(selectedOrders).some(orderId => {
              const order = orders.find(o => o.orderId === orderId);
              return order?.status !== "Approved";
            })
          }
          className={`px-4 py-2 rounded test-sm font-medium transition ${selectedOrders.size === 0 ||
            Array.from(selectedOrders).some(orderId => {
              const order = orders.find(o => o.orderId === orderId);
              return order?.status !== "Approved";
            }) ? 'bg-gray-200 text-gray-500 cursor-not-allowed' :
            'bg-red-500 text-white hover:bg-red-600'
            }`}>
          Unapprove
        </button>

        <button
          type="button"
          onClick={() => handleAction("mark_red")}
          disabled={selectedOrders.size === 0} // <= was: selectedOrders.size !== 1
          className={`px-4 py-2 rounded text-sm font-medium transition ${selectedOrders.size === 0
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
          placeholder="Looking for your order? Search here..."
          className="sm:w-72 rounded border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {search && (
          <button
            type="button"
            onClick={() => { setSearch(""); setUrlParam("q", null); }}
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
                  checked={selectedOrders.size === orders.length && orders.length > 0}
                  onChange={handleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              {[
                "Order ID", "Name", "City", "Loc", "Book ID", "Book Style", "Price", "Payment Date",
                "Approval Date", "Status", "Print Approval", "Preview", "Cover PDF", "Interior PDF", "Print Status", "Quantity", "Shipped At", "Discount Code", "Feedback Email",
              ].map((heading, i) => (
                <th key={i} className="p-3 whitespace-nowrap">{heading}</th>
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
                <td className="px-2 text-xs"> {order.orderId !== "N/A" ? (<button type="button" onClick={() => openOrder(order.orderId)} className="text-blue-600 hover:underline" title="View full order details" > {order.orderId} </button>) : <span>N/A</span>} </td>

                <td className="px-2 text-black text-xs">{order.name}</td>
                <td className="px-2 text-black text-xs">{order.city}</td>
                <td className="px-2 text-black text-xs">{order.locale}</td>
                <td className="px-2 text-black text-xs">{order.bookId}</td>
                <td className="px-2 text-black text-xs">{order.bookStyle}</td>
                <td className="px-2 text-black text-xs">{getCurrencySymbol(order.currency)}{order.price.toLocaleString("en-IN")}</td>
                <td className="px-2 text-black text-xs">{order.paymentDate && formatDate(order.paymentDate)}</td>
                <td className="px-2 text-black text-xs">{order.approvalDate && formatDate(order.approvalDate)}</td>
                <td className="px-2">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${order.status === "Approved" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}>
                    {order.status}
                  </span>
                </td>
                <td className="px-1">
                  {order.printApproval === true && (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800">Yes</span>
                  )}
                  {order.printApproval === false && (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800">No</span>
                  )}
                  {order.printApproval === "not found" && (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800">Not Found</span>
                  )}
                </td>
                <td className="px-1">{order.previewUrl ? <a href={order.previewUrl} target="_blank" className="text-blue-600 hover:underline">Preview</a> : "-"}</td>
                <td className="px-1">
                  {order.coverPdf ? (
                    <a href={order.coverPdf} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                      View
                    </a>
                  ) : <span className="text-gray-400">-</span>}
                </td>
                <td className="px-2">{order.interiorPdf ? <a href={order.interiorPdf} target="_blank" className="text-blue-600 hover:underline">View PDF</a> : "-"}</td>

                <td className="px-2">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${order.printStatus === "sent_to_printer" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-800"}`}>
                    {order.printStatus === "sent_to_printer" ? "Sent" : "-"}
                  </span>
                </td>
                <td className="px-2 text-xs text-center">
                  {order.quantity && order.quantity > 1 ? `${order.quantity}` : "1"}
                </td>
                <td className="px-2 text-xs">
                  {order.shippedAt && formatDayMonUTC(order.shippedAt)}
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
                  <span className={`px-2 py-1 rounded text-xs font-medium ${order.feedback_email ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}`}>
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
                className={`px-3 py-1 rounded border text-sm ${currentPage === 1 ? "bg-blue-600 text-white" : "bg-white"
                  }`}
              >
                1
              </button>
              {currentPage > 3 && <span className="px-2 text-sm text-gray-500">...</span>}
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
                className={`px-3 py-1 rounded border text-sm ${currentPage === page ? "bg-blue-600 text-white" : "bg-white text-gray-800"
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
                className={`px-3 py-1 rounded border text-sm ${currentPage === totalPages ? "bg-blue-600 text-white" : "bg-white text-gray-800"
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
                  <h3 className="text-xl font-semibold text-gray-900">Order Details</h3>
                  <p className="text-xl text-gray-700 mt-1 font-bold">{orderIdInUrl}</p>
                </div>
                <button
                  onClick={closeOrder}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors duration-150"
                  aria-label="Close"
                >
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                {detailLoading && (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-900"></div>
                    <span className="ml-2 text-sm text-gray-600">Loading order details...</span>
                  </div>
                )}

                {detailError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-sm text-red-800">Error loading order: {detailError}</p>
                  </div>
                )}

                {form && !detailLoading && !detailError && (
                  <form
                    className="space-y-4 text-sm"
                    onSubmit={(e) => { e.preventDefault(); saveOrder(); }}
                  >

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">Customer</h4>
                      <div className="space-y-3">
                        <div>
                          <label className="block font-medium">Name</label>
                          <input value={form.name} onChange={(e) => updateForm("name", e.target.value)}
                            className="w-full border rounded px-2 py-1" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block font-medium">Gender</label>
                            <select value={form.gender} onChange={(e) => updateForm("gender", e.target.value)}
                              className="w-full border rounded px-2 py-1">
                              <option value="">-</option>
                              <option value="boy">boy</option>
                              <option value="girl">girl</option>
                            </select>
                          </div>
                          <div>
                            <label className="block font-medium">Book Style</label>
                            <select value={form.book_style} onChange={(e) => updateForm("book_style", e.target.value)}
                              className="w-full border rounded px-2 py-1">
                              <option value="">-</option>
                              <option value="paperback">paperback</option>
                              <option value="hardcover">hardcover</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">Contact</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block font-medium">Email</label>
                          <input value={form.email} onChange={(e) => updateForm("email", e.target.value)}
                            className="w-full border rounded px-2 py-1" />
                        </div>
                        <div>
                          <label className="block font-medium">Phone</label>
                          <input value={form.phone} onChange={(e) => updateForm("phone", e.target.value)}
                            className="w-full border rounded px-2 py-1" />
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">Book</h4>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                          <label className="block font-medium">Discount Code</label>
                          <input value={form.discount_code} onChange={(e) => updateForm("discount_code", e.target.value)}
                            className="w-full border rounded px-2 py-1" />
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
                              if (form.quantity === "" || Number.isNaN(Number(form.quantity))) {
                                updateForm("quantity", 1);
                              }
                            }}
                            className="w-full border rounded px-2 py-1"
                          />

                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">Status</h4>
                      <div>
                        <label className="block font-medium">Customer Status</label>
                        <select value={form.cust_status} onChange={(e) => updateForm("cust_status", e.target.value)}
                          className="w-full border rounded px-2 py-1">
                          <option value="">-</option>
                          <option value="green">green</option>
                          <option value="red">red</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <h4 className="font-medium text-gray-900 text-xs uppercase tracking-wide mb-2">Shipping Address</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <input placeholder="Street" className="border rounded px-2 py-1 col-span-2"
                          value={form.shipping_address.street}
                          onChange={(e) => updateForm("shipping_address.street", e.target.value)} />
                        <input placeholder="City" className="border rounded px-2 py-1"
                          value={form.shipping_address.city}
                          onChange={(e) => updateForm("shipping_address.city", e.target.value)} />
                        <input placeholder="State" className="border rounded px-2 py-1"
                          value={form.shipping_address.state}
                          onChange={(e) => updateForm("shipping_address.state", e.target.value)} />
                        <input placeholder="Country" className="border rounded px-2 py-1"
                          value={form.shipping_address.country}
                          onChange={(e) => updateForm("shipping_address.country", e.target.value)} />
                        <input placeholder="Postal Code" className="border rounded px-2 py-1"
                          value={form.shipping_address.postal_code}
                          onChange={(e) => updateForm("shipping_address.postal_code", e.target.value)} />
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
                    className={`px-3 py-2 rounded text-sm ${saving || !dirty ? "bg-gray-200 text-gray-500" : "bg-blue-600 text-white hover:bg-blue-700"}`}
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
  )

}