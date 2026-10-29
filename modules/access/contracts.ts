export type UserRole = "viewer" | "scheduler" | "admin";

export type AppUser = {
  id: string;
  externalSubject: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
};

export type { PagePermission } from "./permission-catalog";

export type { AuditContext } from "./server/audit";

export type ManagedUser = AppUser & { createdAt: string; lastSeenAt: string };
export type { AuditLogEvent } from "./audit-export";
