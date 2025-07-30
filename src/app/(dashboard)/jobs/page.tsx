"use client";

import { useEffect, useState } from "react";

// Types for the API response
type RawOrder = {
    order_id: string;
    job_id: string;
    previewUrl: string;
    bookId?: string;
    book_id?: string;
    createdAt?: string;
    created_at?: any;
    name?: string;
    processed_at?: any;
    paymentDate?: string;
    approvalDate?: string;
    locale?: string;
};

type Order = {
    orderId: string;
    jobId: string;
    previewUrl: string;
    bookId: string;
    createdAt: string;
    name: string;
    paymentDate: string;
    approvalDate: string;
    locale: string; 
};

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

export default function JobsPage() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [filterBookStyle, setFilterBookStyle] = useState<string>("all");
    const [sortBy, setSortBy] = useState<string>("created_at");
    const [sortDir, setSortDir] = useState<string>("desc");
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "";
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(12);

    useEffect(() => {
        const calculateItemsPerPage = () => {
            const windowHeight = window.innerHeight;
            const headerHeight = 200;
            const footerHeight = 80;
            const rowHeight = 45;
            const usableHeight = windowHeight - headerHeight ;
            const visibleRows = Math.floor(usableHeight / rowHeight);
            setItemsPerPage(Math.max(4, visibleRows));
        };

        calculateItemsPerPage();
        window.addEventListener("resize", calculateItemsPerPage);
        return () => window.removeEventListener("resize", calculateItemsPerPage);
    }, []);
    
    useEffect(() => {
        const fetchOrders = async () => {
            try {
                const params = new URLSearchParams();
                if (filterBookStyle !== "all") params.append("filter_book_style", filterBookStyle);
                params.append("sort_by", sortBy);
                params.append("sort_dir", sortDir);

                const res = await fetch(`${baseUrl}/jobs?${params.toString()}`);
                console.log(baseUrl,'baseUrl');
                const rawData: RawOrder[] = await res.json();

                // Transform the data to match our Order type
                const transformed: Order[] = rawData.map(order => ({
                    orderId: order.order_id || "N/A",
                    jobId: order.job_id || "N/A",
                    previewUrl: order.previewUrl || "",
                    bookId: order.bookId || "N/A",
                    createdAt: order.createdAt || "",
                    name: order.name || "",
                    paymentDate: formatDate(order.processed_at) || order.paymentDate || "",
                    approvalDate: order.approvalDate || "",
                    locale: order.locale || "",
                }));

                console.log("Transformed orders:", transformed); // Debug log
                setOrders(transformed);
            } catch (error) {
                console.error("Failed to fetch orders:", error);
            }
        };

        fetchOrders();
    }, [filterBookStyle, sortBy, sortDir]);

    const totalPages = Math.ceil(orders.length / itemsPerPage);
    const startIdx = (currentPage - 1) * itemsPerPage;
    const currentOrders = orders.slice(startIdx, startIdx + itemsPerPage);

    return (
        <div>
            <h2 className="text-2xl font-semibold mb-4 text-black">Jobs</h2>

            {/* Filters */}
            <div className="flex gap-4 mb-6">
                <select
                    className="border px-3 py-1 rounded text-sm text-black"
                    value={filterBookStyle}
                    onChange={(e) => setFilterBookStyle(e.target.value)}
                >
                    <option value="all">All Book Types</option>
                    <option value="wigu">WIGU</option>
                    <option value="astro">Astro</option>
                    <option value="abcd">ABCD</option>
                </select>

                <select
                    className="border px-3 py-1 rounded text-sm text-black"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                >
                    <option value="created_at">Sort by: Created At</option>
                    <option value="book_id">Sort by: Book Type</option>
                </select>

                <select
                    className="border px-3 py-1 rounded text-sm text-black"
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
                            <th className="p-3">Job ID</th>
                            <th className="p-3">Preview URL</th>
                            <th className="p-3">Book ID</th>
                            <th className="p-3">Loc</th>
                            <th className="p-3">Created At</th>
                            <th className="p-3">Name</th>
                            <th className="p-3">Paid</th>
                            <th className="p-3">Approved</th>
                        </tr>
                    </thead>
                    <tbody>
                        {currentOrders.map((order) => (
                            <tr
                                key={order.jobId}
                                className="border-t hover:bg-gray-50"
                            >
                                <td className="p-3 text-black">{order.jobId}</td>
                                <td className="p-3">
                                    {order.previewUrl ? (
                                        <a
                                            href={order.previewUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-600 hover:text-blue-800"
                                        >
                                            Preview Book
                                        </a>
                                    ) : (
                                        <span className="text-gray-400">-</span>
                                    )}
                                </td>
                                <td className="p-3 text-black">{order.bookId}</td>
                                <td className="p-3 text-black">{order.locale}</td>
                                <td className="p-3 text-black">{order.createdAt}</td>
                                <td className="p-3 text-black">{order.name}</td>
                                <td className="p-3">
                                    <span className={`px-2 py-1 rounded text-xs ${order.paymentDate ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                        {order.paymentDate ? 'Yes' : 'No'}
                                    </span>
                                </td>
                                <td className="p-3">
                                    <span className={`px-2 py-1 rounded text-xs ${order.approvalDate ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                        {order.approvalDate ? 'Yes' : 'No'}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                </div>
                 {/* Pagination */}
            <div className="flex justify-center items-center gap-2 py-4">
                <button
                    onClick={() => setCurrentPage(p => Math.max(p - 1, 1))}
                    disabled={currentPage === 1}
                    className="px-3 py-1 rounded border bg-white text-sm disabled:opacity-50 text-black"
                >
                    Prev
                </button>

                {currentPage > 2 && (
                    <>
                        <button
                            onClick={() => setCurrentPage(1)}
                            className={`px-3 py-1 rounded border text-sm ${currentPage === 1 ? "bg-blue-600 text-white" : "bg-white"}`}
                        >
                            1
                        </button>
                        {currentPage > 3 && <span className="px-2 text-sm text-gray-500">...</span>}
                    </>
                )}

                {[-1, 0, 1].map(offset => {
                    const page = currentPage + offset;
                    if (page < 1 || page > totalPages) return null;
                    return (
                        <button
                            key={page}
                            onClick={() => setCurrentPage(page)}
                            className={`px-3 py-1 rounded border text-sm ${currentPage === page ? "bg-blue-600 text-white" : "bg-white"}`}
                        >
                            {page}
                        </button>
                    );
                })}

                {currentPage < totalPages - 1 && (
                    <>
                        {currentPage < totalPages - 2 && <span className="px-2 text-sm text-gray-500">...</span>}
                        <button
                            onClick={() => setCurrentPage(totalPages)}
                            className={`px-3 py-1 rounded border text-sm ${currentPage === totalPages ? "bg-blue-600 text-white" : "bg-white"}`}
                        >
                            {totalPages}
                        </button>
                    </>
                )}

                <button
                    onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))}
                    disabled={currentPage === totalPages}
                    className="px-3 py-1 rounded border bg-white text-sm disabled:opacity-50 text-black"
                >
                    Next
                </button>
            </div>
        </div>
    );
}