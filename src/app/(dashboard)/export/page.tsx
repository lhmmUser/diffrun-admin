'use client';

import React from 'react';

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';

const Export = () => {
  // --- existing download function ---
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

  // --- NEW filtered download function ---
  const handleDownloadFiltered = async () => {
    try {
      // Choose which fields you want
      const fields = [
        'email',
        'order_id',
        'phone_number',
        'age',
        'book_id',
        'book_style',
        'total_price',
        'gender',
        'paid',
        'approved',

        'created_date',
        'created_time',
        'creation_hour',
        'payment_date',
        'payment_time',
        'payment_hour',

        'locale',
        'name',
        'user_name',

        // shipping fields
        'shipping_address.city',
        'shipping_address.province',
        'shipping_address.zip',

        // ADDING THESE:
        'discount_code',
        'paypal_capture_id',
        'transaction_id',
        'tracking_code',
        'partial_preview',
        'final_preview',
        'cust_status',
        'printer'
      ].join(',');


      const params = new URLSearchParams({
        paid: 'true',       // your required filter
        fields: fields,     // selected columns
      });

      const response = await fetch(
        `${baseUrl}/export-orders-filtered-csv?${params.toString()}`
      );
      if (!response.ok) throw new Error('Failed to download');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'orders_filtered_export.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('❌ Error downloading filtered file:', err);
      alert('Filtered download failed. Please try again.');
    }
  };

  return (
    <div className="min-h-screen px-4 py-2">

      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">Analysis Report Download</h1>
        <p className="text-gray-600 mt-2 text-sm sm:text-base">
          Export your order data as a CSV file for further analysis.
        </p>
      </header>

      {/* Existing button */}
      <button
        onClick={handleDownload}
        className="group flex items-center gap-2 bg-[#6694cd] text-white font-medium py-3 px-6 rounded-lg shadow-sm mb-4"
      >
        📥 Download CSV
      </button>

      {/* NEW filtered button */}
      <button
        onClick={handleDownloadFiltered}
        className="group flex items-center gap-2 bg-green-600 text-white font-medium py-3 px-6 rounded-lg shadow-sm"
      >
        🔍 Download Filtered CSV
      </button>
    </div>
  );
};

export default Export;
