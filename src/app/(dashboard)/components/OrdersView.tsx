/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
"use client";

import { useEffect, useState } from "react";
import Link from 'next/link';
import PrintProgress from './PrintProgress';


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
};

type PrinterResponse = {
  order_id: string;
  status: 'success' | 'error' | 'processing';
  message: string;
  step?: string;
  cloudprinter_reference?: string;
};

export default function OrdersView({ defaultDiscountCode = "all", hideDiscountFilter = false, title = "Orders", excludeTestDiscount }: OrdersViewProps) {
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

  const totalPages = Math.ceil(orders.length / ordersPerPage);

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
      }
      params.append("sort_by", sortBy);
      params.append("sort_dir", sortDir);

      const res = await fetch(`${baseUrl}/orders?${params.toString()}`);
      console.log(baseUrl, 'baseUrl');
      const rawData: RawOrder[] = await res.json();

      const transformed: Order[] = rawData.map((order: RawOrder): Order => {
        // Helper function to safely format the approval date
        const formatApprovalDate = (approved_at: any) => {
          if (!approved_at) return "";
          if (typeof approved_at === "string") return approved_at;
          if (approved_at.$date && approved_at.$date.$numberLong) {
            return new Date(Number(approved_at.$date.$numberLong)).toLocaleString('en-IN', {
              day: 'numeric',
              month: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: 'numeric',
              hour12: true,
              timeZone: 'Asia/Kolkata'
            });
          };


          return "";
        };

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
          feedback_email: order.feedback_email === true,
          printApproval: typeof order.print_approval === "boolean" ? order.print_approval : "not found",
          discountCode: order.discount_code || "",
          currency: order.currency || "INR", // fallback to INR
          locale: order.locale || "", // default locale
          shippedAt: order.shippedAt || "",
        };
      });

      setOrders(transformed);
    } catch (error) {
      console.error("❌ Failed to fetch orders:", error);
    }
  };

  useEffect(() => {


    fetchOrders();
  }, [filterStatus, filterPrintApproval, filterDiscountCode, filterBookStyle, sortBy, sortDir]);

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
        console.log(baseUrl, 'baseUrl');
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
          // Helper function to safely format the approval date
          const formatApprovalDate = (approved_at: any) => {
            if (!approved_at) return "";
            if (typeof approved_at === "string") return approved_at;
            if (approved_at.$date && approved_at.$date.$numberLong) {
              return new Date(Number(approved_at.$date.$numberLong)).toLocaleString('en-IN', {
                day: 'numeric',
                month: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                hour12: true,
                timeZone: 'Asia/Kolkata'
              });
            }
            return "";
          };

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
      const size = selectedOrders.size;
      if (size !== 1) return; // hard guard
      const [orderId] = Array.from(selectedOrders);
      const status = action === "mark_green" ? "green" : "red";

      const res = await fetch(`${baseUrl}/orders/set-cust-status/${encodeURIComponent(orderId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }

      alert(`Set ${status.toUpperCase()} for ${orderId}`);
      // optionally refresh your table here
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
    const date = new Date(utcDateStr); // Assume input is UTC ISO string
    if (isNaN(date.getTime())) return "Invalid date";

    // IST offset = UTC + 5:30
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
  } catch { /* ignore */ }
  if (!dt || isNaN(dt.getTime())) return "";

  // Format as DD MMM in UTC (ignore IST shift)
  const s = dt.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",   // force UTC day, not IST
  });

  return s.replace(/\bSep\b/, "Sept");
}


  return (
    <div className="py-1 px-2  space-y-3 bg-white rounded shadow-md">


      <h2 className="text-2xl font-semibold text-black">{title}</h2>
      {/* Action Buttons */}
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
          disabled={selectedOrders.size !== 1}
          className={`px-3 py-2 rounded text-sm ${selectedOrders.size !== 1
            ? "bg-gray-200 text-gray-500 cursor-not-allowed"
            : "bg-rose-600 text-white hover:bg-rose-700"}`}
        >
          Mark Red
        </button>
      </div>

      {/* Filters */}
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
      {/* Table */}
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
                "Approval Date", "Status", "Print Approval", "Preview", "Cover PDF", "Interior PDF", "Print Status", "Shipped At", "Discount Code", "Feedback Email",
              ].map((heading, i) => (
                <th key={i} className="p-3 whitespace-nowrap">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>

            {currentOrders.map((order, index) => (

              <tr
                key={`${order.orderId}-${index}`}
                className="border-t hover:bg-gray-50"
              >
                <td className="px-2 py-2 ">
                  <input
                    type="checkbox"
                    checked={selectedOrders.has(order.orderId)}
                    onChange={() => handleSelectOrder(order.orderId)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </td>
                <td className="px-2 py-2 text-xs">
                  {order.orderId !== "N/A" ? (
                    <Link href={`/orders/${order.orderId}`} className="text-blue-600 hover:underline">
                      {order.orderId}
                    </Link>
                  ) : <span>N/A</span>}
                </td>

                <td className="px-2 py-2 text-black text-xs">{order.name}</td>
                <td className="px-2 py-2 text-black text-xs">{order.city}</td>
                <td className="px-2 py-2 text-black text-xs">{order.locale}</td>
                <td className="px-2 py-2 text-black text-xs">{order.bookId}</td>
                <td className="px-2 py-2 text-black text-xs">{order.bookStyle}</td>
                <td className="px-2 py-2 text-black text-xs">{getCurrencySymbol(order.currency)}{order.price.toLocaleString("en-IN")}</td>
                <td className="px-2 py-2 text-black text-xs">{order.paymentDate && formatDate(order.paymentDate)}</td>
                <td className="px-2 py-2 text-black text-xs">{order.approvalDate && formatDate(order.approvalDate)}</td>
                <td className="px-2 py-2">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${order.status === "Approved" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}>
                    {order.status}
                  </span>
                </td>
                <td className="px-1 py-2">
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
                <td className="px-1 py-2">{order.previewUrl ? <a href={order.previewUrl} target="_blank" className="text-blue-600 hover:underline">Preview</a> : "-"}</td>
                <td className="px-1 py-2">
                  {order.coverPdf ? (
                    <a href={order.coverPdf} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                      View
                    </a>
                  ) : <span className="text-gray-400">-</span>}
                </td>
                <td className="px-2 py-2">{order.interiorPdf ? <a href={order.interiorPdf} target="_blank" className="text-blue-600 hover:underline">View PDF</a> : "-"}</td>

                <td className="px-2 py-2">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${order.printStatus === "sent_to_printer" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-800"}`}>
                    {order.printStatus === "sent_to_printer" ? "Sent" : "-"}
                  </span>
                </td>
                <td className="px-2 py-2 text-xs">
                  {order.shippedAt && formatDayMonUTC(order.shippedAt)}
                </td>
                <td className="px-2 py-2">
                  {order.discountCode ? (
                    <span className="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
                      {order.discountCode}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-2 py-2">
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

      {/* Progress Tracker */}
      <PrintProgress isVisible={showProgress} results={printResults} />


    </div>
  )

}