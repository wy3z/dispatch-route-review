import { AppHeader } from "../../shared/ui/AppHeader";
import { navigationAccess } from "../navigation-access";

export default async function Forbidden() {
  const access = await navigationAccess("/admin");
  return (
    <main className="admin-page">
      <AppHeader active="admin" {...access} />
      <section className="panel page-hidden" role="alert">
        <p className="eyebrow">Access denied</p>
        <h1>Administration is not available to your account</h1>
        <p>
          Your account may be disabled, linked to a different identity, or
          missing the administrator role. Contact an existing administrator if
          you believe your access is incorrect.
        </p>
      </section>
    </main>
  );
}
