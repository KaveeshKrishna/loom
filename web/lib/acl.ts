/**
 * acl.ts — path-based permissions for Family users.
 *
 * Owner can do everything. For Family users, the Owner defines allow/deny
 * rules on paths; the deepest rule that matches a path wins. A rule on "" (or
 * "/") is the root rule and matches every path, so "deny /, allow Photos" is
 * the way to limit someone to one folder. With no matching rule at all, a
 * path is allowed (so a Family user with no rules sees everything — the
 * Owner is expected to add rules to restrict them).
 *
 * Three questions are answered:
 *   canAccess(p)     — may the user read/change p itself?
 *   canTraverse(p)   — may the user *see* p in listings and open it to reach
 *                      an allowed descendant? (a denied folder that contains
 *                      an allowed sub-folder is traversable, but not
 *                      accessible)
 *   canAccessTree(p) — may the user act on p *and everything under it*
 *                      (move, rename, trash, copy, zip a folder)? False if
 *                      any deny rule sits below p, so a denied sub-folder can
 *                      never be carried along by an operation on its parent.
 *
 * Load rules once per request with getAcl(user) and call the evaluator as
 * many times as needed — no per-path database queries.
 */

import { prisma } from "./prisma";
import type { Role } from "@prisma/client";

export interface AclRuleLike {
  path: string;
  allow: boolean;
}

export interface AclEvaluator {
  isOwner: boolean;
  canAccess(path: string): boolean;
  canTraverse(path: string): boolean;
  canAccessTree(path: string): boolean;
}

/** "/Photos/2024/" -> "Photos/2024", "/" -> "" */
export function normalizeAclPath(p: string): string {
  return (p ?? "")
    .split("/")
    .filter((seg) => seg && seg !== ".")
    .join("/");
}

function isSameOrUnder(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

function isStrictlyUnder(path: string, root: string): boolean {
  return path !== root && (root === "" ? path !== "" : path.startsWith(root + "/"));
}

const OWNER_EVALUATOR: AclEvaluator = {
  isOwner: true,
  canAccess: () => true,
  canTraverse: () => true,
  canAccessTree: () => true,
};

export function buildAcl(rules: AclRuleLike[], role: Role): AclEvaluator {
  if (role === "OWNER") return OWNER_EVALUATOR;

  const normalized = rules.map((r) => ({ path: normalizeAclPath(r.path), allow: r.allow }));

  const effective = (rawPath: string): boolean => {
    const p = normalizeAclPath(rawPath);
    let best: { path: string; allow: boolean } | null = null;
    for (const rule of normalized) {
      if (!isSameOrUnder(p, rule.path)) continue;
      if (!best || rule.path.length > best.path.length) best = rule;
    }
    return best ? best.allow : true;
  };

  return {
    isOwner: false,
    canAccess: effective,
    canTraverse(rawPath) {
      if (effective(rawPath)) return true;
      const p = normalizeAclPath(rawPath);
      return normalized.some((r) => r.allow && isStrictlyUnder(r.path, p));
    },
    canAccessTree(rawPath) {
      if (!effective(rawPath)) return false;
      const p = normalizeAclPath(rawPath);
      return !normalized.some((r) => !r.allow && isStrictlyUnder(r.path, p));
    },
  };
}

export async function getAcl(user: { id: string; role: Role }): Promise<AclEvaluator> {
  if (user.role === "OWNER") return OWNER_EVALUATOR;
  const rules = await prisma.aclRule.findMany({
    where: { userId: user.id },
    select: { path: true, allow: true },
  });
  return buildAcl(rules, user.role);
}

/**
 * Keep ACL rules pointing at the same folders after a rename/move:
 * every rule on `oldPath` or below is rewritten to live under `newPath`.
 */
export async function rewriteAclPaths(
  tx: Pick<typeof prisma, "aclRule">,
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldP = normalizeAclPath(oldPath);
  if (!oldP) return;
  const rules = await tx.aclRule.findMany({
    where: { OR: [{ path: oldP }, { path: { startsWith: oldP + "/" } }] },
  });
  for (const rule of rules) {
    const norm = normalizeAclPath(rule.path);
    const rewritten = normalizeAclPath(newPath) + norm.slice(oldP.length);
    // If an equivalent rule already exists at the destination, the moved
    // rule (which the Owner set on this exact folder) takes precedence.
    await tx.aclRule.deleteMany({
      where: { userId: rule.userId, path: rewritten, NOT: { id: rule.id } },
    });
    await tx.aclRule.update({ where: { id: rule.id }, data: { path: rewritten } });
  }
}
