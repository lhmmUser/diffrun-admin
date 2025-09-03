'use client';

import React, { useState } from 'react';

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

const DarkFantasyDownload = () => {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const MIN_DATE = '2025-05-26';
  const todayIST = new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });

  const handleDownload = async () => {
  if (!fromDate || !toDate) {
    alert("Please select both From and To dates");
    return;
  }

  try {
    const response = await fetch(
      `${baseUrl}/download-csv?from_date=${fromDate}&to_date=${toDate}`
    );

    if (!response.ok) throw new Error('Failed to download');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);

    // ✅ Create dynamic filename
    const filename = `darkfantasy_${fromDate}_to_${toDate}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    // Clean up
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error('❌ Error downloading file:', err);
    alert('Download failed.');
  }
};


  return (
    <div className="min-h-screen bg-gray-100 px-4 py-10 flex flex-col items-center justify-center">
      <h1 className="text-3xl font-bold text-gray-800 mb-6">Download DarkFantasy Orders</h1>

      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div>
          <label className="block text-gray-700 mb-1">From Date</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            min={MIN_DATE}
            max={todayIST}
            className="border rounded px-3 py-2"
          />

        </div>
        <div>
          <label className="block text-gray-700 mb-1">To Date</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            min={MIN_DATE}
            max={todayIST}
            className="border rounded px-3 py-2"
          />
        </div>
      </div>

      <button
        onClick={handleDownload}
        className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg shadow-md transition duration-300"
      >
        Download CSV
      </button>
      <button
  onClick={async () => {
    if (!fromDate || !toDate) { alert("Please select both From and To dates"); return; }
    if (new Date(fromDate) > new Date(toDate)) { alert("From Date cannot be after To Date"); return; }

    const res = await fetch(`${baseUrl}/download-xlsx?from_date=${fromDate}&to_date=${toDate}`);
    if (!res.ok) { alert("Failed to download"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `darkfantasy_${fromDate}_to_${toDate}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }}
  className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 my-2 py-3 rounded-lg shadow-md transition duration-300"
>
  Download XLSX (with Pivot)
</button>
    </div>
  );
};

export default DarkFantasyDownload;
