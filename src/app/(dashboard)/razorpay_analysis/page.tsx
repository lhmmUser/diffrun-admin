// src/app/(dashboard)/razorpay_analysis/page.tsx
// Server component that renders client components

import ReconcileUploader from "../components/ReconcileUploader";

import RazorpaySimpleDownloader from "../components/RazorpayExporter";

export const metadata = {
  title: "Razorpay ↔ Orders VLOOKUP (NA IDs)",
};

export default function RazorpayAnalysisPage() {
  return (
    <main className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-2">
        Razorpay → Orders VLOOKUP (Return #N/A Payment IDs)
      </h1>

      <p className="text-sm text-gray-600 mb-6">
        Upload the <strong>Orders CSV</strong> (must include{" "}
        <code>transaction_id</code> and <code>order_id</code>) and the{" "}
        <strong>Razorpay Payments CSV</strong> (must include{" "}
        <code>id</code> and <code>status</code>). This tool matches{" "}
        <code>Razorpay.id</code> ↔ <code>Orders.transaction_id</code>, and lists
        the Razorpay <code>id</code>s that would VLOOKUP to <code>#N/A</code>.
      </p>

      {/* Existing NA IDs tool */}
      <ReconcileUploader />

      <hr className="my-8" />

      {/* New CSV export tool */}
      <section>
       <hr className="my-8" />
      <h2 className="text-xl font-semibold mb-2">Direct Razorpay Export</h2>
      <RazorpaySimpleDownloader />
      </section>
    </main>
  );
}
