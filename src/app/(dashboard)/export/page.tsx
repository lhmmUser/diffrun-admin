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
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('❌ Error downloading file:', err);
      alert('Download failed.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-10 flex flex-col items-center mx-auto">
      <h1 className="text-lg sm:text-2xl md:text-4xl font-bold text-center text-gray-800 mb-8">Analysis Report Download</h1>
      <button
        onClick={handleDownload}
        className="bg-indigo-400 hover:bg-indigo-500 text-white font-medium py-3 px-6 rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
      >
        Download CSV
      </button>
    </div>
  );
};

export default Export;