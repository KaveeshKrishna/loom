"use client";

/**
 * DEMO BUILD ONLY — replaces web/app/(auth)/login/LoginForm.tsx.
 *
 * The real version calls `authClient.signIn.email()`, which hits
 * better-auth's real `/api/auth/[...all]` route — that route doesn't exist
 * in this build (app/api/ is deleted entirely for the static export). This
 * version skips authentication altogether: any credentials work, there's a
 * one-click "Fill demo credentials" button, and it sets a local session
 * flag directly.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { setDemoAuthed } from "@/lib/demo/state";
import { DemoBadge } from "@/components/demo/DemoNotice";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setDemoAuthed(true);
    setTimeout(() => router.push("/files"), 300);
  };

  const fillDemoCredentials = () => {
    setEmail("demo");
    setPassword("demo");
  };

  return (
    <div className="min-h-svh bg-[hsl(var(--background))] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-[hsl(var(--primary))] flex items-center justify-center mb-4 shadow-md">
            <span className="text-white text-xl font-bold">L</span>
          </div>
          <h1 className="text-xl font-semibold">Sign in to Loom</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
            Weaving your digital life together.
          </p>
          <div className="mt-3">
            <DemoBadge autoOpen />
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-[hsl(var(--card))] border rounded-2xl p-6 shadow-sm space-y-4">
          <button
            type="button"
            onClick={fillDemoCredentials}
            className="w-full px-3 py-2 text-sm font-medium border border-dashed border-[hsl(var(--primary)/0.4)] text-[hsl(var(--primary))] rounded-lg hover:bg-[hsl(var(--primary)/0.06)] transition-colors"
          >
            Fill demo credentials
          </button>

          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm bg-[hsl(var(--accent))] rounded-lg border border-transparent focus:border-[hsl(var(--primary)/0.4)] focus:bg-[hsl(var(--background))] focus:outline-none transition-all"
              placeholder="demo"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2 pr-10 text-sm bg-[hsl(var(--accent))] rounded-lg border border-transparent focus:border-[hsl(var(--primary)/0.4)] focus:bg-[hsl(var(--background))] focus:outline-none transition-all"
                placeholder="demo"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            id="login-submit"
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[hsl(var(--primary))] text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-60 transition-all"
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            Sign in
          </button>
        </form>

        <p className="text-center text-xs text-[hsl(var(--muted-foreground))] mt-6">
          Public demo — any credentials work. No real backend, no real data.
        </p>
      </div>
    </div>
  );
}
