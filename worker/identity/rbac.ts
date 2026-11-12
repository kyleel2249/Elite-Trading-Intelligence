/** Role-based access control. Roles only ever add privileges in this order; MFA is mandatory for the roles that can reach an exchange or manage the system. */
export const ROLES = ["viewer", "analyst", "paper_trader", "trader", "admin"] as const;
export type Role = typeof ROLES[number];
export type Permission = "market.read" | "research.read" | "portfolio.read" | "orders.paper" | "orders.testnet" | "portfolio.manage" | "keys.rotate" | "users.manage" | "audit.read" | "backup.manage";
const GRANTS: Record<Role, Permission[]> = {
  viewer: ["market.read"],
  analyst: ["market.read", "research.read", "portfolio.read"],
  paper_trader: ["market.read", "research.read", "portfolio.read", "orders.paper", "portfolio.manage"],
  trader: ["market.read", "research.read", "portfolio.read", "orders.paper", "portfolio.manage", "orders.testnet"],
  admin: ["market.read", "research.read", "portfolio.read", "orders.paper", "portfolio.manage", "orders.testnet", "keys.rotate", "users.manage", "audit.read", "backup.manage"],
};
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
export const roleCan = (role: Role, p: Permission) => GRANTS[role].includes(p);
export const permissionsOf = (role: Role): Permission[] => [...GRANTS[role]];
/** Roles that must enrol in TOTP MFA before they receive any privilege. */
export const MFA_REQUIRED: readonly Role[] = ["trader", "admin"];
export const requiresMfa = (role: Role) => MFA_REQUIRED.includes(role);
/** Execution-environment scopes a signed-in user inherits (the same scopes the automatic sessions use). Live is never granted. */
export const scopesOf = (role: Role): ("paper" | "testnet")[] => role === "admin" || role === "trader" ? ["paper", "testnet"] : role === "paper_trader" ? ["paper"] : [];
/** Idle and absolute session lifetime in seconds; privileged roles get shorter sessions. */
export const sessionPolicy = (role: Role) => requiresMfa(role) ? { idleSec: 15 * 60, absoluteSec: 4 * 3600 } : { idleSec: 30 * 60, absoluteSec: 12 * 3600 };
