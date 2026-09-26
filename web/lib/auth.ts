import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";

const isProduction = process.env.NODE_ENV === "production";
const isBuild = process.env.NEXT_PHASE === "phase-production-build";

function authSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret && secret !== "generate_a_long_random_secret_here") {
    if (secret.length < 32 && isProduction && !isBuild) {
      console.warn("[auth] BETTER_AUTH_SECRET is shorter than 32 characters. Consider a longer one (openssl rand -base64 48); changing it signs everyone out.");
    }
    return secret;
  }
  if (isProduction && !isBuild) {
    // Refuse to run with a missing or placeholder secret: anyone who knows it
    // could forge session cookies.
    throw new Error(
      "BETTER_AUTH_SECRET is missing or still the example value. " +
        "Set it in .env (./scripts/install.sh generates one) and restart."
    );
  }
  return secret || "development-only-secret-do-not-use-in-production-000";
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    // Accounts are created only by the Owner (Settings → Users) or by the
    // first-run setup page. Nobody can register themselves.
    disableSignUp: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh if older than 1 day
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        // Never accept a role from the client (sign-up / update-user bodies).
        input: false,
      },
    },
  },
  rateLimit: {
    enabled: isProduction,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/change-password": { window: 60, max: 5 },
    },
  },
  telemetry: { enabled: false },
  secret: authSecret(),
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  trustedOrigins: process.env.TRUSTED_ORIGINS
    ? process.env.TRUSTED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [],
});

export type Auth = typeof auth;
