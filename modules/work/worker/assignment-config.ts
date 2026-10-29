type AssignmentEnvironment = { AUTOTASK_THIRD_PARTY_COMPANY_FIELD?: string };

export function thirdPartyCompanyField(environment: AssignmentEnvironment = process.env as AssignmentEnvironment): string | null {
  return environment.AUTOTASK_THIRD_PARTY_COMPANY_FIELD?.trim() || null;
}
