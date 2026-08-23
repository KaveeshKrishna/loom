"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { signIn } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await signIn.email({ email, password });
      if (res.error) {
        setError("Invalid email or password.");
      } else {
        router.push("/files");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-svh bg-[hsl(var(--background))] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-[hsl(var(--primary))] flex items-center justify-center mb-4 shadow-md">
            <span className="text-white text-xl font-bold">L</span>
          </div>
          <h1 className="text-xl font-semibold">Sign in to Loom</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
            Weaving your digital life together.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-[hsl(var(--card))] border rounded-2xl p-6 shadow-sm space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 text-sm bg-[hsl(var(--accent))] rounded-lg border border-transparent focus:border-[hsl(var(--primary)/0.4)] focus:bg-[hsl(var(--background))] focus:outline-none transition-all"
              placeholder="you@example.com"
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
                placeholder="••••••••"
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

          {error && (
            <p className="text-sm text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.08)] px-3 py-2 rounded-lg">
              {error}
            </p>
          )}

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
          Loom is a private, self-hosted storage system.
        </p>
      </div>
    </div>
  );
}
