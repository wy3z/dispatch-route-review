import { AppHeader } from "../shared/ui/AppHeader";

export function AccessError({ status, message }: { status: number; message: string }) {
  return (
    <main className="page">
      <AppHeader
        active="dispatch"
        canAccessDispatch={false}
        canAccessAdmin={false}
        canManageEngineers={false}
      />
      <section className="panel page-hidden" role="alert">
        <p className="eyebrow">Access unavailable · {status}</p>
        <h1>Dispatch Review could not be opened</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}
