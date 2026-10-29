import { AppHeader } from "../../shared/ui/AppHeader";
import { navigationAccess } from "../navigation-access";

export default async function Forbidden() {
  const access = await navigationAccess("/engineers");
  return (
    <main className="admin-page engineers-page">
      <AppHeader active="engineers" {...access} />
      <section className="panel page-hidden" role="alert">
        <p className="eyebrow">Access denied</p>
        <h1>Engineer management is not available to your account</h1>
        <p>
          This page is limited to roster managers with the Engineer
          management permission. Contact an administrator if you need access.
        </p>
      </section>
    </main>
  );
}
