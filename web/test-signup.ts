import { auth } from "./lib/auth";
async function run() {
  try {
    const res = await auth.api.signUpEmail({
      body: {
        email: "test2@loom",
        password: "password123",
        name: "Test"
      }
    });
    console.log("Success:", res);
  } catch (err) {
    console.error("Auth error:", err);
  }
}
run();
