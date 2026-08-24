"use client";
import React from "react";
import { cn } from "@/lib/utils";
import { useTopBar } from "@/components/layout/TopBarContext";

// ── Grid Skeleton ─────────────────────────────────────────────────────────────

const gridClasses: Record<string, string> = {
  sm: "grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-9 2xl:grid-cols-11",
  md: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8",
  lg: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
  xl: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
};

function GridSkeletonCard() {
  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      {/* Thumbnail placeholder */}
      <div className="aspect-square rounded-lg bg-[hsl(var(--accent))] overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent -translate-x-full animate-[shimmer_1.6s_infinite]" />
        <div className="w-full h-full bg-[hsl(var(--muted)/0.5)]" />
      </div>
      {/* Name placeholder */}
      <div className="h-3 w-3/4 rounded-md bg-[hsl(var(--muted)/0.6)] relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent -translate-x-full animate-[shimmer_1.6s_0.2s_infinite]" />
      </div>
      {/* Size placeholder */}
      <div className="h-2.5 w-1/3 rounded-md bg-[hsl(var(--muted)/0.4)] relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent -translate-x-full animate-[shimmer_1.6s_0.4s_infinite]" />
      </div>
    </div>
  );
}

export function FileGridSkeleton({ count = 24 }: { count?: number }) {
  const { gridSize } = useTopBar();
  return (
    <div className={cn("grid gap-3 p-4", gridClasses[gridSize])}>
      {Array.from({ length: count }).map((_, i) => (
        <GridSkeletonCard key={i} />
      ))}
    </div>
  );
}

// ── List Skeleton ─────────────────────────────────────────────────────────────

function ListSkeletonRow({ offset = 0 }: { offset?: number }) {
  return (
    <div className="grid grid-cols-12 gap-2 px-4 py-2.5 items-center border-b border-[hsl(var(--border))]">
      {/* Icon + name */}
      <div className="col-span-6 flex items-center gap-2.5">
        <div className="w-4 h-4 rounded bg-[hsl(var(--muted)/0.5)] shrink-0 relative overflow-hidden">
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent -translate-x-full animate-[shimmer_1.6s_infinite]"
            style={{ animationDelay: `${offset * 0.07}s` }}
          />
        </div>
        <div
          className="h-3 rounded-md bg-[hsl(var(--muted)/0.5)] relative overflow-hidden"
          style={{ width: `${50 + ((offset * 23) % 35)}%` }}
        >
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent -translate-x-full animate-[shimmer_1.6s_infinite]"
            style={{ animationDelay: `${offset * 0.07}s` }}
          />
        </div>
      </div>
      {/* Date */}
      <div className="col-span-2 hidden md:block">
        <div className="h-2.5 w-16 rounded-md bg-[hsl(var(--muted)/0.35)] relative overflow-hidden">
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent -translate-x-full animate-[shimmer_1.6s_infinite]"
            style={{ animationDelay: `${0.1 + offset * 0.07}s` }}
          />
        </div>
      </div>
      {/* Size */}
      <div className="col-span-2 hidden sm:block">
        <div className="h-2.5 w-10 rounded-md bg-[hsl(var(--muted)/0.35)] relative overflow-hidden">
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent -translate-x-full animate-[shimmer_1.6s_infinite]"
            style={{ animationDelay: `${0.2 + offset * 0.07}s` }}
          />
        </div>
      </div>
      {/* Actions */}
      <div className="col-span-2 flex items-center justify-end gap-2">
        <div className="w-5 h-5 rounded-md bg-[hsl(var(--muted)/0.3)]" />
        <div className="w-5 h-5 rounded-md bg-[hsl(var(--muted)/0.3)]" />
      </div>
    </div>
  );
}

export function FileListSkeleton({ count = 18 }: { count?: number }) {
  return (
    <div className="divide-y divide-[hsl(var(--border))]">
      {/* Fake header */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))]">
        <span className="col-span-6">Name</span>
        <span className="col-span-2 hidden md:block">Modified</span>
        <span className="col-span-2 hidden sm:block">Size</span>
        <span className="col-span-2"></span>
      </div>
      {Array.from({ length: count }).map((_, i) => (
        <ListSkeletonRow key={i} offset={i} />
      ))}
    </div>
  );
}
