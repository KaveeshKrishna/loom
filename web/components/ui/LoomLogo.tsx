/**
 * Loom's mark: warp and weft threads woven over and under (brand/mark.py
 * draws the same shapes for every icon). A rounded blue tile by default.
 */

const BLUE = "#1A5FF0";
const PIECES: [number, number, number, number, "warp" | "weft"][] = [
  [374, 214, 276, 136, "weft"],
  [214, 444, 206, 136, "weft"],
  [604, 444, 206, 136, "weft"],
  [374, 674, 276, 136, "weft"],
  [214, 214, 136, 206, "warp"],
  [214, 604, 136, 206, "warp"],
  [444, 374, 136, 276, "warp"],
  [674, 214, 136, 206, "warp"],
  [674, 604, 136, 206, "warp"],
];

export function LoomLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" className={className} aria-hidden focusable="false">
      <rect width="1024" height="1024" rx="230" fill={BLUE} />
      {PIECES.map(([x, y, w, h, kind]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx="12" fill={kind === "warp" ? "#B5CBFF" : "#FFFFFF"} />
      ))}
    </svg>
  );
}
