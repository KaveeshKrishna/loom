/**
 * DEMO BUILD ONLY — replaces web/app/(auth)/login/page.tsx.
 * The real version checks `prisma.user.count()` server-side to detect a
 * fresh install; the demo has no database and no setup flow, so this just
 * renders the (also swapped) demo LoginForm directly.
 */
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return <LoginForm />;
}
