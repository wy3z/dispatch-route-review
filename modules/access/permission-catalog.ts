export const pagePermissionKeys = [
  "dispatch_review",
  "engineer_management",
] as const;

export type PagePermissionKey = (typeof pagePermissionKeys)[number];

export type PagePermission = {
  key: PagePermissionKey;
  label: string;
  path: string;
  granted: boolean;
};

export const pagePermissionCatalog = {
  dispatch_review: {
    label: "Dispatch Review",
    path: "/",
  },
  engineer_management: {
    label: "Engineer management",
    path: "/engineers",
  },
} satisfies Record<
  PagePermissionKey,
  { label: string; path: string }
>;

export function isPagePermissionKey(
  value: unknown,
): value is PagePermissionKey {
  return (
    typeof value === "string" &&
    pagePermissionKeys.includes(value as PagePermissionKey)
  );
}

export function serialisePagePermissions(
  rows: Array<{ permission_key: PagePermissionKey; granted: boolean }>,
): PagePermission[] {
  const grants = new Map(
    rows.map((row) => [row.permission_key, row.granted]),
  );
  return pagePermissionKeys.map((key) => ({
    key,
    ...pagePermissionCatalog[key],
    granted: grants.get(key) === true,
  }));
}
