"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, Clock, Star, Image, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/recent", label: "Recent", icon: Clock },
  { href: "/favorites", label: "Favorites", icon: Star },
  { href: "/photos", label: "Photos", icon: Image },
];

export function MobileNav({ isOwner }: { isOwner: boolean }) {
  const pathname = usePathname();

  const items = isOwner
    ? [...navItems, { href: "/settings", label: "Settings", icon: Settings }]
    : navItems;

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[hsl(var(--background)/0.95)] backdrop-blur-sm border-t safe-area-pb">
      <div className="flex items-center justify-around h-16 px-2">
        {items.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/files"
              ? pathname === "/files" || pathname.startsWith("/files/")
              : pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all",
                active
                  ? "text-[hsl(var(--primary))]"
                  : "text-[hsl(var(--muted-foreground))]"
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.5 : 2} />
              <span className="text-[10px] font-medium">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
