export default function UnauthorizedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>{children}</> // ✅ No <html> or <body>
  );
}
