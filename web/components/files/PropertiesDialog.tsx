"use client";

import React, { useEffect, useState } from "react";
import { X, Info, HardDrive, Clock, ShieldAlert, FileText, CheckCircle2, Hash, Folder } from "lucide-react";
import { formatBytes } from "@/lib/utils";

interface PropertiesProps {
  relativePath: string;
  name: string;
}

interface PropertiesData {
  type: string;
  relativePath: string;
  size: string;
  modifiedAt: string | null;
  childCount?: number;
  healthStatus: "HEALTHY" | "CORRUPT" | "UNSUPPORTED";
  healthError: string | null;
  fastHash?: string;
  videoDetails?: {
    duration: number;
  } | null;
}

export function PropertiesDialog() {
  const [target, setTarget] = useState<PropertiesProps | null>(null);
  const [data, setData] = useState<PropertiesData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handleOpen = (e: Event) => {
      const customEvent = e as CustomEvent<PropertiesProps>;
      setTarget(customEvent.detail);
    };
    window.addEventListener("loom-properties", handleOpen);
    return () => window.removeEventListener("loom-properties", handleOpen);
  }, []);

  useEffect(() => {
    if (!target) return;
    setLoading(true);
    fetch(`/api/files/properties?path=${encodeURIComponent(target.relativePath)}`)
      .then((r) => r.json())
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [target]);

  if (!target) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-lg shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-[hsl(var(--muted))]">
          <div className="flex items-center gap-2 text-[hsl(var(--foreground))]">
            <Info size={18} className="text-blue-500" />
            <h2 className="text-lg font-semibold truncate max-w-[300px]">{target.name} Properties</h2>
          </div>
          <button
            onClick={() => setTarget(null)}
            className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex justify-center p-8 text-[hsl(var(--muted-foreground))]">
              Loading properties...
            </div>
          ) : data ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-[120px_1fr] gap-2">
                <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2"><FileText size={14}/> Type:</span>
                <span className="font-medium text-[hsl(var(--foreground))]">{data.type}</span>
                
                <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2 mt-2"><Info size={14}/> Location:</span>
                <span className="font-medium text-[hsl(var(--foreground))] break-all mt-2">{data.relativePath}</span>

                {data.type === "FILE" ? (
                  <>
                    <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2 mt-2"><HardDrive size={14}/> Size:</span>
                    <span className="font-medium text-[hsl(var(--foreground))] mt-2">{formatBytes(BigInt(data.size))}</span>
                  </>
                ) : (
                  <>
                    <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2 mt-2"><HardDrive size={14}/> Size:</span>
                    <span className="font-medium text-[hsl(var(--foreground))] mt-2">{formatBytes(BigInt(data.size))} (Total)</span>
                    
                    <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2 mt-2"><Folder size={14}/> Contains:</span>
                    <span className="font-medium text-[hsl(var(--foreground))] mt-2">{data.childCount !== undefined ? `${data.childCount} items` : "Loading..."}</span>
                  </>
                )}

                {data.modifiedAt && (
                  <>
                    <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2 mt-2"><Clock size={14}/> Modified:</span>
                    <span className="font-medium text-[hsl(var(--foreground))] mt-2">{new Date(data.modifiedAt).toLocaleString()}</span>
                  </>
                )}
                
                {data.fastHash && (
                  <>
                    <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2 mt-2"><Hash size={14}/> Fast Hash:</span>
                    <span className="font-medium text-[hsl(var(--foreground))] truncate mt-2" title={data.fastHash}>{data.fastHash.substring(0, 16)}...</span>
                  </>
                )}

                {data.videoDetails && (
                  <>
                    <span className="text-[hsl(var(--muted-foreground))] flex items-center gap-2 mt-1"><Clock size={14}/> Duration:</span>
                    <span className="font-medium text-[hsl(var(--foreground))] mt-1">{Math.round(data.videoDetails.duration)}s</span>
                  </>
                )}
              </div>

              {data.healthStatus !== "HEALTHY" && (
                <div className="mt-4 p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-500">
                  <div className="flex items-center gap-2 font-semibold mb-1">
                    <ShieldAlert size={16} /> 
                    {data.healthStatus === "CORRUPT" ? "Corrupt File" : "Unsupported Format"}
                  </div>
                  {data.healthError && <div className="text-xs break-all opacity-80">{data.healthError}</div>}
                </div>
              )}
              
              {data.healthStatus === "HEALTHY" && (
                <div className="mt-4 flex items-center gap-2 text-green-500 text-xs font-medium">
                  <CheckCircle2 size={14} /> File is healthy
                </div>
              )}
            </div>
          ) : (
            <div className="text-red-500 text-center">Failed to load properties.</div>
          )}
        </div>
      </div>
    </div>
  );
}
