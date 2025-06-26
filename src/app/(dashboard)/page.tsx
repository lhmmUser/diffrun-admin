'use client';

import { SignIn } from '@clerk/nextjs';

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignIn
        path="/"
        routing="path"
        signUpUrl="/unauthorized" // prevent open signups
        afterSignInUrl="/dashboard" // redirect on success
      />
    </div>
  );
}
