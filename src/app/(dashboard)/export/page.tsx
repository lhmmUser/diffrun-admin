'use client';

import React from 'react';

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';

const Export = () => {
  const handleDownload = async () => {
    try {
      const response = await fetch(`${baseUrl}/export-orders-csv`);
      if (!response.ok) throw new Error('Failed to download');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'orders_export.csv';
      document.body.appendChild(a); 
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('❌ Error downloading file:', err);
      alert('Download failed. Please try again.');
    }
  };

  return (
    <div className="min-h-screen bg-white px-2 py-2 md:px-6 md:py-8">
  
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">Analysis Report Download</h1>
        <p className="text-gray-600 mt-2 text-sm sm:text-base">
          Export your order data as a CSV file for further analysis.
        </p>
      </header>

      <button
        onClick={handleDownload}
        className="group flex items-center gap-2 bg-[#6694cd] text-white font-medium py-3 px-6 rounded-lg shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
      >
        📥 Download CSV
      </button>
    </div>
  );
};

export default Export;