
export {
  AuthenticationError,
  authErrorResponse,
  authenticateRequest,
  requireRole,
  requireSameOriginForMutation,
} from "./server/auth";

export {
  authenticateAndRequirePagePermission,
  developmentPageUser,
  hasPagePermission,
  listPagePermissions,
  requirePagePermission,
} from "./server/page-permissions";

export { auditApiRequest } from "./server/api-failure-audit";

export { updateUserPagePermission } from "./server/user-permissions";

export { appendAuditEvent, auditContext } from "./server/audit";

export { listUsers, updateUserAccess } from "./server/users";

export { listAuditEvents, listAuditFilters } from "./server/audit-queries";

export { provisionAdministrator } from "./server/admin-bootstrap";
export type { AdministratorProvisionMode } from "./server/admin-bootstrap";

export {
  AuthIdentityChangeError,
  getUserIdentityState,
  isExactExternalSubject,
  isUuid,
  recoverFinalAdministratorIdentity,
  updateUserIdentity,
} from "./server/auth-identities";
export type {
  AuthIdentityOperation,
  AuthIdentityUserState,
  RecoverAdministratorIdentityInput,
  UpdateUserIdentityInput,
} from "./server/auth-identities";
