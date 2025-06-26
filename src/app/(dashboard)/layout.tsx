import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ClerkProvider, SignedIn, SignedOut, RedirectToSignIn } from '@clerk/nextjs';
import Link from 'next/link';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Diffrun Admin Dashboard',
  description: 'Manage orders, approvals, and admin workflows.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={inter.className}>
          {/* If signed in, show admin layout */}
          <SignedIn>
            <div className="flex min-h-screen">
              {/* Sidebar */}
              <aside className="w-64 bg-gray-900 text-white p-6">
                <h1 className="text-xl font-bold mb-6">Diffrun Admin</h1>
                <nav>
                  <ul className="space-y-4">
                    <li>
                      <Link href="/dashboard" className="block hover:text-blue-300">
                        Dashboard
                      </Link>
                    </li>
                    <li>
                      <Link href="/orders" className="block hover:text-blue-300">
                        Orders
                      </Link>
                    </li>
                    <li>
                      <Link href="/jobs" className="block hover:text-blue-300">
                        Jobs
                      </Link>
                    </li>
                  </ul>
                </nav>
              </aside>

              {/* Main content */}
              <main className="flex-1 bg-gray-50 p-6">
                {children}
              </main>
            </div>
          </SignedIn>

          {/* If not signed in, redirect to sign-in */}
          <SignedOut>
            <RedirectToSignIn />
          </SignedOut>
        </body>
      </html>
    </ClerkProvider>
  );
}
