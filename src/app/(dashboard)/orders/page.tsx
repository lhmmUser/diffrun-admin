"use client";

import { useEffect, useState } from "react";
import Link from 'next/link';
import PrintProgress from '../components/PrintProgress';

// Raw structure from API
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
};

type PrinterResponse = {
  order_id: string;
  status: 'success' | 'error' | 'processing';
  message: string;
  step?: string;
  cloudprinter_reference?: string;
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterBookStyle, setFilterBookStyle] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortDir, setSortDir] = useState<string>("desc");
  const [printResults, setPrintResults] = useState<PrinterResponse[]>([]);
  const [showProgress, setShowProgress] = useState(false);
  const [sentFeedbackOrders, setSentFeedbackOrders] = useState<Set<string>>(new Set());
  const [selectedFeedbackOrders, setSelectedFeedbackOrders] = useState<Set<string>>(new Set());

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
        params.append("sort_by", sortBy);
        params.append("sort_dir", sortDir);

        const res = await fetch(`http://127.0.0.1:8000/orders?${params.toString()}`);
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
            approvalDate: formatApprovalDate(order.approved_at) || order.approvalDate || "",
            status: order.status || "",
            bookId: order.bookId || "",
            bookStyle: order.bookStyle || "",
            printStatus: order.printStatus || "",
            feedback_email: order.feedback_email === true

          };
        });

        setOrders(transformed);
      } catch (error) {
        console.error("❌ Failed to fetch orders:", error);
      }
    };

  useEffect(() => {
   

    fetchOrders();
  }, [filterStatus, filterBookStyle, sortBy, sortDir]);

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
        setPrintResults(selectedOrderIds.map(orderId => ({
          order_id: orderId,
          status: 'processing',
          message: 'Waiting to be processed...',
          step: 'queued'
        })));

        const response = await fetch('http://127.0.0.1:8000/orders/approve-printing', {
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

        const ordersRes = await fetch(`http://127.0.0.1:8000/orders?${params.toString()}`);
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
            approvalDate: formatApprovalDate(order.approved_at) || order.approvalDate || "",
            status: order.status || "",
            bookId: order.bookId || "",
            bookStyle: order.bookStyle || "",
            printStatus: order.printStatus || "",
            feedback_email: false
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
    for (let orderId of selectedOrders) {
      const jobId = orders.find(o => o.orderId === orderId)?.jobId;
      if (!jobId) continue;

      const res = await fetch(`http://127.0.0.1:8000/send-feedback-email/${jobId}`, { method: 'POST' });
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
}


  };

  const handleSendFeedback = async (jobId: string) => {
  try {
    const res = await fetch(`http://127.0.0.1:8000/send-feedback-email/${jobId}`, {
      method: 'POST',
    });
    console.log(res);
    if (res.ok) {
      alert(`📬 Feedback email sent for Order ID: ${jobId}`);
      setSentFeedbackOrders(prev => new Set(prev).add(jobId));
    } else {
      const err = await res.json();
      alert(`❌ Failed to send email: ${err.detail}`);
    }
  } catch (err) {
    console.error("Error sending feedback email:", err);
    alert("❌ Something went wrong while sending the email.");
  }
};

const hasSentFeedbackOrders = () => {
  return Array.from(selectedOrders).some(orderId => {
    const order = orders.find(o => o.orderId === orderId);
    return order && sentFeedbackOrders.has(order.jobId);
  });
};



  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">Orders</h2>

      {/* Action Buttons */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => handleAction('approve')}
          disabled={selectedOrders.size === 0 || hasNonApprovedOrders()}
          title={hasNonApprovedOrders() ? "All selected orders must be approved before printing" : ""}
          className={`px-4 py-2 rounded text-sm font-medium ${selectedOrders.size === 0 || hasNonApprovedOrders()
            ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
            : 'bg-green-600 text-white hover:bg-green-700'
            }`}
        >
          Approve Printing
        </button>
        <button
          onClick={() => handleAction('reject')}
          disabled={selectedOrders.size === 0}
          className={`px-4 py-2 rounded text-sm font-medium ${selectedOrders.size === 0
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
          className={`px-4 py-2 rounded text-sm font-medium ${selectedOrders.size === 0 || hasApprovedOrders()
            ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
            : 'bg-yellow-600 text-white hover:bg-yellow-700'
            }`}
        >
          Finalise Book
        </button>
        <button
  onClick={() => handleAction('request_feedback')}
  disabled={selectedOrders.size === 0 || hasSentFeedbackOrders()}
  className={`px-4 py-2 rounded text-sm font-medium ${
    selectedOrders.size === 0 || hasSentFeedbackOrders()
      ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
      : 'bg-indigo-600 text-white hover:bg-indigo-700'
  }`}
>
  Request Feedback
</button>



      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <select
          className="border px-3 py-1 rounded text-sm"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="all">All Statuses</option>
          <option value="approved">Approved</option>
          <option value="uploaded">Uploaded</option>
        </select>

        <select
          className="border px-3 py-1 rounded text-sm"
          value={filterBookStyle}
          onChange={(e) => setFilterBookStyle(e.target.value)}
        >
          <option value="all">All Book Styles</option>
          <option value="paperback">Paperback</option>
          <option value="hardcover">Hardcover</option>
        </select>

        <select
          className="border px-3 py-1 rounded text-sm"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="created_at">Sort by: Created At</option>
          <option value="name">Sort by: Name</option>
          <option value="city">Sort by: City</option>
        </select>

        <select
          className="border px-3 py-1 rounded text-sm"
          value={sortDir}
          onChange={(e) => setSortDir(e.target.value)}
        >
          <option value="desc">↓ Descending</option>
          <option value="asc">↑ Ascending</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto bg-white rounded shadow overflow-visible relative">
        <table className="min-w-full table-auto text-sm text-left">
          <thead className="bg-gray-100 text-gray-700 font-semibold">
            <tr>
              <th className="p-3">
                <input
                  type="checkbox"
                  checked={selectedOrders.size === orders.length && orders.length > 0}
                  onChange={handleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="p-3">Order ID</th>
              <th className="p-3">Cover PDF</th>
              <th className="p-3">Interior PDF</th>
              <th className="p-3">Preview</th>
              <th className="p-3">Name</th>
              <th className="p-3">City</th>
              <th className="p-3">Book ID</th>
              <th className="p-3">Book Style</th>
              <th className="p-3">Price</th>
              <th className="p-3">Payment Date</th>
              <th className="p-3">Approval Date</th>
              <th className="p-3">Status</th>
              <th className="p-3">Print Status</th>
              <th className="p-3">Feedback Email</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order, index) => (
              <tr
                key={`${order.orderId}-${index}`}
                className="border-t hover:bg-gray-50"
              >
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={selectedOrders.has(order.orderId)}
                    onChange={() => handleSelectOrder(order.orderId)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </td>
                <td className="p-3">
                  {order.orderId !== "N/A" ? (
                    <Link
                      href={`/orders/${order.orderId}`}
                      className="text-blue-600 hover:underline"
                    >
                      {order.orderId}
                    </Link>
                  ) : (
                    <span>N/A</span>
                  )}
                </td>
                <td className="p-3">
                  {order.coverPdf ? (
                    <a
                      href={order.coverPdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline flex items-center gap-1"
                    >
                      <span>View</span>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="p-3">
                  {order.interiorPdf && (
                    <a
                      href={order.interiorPdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800"
                    >
                      View PDF
                    </a>
                  )}
                </td>
                <td className="p-3">
                  {order.previewUrl && (
                    <a
                      href={order.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800"
                    >
                      Preview Book
                    </a>
                  )}
                </td>
                <td className="p-3">{order.name}</td>
                <td className="p-3">{order.city}</td>
                <td className="p-3">{order.bookId}</td>
                <td className="p-3">{order.bookStyle}</td>
                <td className="p-3">₹{order.price.toLocaleString('en-IN')}</td>
                <td className="p-3">{order.paymentDate}</td>
                <td className="p-3">{order.approvalDate}</td>
                <td className="p-3">
                  <span className={`px-2 py-1 rounded text-xs ${order.status === "Approved"
                    ? "bg-green-100 text-green-800"
                    : "bg-yellow-100 text-yellow-800"
                    }`}>
                    {order.status}
                  </span>
                </td>
                <td className="p-3">
                  <span className={`px-2 py-1 rounded text-xs ${order.printStatus === "sent_to_printer"
                    ? "bg-blue-100 text-blue-800"
                    : "bg-gray-100 text-gray-800"
                    }`}>
                    {order.printStatus ? order.printStatus.replace(/_/g, " ").toUpperCase() : "-"}
                  </span>
                </td>
                <td className="p-3">
                  <span className={`px-2 py-1 rounded text-xs ${order.feedback_email
                    ? "bg-green-100 text-green-800"
                    : "bg-gray-100 text-gray-800"
                    }`}>
                    {order.feedback_email ? "Sent Feedback Email" : "-"}
                    
                  </span>
                </td>


              </tr>
            ))}
            
          </tbody>
        </table>
      </div>

      {/* Add PrintProgress component at the end */}
      <PrintProgress isVisible={showProgress} results={printResults} />
    </div>
  );
}
