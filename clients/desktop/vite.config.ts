import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The app's own screens (Transfers, Settings, sign-in, folder picker).
// `VITE_MOCK=1 npm run dev` runs them in a browser with a fake backend.
export default defineConfig({
  root: "ui",
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "../dist", emptyOutDir: true, target: "chrome120" },
});
