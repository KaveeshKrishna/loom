/**
 * DEMO BUILD ONLY — replaces web/app/layout.tsx. Identical to the real
 * root layout, plus one thing: it renders <DemoBootstrap/>, a client
 * component whose only job is importing the demo bootstrap module. This
 * layout has to stay a Server Component (it exports `metadata`, which
 * client components can't do), so the bootstrap import can't be a bare
 * top-level import here directly — anything a Server Component imports is
 * server-only and never reaches the browser at all. Routed through a
 * client component instead, its top-level code still runs during initial
 * script evaluation — before React starts hydrating anything — which
 * guarantees the fetch/XHR shims are installed before any component's
 * first data fetch. See web/lib/demo/DemoBootstrap.tsx and bootstrap.ts.
 *
 * Theme: the real app defaults to the visitor's OS preference. The demo
 * deliberately defaults to dark instead (first impression on a cold login
 * page) regardless of OS preference — still fully overridable, and once a
 * visitor toggles the theme in Settings that choice (stored under
 * 'loom-theme') wins on every later load, same as production.
 */
import { DemoBootstrap } from "@/lib/demo/DemoBootstrap";
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
      <body>
        <DemoBootstrap />
        {children}
      </body>
    </html>
  );
}
