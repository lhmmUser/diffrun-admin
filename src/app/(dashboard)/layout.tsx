"use client";
import { useState } from 'react';
import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ClerkProvider, SignedIn, SignedOut, RedirectToSignIn } from '@clerk/nextjs';
import Link from 'next/link';
import { HiMenu, HiX } from "react-icons/hi";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    return (
   <>
      <SignedIn>
        {/* Mobile navbar */}
        <div className="md:hidden flex justify-between items-center bg-gray-900 text-white p-4">
          <h1 className="text-lg font-bold">Diffrun Admin</h1>
          <button onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? <HiX className="h-6 w-6" /> : <HiMenu className="h-6 w-6" />}
          </button>
        </div>

        <div className="flex min-h-screen">
          {/* Sidebar */}
          <aside
            style={{ backgroundColor: "#5784ba" }}
            className={` text-white w-60 p-6 fixed top-0 left-0 h-screen z-50 transform md:translate-x-0 transition-transform duration-200 ease-in-out
              ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} md:relative md:block`}
          >
            <div className="mb-8 pt-4">
              <h2 className="text-xl font-bold mb-2 ">Diffrun Admin</h2>
              <p className="text-sm text-white">Manage your books</p>
            </div>
            <nav>
              <ul className="space-y-2">
                <li>
                  <Link href="/dashboard" className="block px-3 py-2 rounded hover:bg-gray-800 hover:text-blue-300 font-bold">Dashboard</Link>
                </li>
                <li>
                  <Link href="/orders" className="block px-3 py-2 rounded hover:bg-gray-800 hover:text-blue-300 font-bold">Orders</Link>
                </li>
                <li>
                  <Link href="/jobs" className="block px-3 py-2 rounded hover:bg-gray-800 hover:text-blue-300 font-bold">Jobs</Link>
                </li>
              </ul>
            </nav>
          </aside>

          {/* Main content wrapper with left margin */}
         <main
  className={`flex-1 bg-gray-50 overflow-y-auto p-4 md:p-2 min-h-screen transition-all duration-300 ${
    sidebarOpen ? "md:ml-64" : "ml-0"
  }`}
>
  {children}
</main>

        </div>
      </SignedIn>

      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}
