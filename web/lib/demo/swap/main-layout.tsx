"use client";

/**
 * DEMO BUILD ONLY — replaces web/app/(main)/layout.tsx.
 *
 * The real version is a Server Component calling `auth.api.getSession()` +
 * Prisma directly — there is no server or database in this build at all,
 * so this becomes a client-side guard against the localStorage demo
 * session flag instead. The demo "user" is always a fixed fabricated
 * Owner account (full feature access, matching how the fabricated Users
 * panel already lists it).
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MainShell } from "@/components/layout/MainShell";
import { isDemoAuthed } from "@/lib/demo/state";
import { DemoBadge } from "@/components/demo/DemoNotice";
import { DEMO_OWNER_EMAIL } from "@/lib/demo/types";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isDemoAuthed()) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;

  return (
    <>
      <MainShell userName="Demo Owner" userEmail={DEMO_OWNER_EMAIL} isOwner>
        {children}
      </MainShell>
      <div className="fixed bottom-4 right-4 z-40">
        <DemoBadge />
      </div>
    </>
  );
}
