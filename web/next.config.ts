import type { NextConfig } from "next";

// The public demo build (see loom-demo/build.sh) sets NEXT_PUBLIC_DEMO_MODE=1
// and needs a fully static export — no server at runtime at all. The real
// Docker image never sets this, so production is unaffected.
const isDemoBuild = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

// Applied to every response.
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: isDemoBuild ? "export" : "standalone",
  serverExternalPackages: ["sharp", "@prisma/client", "bcryptjs", "pg"],
  poweredByHeader: false,
  images: {
    unoptimized: true,
  },
  ...(isDemoBuild
    ? {}
    : {
        async headers() {
          return [
            { source: "/:path*", headers: securityHeaders },
            {
              // App pages may only be framed by Loom itself (its own PDF/text
              // viewers). File-serving routes set their own, stricter
              // sandboxing CSP (lib/send-file.ts), so they're excluded here.
              source: "/((?!api/files/serve|api/cache|api/share).*)",
              headers: [
                {
                  key: "Content-Security-Policy",
                  value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'",
                },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
