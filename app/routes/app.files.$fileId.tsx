import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { assertAllowedShop } from "../lib/guard.server";
import { fileResponse } from "../lib/files/files.server";

/**
 * /app/files/:fileId – a vendor's file, for the Setu Store team inside Shopify admin.
 * The page fetches it with the admin session (App Bridge adds the token), so
 * it can't be opened by a plain link from outside admin.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  assertAllowedShop(session.shop);
  const download = new URL(request.url).searchParams.get("download") === "1";
  return fileResponse(db, { id: params.fileId ?? "", shop: session.shop }, download);
};
