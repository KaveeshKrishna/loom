/**
 * Runs once when the server starts. Cleans up after an interrupted shutdown
 * (power cut, crash) before any request is served — see lib/recovery.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverOnStartup } = await import("./lib/recovery");
    await recoverOnStartup().catch((err) => console.error("[recovery] failed:", err));
  }
}
