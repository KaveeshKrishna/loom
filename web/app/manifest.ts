import type { MetadataRoute } from "next";

// Lets phones add Loom to the home screen with its own icon and name.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Loom",
    short_name: "Loom",
    description: "Your files, woven together.",
    start_url: "/files",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1A5FF0",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
