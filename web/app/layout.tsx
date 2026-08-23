import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loom — Weaving your digital life together",
  description:
    "Loom is a premium, self-hosted personal storage application. Browse, search, and stream your files from anywhere.",
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
                  if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
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
