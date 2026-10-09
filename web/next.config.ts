import type { NextConfig } from "next";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * An id for this build of the code: a hash of the source, so every build
 * worker computes the same one and it only changes when the code does. The
 * page compares its own with /api/health's after reconnecting, and reloads
 * itself after Loom was updated (instead of running stale code against a
 * new server).
 */
function sourceHash(): string {
  const h = crypto.createHash("sha256");
  const visit = (rel: string) => {
    const full = path.join(process.cwd(), rel);
    if (!fs.existsSync(full)) return;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (/(^|\/)(node_modules|\.next)$/.test(rel)) return;
      for (const name of fs.readdirSync(full).sort()) visit(path.join(rel, name));
    } else if (/\.(tsx?|css|json|prisma|mjs)$/.test(rel)) {
      h.update(rel).update(fs.readFileSync(full));
    }
  };
  for (const dir of ["app", "components", "lib", "prisma", "public", "package-lock.json", "next.config.ts"]) visit(dir);
  return h.digest("hex").slice(0, 16);
}
const buildId = process.env.LOOM_BUILD_ID || sourceHash();

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
  generateBuildId: async () => buildId,
  env: { NEXT_PUBLIC_LOOM_BUILD: buildId },
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
