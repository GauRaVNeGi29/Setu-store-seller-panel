import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import db from "../db.server";
import { clearSessionCookie, endSession, readSessionToken } from "../lib/portal/auth.server";

/** POST /portal/logout – ends the session on the server and clears the cookie. */
export const action = async ({ request }: ActionFunctionArgs) => {
  await endSession(db, readSessionToken(request));
  return redirect("/portal/login", { headers: { "Set-Cookie": clearSessionCookie() } });
};

export const loader = () => redirect("/portal");
