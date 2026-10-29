import { AppHeader } from "../shared/ui/AppHeader";
import { navigationAccess } from "./navigation-access";

export default async function Forbidden() {
  const access = await navigationAccess("/");
  return (
    <main className="page">
      <AppHeader active="dispatch" {...access} />
      <section className="panel page-hidden" role="alert">
        <p className="eyebrow">Access denied</p>
        <h1>This page is not available to your account</h1>
        <p>
          Your account may be disabled, linked to a different identity, or
          missing the required access. Contact an administrator if you believe
          this is incorrect.
        </p>
      </section>
    </main>
  );
}
