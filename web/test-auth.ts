import { auth } from "./lib/auth";
async function run() {
  try {
    const res = await auth.api.signInEmail({
      body: {
        email: "test@example.com",
        password: process.env.OWNER_PASSWORD || "password123"
      }
    });
    console.log("Success:", res);
  } catch (err) {
    console.error("Auth error:", err);
  }
}
run();
