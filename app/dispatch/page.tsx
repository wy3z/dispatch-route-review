import { forbidden, redirect, unstable_rethrow } from "next/navigation";
import { pageUser } from "../navigation-access";
import { AccessError } from "../dispatch-access-error";
import {
  AuthenticationError,
  requirePagePermission,
} from "@/modules/access/server";

type Props = {
  searchParams: Promise<{ date?: string | string[] }>;
};

async function dispatchAccessError() {
  try {
    const user = await pageUser("/dispatch");
    await requirePagePermission(user, "dispatch_review");
    return null;
  } catch (error) {
    unstable_rethrow(error);
    return error;
  }
}

/** Compatibility redirect into the Map workspace Timeline. Not a second schedule. */
export default async function DispatchCalendar({ searchParams }: Props) {
  const accessError = await dispatchAccessError();
  if (accessError instanceof AuthenticationError && accessError.status === 403) {
    forbidden();
  }
  if (accessError instanceof AuthenticationError) {
    return (
      <AccessError
        status={accessError.status}
        message={accessError.message}
      />
    );
  }
  if (accessError) throw accessError;
  const params = await searchParams;
  const date = Array.isArray(params.date) ? params.date[0] : params.date;
  const query = new URLSearchParams({ view: "timeline" });
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) query.set("date", date);
  redirect(`/?${query.toString()}`);
}
