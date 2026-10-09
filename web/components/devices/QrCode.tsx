"use client";

/** A QR code as a crisp, theme-independent SVG (dark modules on white, quiet zone included). */

import { useMemo } from "react";
import qrcode from "qrcode-generator";

export function QrCode({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        // Merge horizontal runs into one rect-like path segment.
        let run = 1;
        while (c + run < n && qr.isDark(r, c + run)) run++;
        d += `M${c + 4} ${r + 4}h${run}v1h-${run}z`;
        c += run - 1;
      }
    }
    return { path: d, count: n + 8 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      className="rounded-lg"
    >
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#111827" />
    </svg>
  );
}
