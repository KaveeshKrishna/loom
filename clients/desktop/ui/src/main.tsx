/**
 * One bundle, several windows: the window's address picks the screen
 * (#/transfers, #/settings, #/onboarding, #/destination).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TransfersWindow } from "./views/Transfers";
import { Onboarding } from "./views/Onboarding";
import { Destination } from "./views/Destination";

function Screen() {
  const route = location.hash.replace(/^#\/?/, "").split("?")[0];
  if (route.startsWith("onboarding")) return <Onboarding />;
  if (route.startsWith("destination")) return <Destination />;
  return <TransfersWindow />;
}

// No browser context menu or reload shortcuts: this is an app, not a page.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .selectable")) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Screen />
  </StrictMode>
);
