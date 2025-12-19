"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
    partial_preview?: string;
    final_preview?: string;
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
    partialPreview: string;
    finalPreview: string;
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
    const [searchJobId, setSearchJobId] = useState("");
    const [search, setSearch] = useState("");
    const [totalJobs, setTotalJobs] = useState(0);
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && search.trim() !== "") {
            router.push(`/jobs/job-detail?job_id=${encodeURIComponent(search.trim())}`);
        }
    };

    useEffect(() => {
        const calculateItemsPerPage = () => {
            const windowHeight = window.innerHeight;
            const headerHeight = 200;
            const footerHeight = 80;
            const rowHeight = 45;
            const usableHeight = windowHeight - headerHeight;
            const visibleRows = Math.floor(usableHeight / rowHeight);
            setItemsPerPage(Math.max(4, visibleRows));
        };

        calculateItemsPerPage();
        window.addEventListener("resize", calculateItemsPerPage);
        return () => window.removeEventListener("resize", calculateItemsPerPage);
    }, []);

    // Reset to page 1 when filters or search change
    useEffect(() => {
        setCurrentPage(1);
    }, [filterBookStyle, searchJobId, sortBy, sortDir]);

    const fetchOrders = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (filterBookStyle !== "all") params.append("filter_book_style", filterBookStyle);
            params.append("sort_by", sortBy);
            params.append("sort_dir", sortDir);
            
            // Server-side pagination and search
            params.append("page", currentPage.toString());
            params.append("limit", itemsPerPage.toString());
            if (searchJobId.trim() !== "") params.append("q", searchJobId.trim());

            const res = await fetch(`${baseUrl}/jobs?${params.toString()}`);
            console.log('Fetching jobs from:', `${baseUrl}/jobs?${params.toString()}`);
            
            if (!res.ok) {
                throw new Error(`Failed to fetch jobs: ${res.status}`);
            }
            
            const data = await res.json();
            const rawData: RawOrder[] = data.jobs; // Extract from data.jobs

            // Transform the data to match our Order type
            const transformed: Order[] = rawData.map(order => ({
                orderId: order.order_id || "N/A",
                jobId: order.job_id || "N/A",
                previewUrl: order.previewUrl || "",
                bookId: order.bookId || order.book_id || "N/A",
                createdAt: order.createdAt || "",
                name: order.name || "",
                paymentDate: formatDate(order.processed_at) || order.paymentDate || "",
                approvalDate: order.approvalDate || "",
                locale: order.locale || "",
                partialPreview: (order.partial_preview ?? "").toString(),
                finalPreview: (order.final_preview ?? "").toString(),
            }));

            console.log("Transformed orders:", transformed);
            setOrders(transformed);
            setTotalJobs(data.pagination.total); // Set total count
        } catch (error) {
            console.error("Failed to fetch orders:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchOrders();
    }, [filterBookStyle, sortBy, sortDir, currentPage, itemsPerPage, searchJobId]);

    // Use server-side pagination
    const totalPages = Math.ceil(totalJobs / itemsPerPage);
    const currentOrders = orders; // orders now contains only current page data

    const openJobDetail = (jobId: string) => {
        router.push(`/jobs/job-detail?job_id=${encodeURIComponent(jobId)}`, {
            scroll: false,
        });
    }

    return (
        <div className="px-4 py-2 space-y-3">
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

            {/* Search bar */}
            <div className="relative">
                <input 
                    type="text"
                    value={searchJobId}
                    onChange={(e) => setSearchJobId(e.target.value)}
                    placeholder="Search by Job ID, Order ID, Name, or Book ID..."
                    className="sm:w-72 rounded border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" 
                />
                {searchJobId && (
                    <button
                        type="button"
                        onClick={() => setSearchJobId("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs"
                        aria-label="Clear search"
                    >
                        ✕
                    </button>
                )}
            </div>

            <div className="relative">
                <input 
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={handleSearch}
                    placeholder="Quick jump to job detail (Enter to search)..."
                    className="sm:w-72 rounded border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" 
                />
                {search && (
                    <button
                        type="button"
                        onClick={() => setSearch("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs"
                        aria-label="Clear quick search"
                    >
                        ✕
                    </button>
                )}
            </div>

            {/* Table */}
            <div className="overflow-x-auto bg-white rounded shadow overflow-visible relative">
                <table className="min-w-full table-auto text-sm text-left">
                    <thead className="bg-gray-200 text-gray-700 font-medium">
                        <tr>
                            <th className="p-3">Job ID</th>
                            <th className="p-3">Preview URL</th>
                            <th className="p-3">Book ID</th>
                            <th className="p-3">Loc</th>
                            <th className="p-3">Created At</th>
                            <th className="p-3">Name</th>
                            <th className="p-3">Paid</th>
                            <th className="p-3">Approved</th>
                            <th className="p-3">Partial Preview</th>
                            <th className="p-3">PP Ins</th>
                            <th className="p-3">Final Preview</th>
                            <th className="p-3">FP Ins</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr>
                                <td colSpan={10} className="p-3 text-center text-gray-500">
                                    Loading jobs...
                                </td>
                            </tr>
                        ) : currentOrders.length === 0 ? (
                            <tr>
                                <td colSpan={10} className="p-3 text-center text-gray-500">
                                    {searchJobId ? "No jobs found matching your search" : "No jobs found"}
                                </td>
                            </tr>
                        ) : (
                            currentOrders.map((order) => (
                                <tr
                                    key={order.jobId}
                                    className="border-t hover:bg-gray-50"
                                >
                                    <td className="p-3">
                                        <button 
                                            className="text-blue-600 hover:text-blue-800 hover:cursor-pointer" 
                                            onClick={() => openJobDetail(order.jobId)}
                                        >
                                            {order.jobId}
                                        </button>
                                    </td>

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
                                    <td className="p-3 text-black">{order.partialPreview || "-"}</td>
                                    <td className="p-3 text-black">{order.finalPreview || "-"}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            <div className="flex justify-center items-center gap-2 py-4">
                <button
                    onClick={() => setCurrentPage(p => Math.max(p - 1, 1))}
                    disabled={currentPage === 1 || loading}
                    className="px-3 py-1 rounded border bg-white text-sm disabled:opacity-50 text-black"
                >
                    Prev
                </button>

                {currentPage > 2 && (
                    <>
                        <button
                            onClick={() => setCurrentPage(1)}
                            disabled={loading}
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
                            disabled={loading}
                            className={`px-3 py-1 rounded border text-sm ${currentPage === page ? "bg-blue-600 text-white" : "bg-white text-gray-800"}`}
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
                            disabled={loading}
                            className={`px-3 py-1 rounded border text-sm ${currentPage === totalPages ? "bg-blue-600 text-white" : "bg-white text-gray-800"}`}
                        >
                            {totalPages}
                        </button>
                    </>
                )}

                <button
                    onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))}
                    disabled={currentPage === totalPages || loading}
                    className="px-3 py-1 rounded border bg-white text-sm disabled:opacity-50 text-black"
                >
                    Next
                </button>
            </div>
        </div>
    );
}