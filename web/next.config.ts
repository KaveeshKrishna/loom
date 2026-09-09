import type { NextConfig } from "next";

// The public demo build (see loom-demo/build.sh) sets NEXT_PUBLIC_DEMO_MODE=1
// and needs a fully static export — no server at runtime at all. The real
// Docker image never sets this, so production is unaffected.
const isDemoBuild = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

const nextConfig: NextConfig = {
  output: isDemoBuild ? "export" : "standalone",
  serverExternalPackages: ["sharp", "@prisma/client", "bcryptjs"],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
