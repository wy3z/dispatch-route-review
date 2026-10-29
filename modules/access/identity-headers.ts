export type AuthenticatedIdentity = {
  subject: string;
  email: string;
  displayName: string;
};

const TRUSTED_IDENTITY_HEADERS = {
  subject: "x-auth-request-user",
  email: "x-auth-request-email",
  displayName: "x-auth-request-preferred-username",
} as const;

const LEGACY_IDENTITY_HEADERS = [
  "x-forwarded-user",
  "x-forwarded-email",
  "x-forwarded-preferred-username",
] as const;

function headerValue(headers: Headers, name: string) {
  return headers.get(name)?.trim();
}

/** Accept one complete ForwardAuth identity tuple and no legacy aliases. */
export function trustedIdentityFromHeaders(
  headers: Headers,
): AuthenticatedIdentity | null {
  if (LEGACY_IDENTITY_HEADERS.some((name) => headerValue(headers, name))) {
    return null;
  }

  const subject = headerValue(headers, TRUSTED_IDENTITY_HEADERS.subject);
  const email = headerValue(headers, TRUSTED_IDENTITY_HEADERS.email)?.toLowerCase();
  const displayName = headerValue(headers, TRUSTED_IDENTITY_HEADERS.displayName);

  if (
    !subject ||
    !email ||
    !displayName ||
    subject.length > 512 ||
    email.length > 320 ||
    displayName.length > 256
  ) {
    return null;
  }

  return { subject, email, displayName };
}
