/**
 * DEMO BUILD ONLY — replaces web/app/layout.tsx. Identical to the real
 * root layout, plus one line: a static top-level import of the demo
 * bootstrap module. Because that's a plain ES module import (not a
 * useEffect/dynamic import), its top-level code runs during initial script
 * evaluation — before React starts rendering or hydrating anything — which
 * guarantees the fetch/XHR shims are installed before any component's
 * first data fetch. See web/lib/demo/bootstrap.ts.
 *
 * Theme: the real app defaults to the visitor's OS preference. The demo
 * deliberately defaults to dark instead (first impression on a cold login
 * page) regardless of OS preference — still fully overridable, and once a
 * visitor toggles the theme in Settings that choice (stored under
 * 'loom-theme') wins on every later load, same as production.
 */
import "@/lib/demo/bootstrap";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loom — Interactive Demo",
  description: "A fully fabricated, backend-less public demo of Loom.",
  robots: "noindex, nofollow",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var t = localStorage.getItem('loom-theme');
                  if (t !== 'light') {
                    document.documentElement.classList.add('dark');
                  }
                  var s = localStorage.getItem('loom-sidebar');
                  if (s === 'false') {
                    document.documentElement.classList.add('sidebar-collapsed');
                  }
                } catch(e) {}
              })();
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
