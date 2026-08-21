import { prisma } from "./prisma";
import type { Role } from "@prisma/client";

/**
 * Hierarchical ACL resolver.
 * The deepest matching rule wins.
 * Owner bypasses all ACL rules and always has full access.
 */
export async function checkAccess(
  userId: string,
  userRole: Role,
  requestedPath: string
): Promise<boolean> {
  // Owner has unconditional access to everything
  if (userRole === "OWNER") return true;

  // Normalize path: remove leading slashes, lowercase
  const normalizedPath = requestedPath.replace(/^\/+/, "");

  // Fetch all ACL rules for this user
  const rules = await prisma.aclRule.findMany({
    where: { userId },
    orderBy: { path: "asc" },
  });

  if (rules.length === 0) return false;

  // Find all rules whose path is a prefix of (or exactly) the requested path
  const matchingRules = rules.filter((rule) => {
    const rulePath = rule.path.replace(/^\/+/, "");
    // Either the rule path exactly matches or it's a parent directory
    return (
      normalizedPath === rulePath ||
      normalizedPath.startsWith(rulePath + "/")
    );
  });

  if (matchingRules.length === 0) return false;

  // The deepest matching rule (longest path) wins
  const deepestRule = matchingRules.reduce((prev, curr) =>
    curr.path.length > prev.path.length ? curr : prev
  );

  return deepestRule.allow;
}

/**
 * Filter a list of file paths to only those accessible by this user.
 */
export async function filterAccessiblePaths(
  userId: string,
  userRole: Role,
  paths: string[]
): Promise<string[]> {
  if (userRole === "OWNER") return paths;

  const results = await Promise.all(
    paths.map(async (p) => ({
      path: p,
      allowed: await checkAccess(userId, userRole, p),
    }))
  );

  return results.filter((r) => r.allowed).map((r) => r.path);
}

/**
 * Get the set of allowed top-level root paths for a user.
 * Used to build the sidebar / home view.
 */
export async function getAllowedRoots(
  userId: string,
  userRole: Role
): Promise<string[]> {
  if (userRole === "OWNER") return [""];

  const rules = await prisma.aclRule.findMany({
    where: { userId, allow: true },
    orderBy: { path: "asc" },
  });

  return rules.map((r) => r.path.replace(/^\/+/, ""));
}
