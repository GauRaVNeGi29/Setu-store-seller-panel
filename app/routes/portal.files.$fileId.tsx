import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { fileResponse } from "../lib/files/files.server";

/**
 * /portal/files/:fileId – a file the signed-in person's own vendor uploaded.
 * Another vendor's file, or one that doesn't exist, is "not found".
 * ?download=1 saves instead of opening.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const download = new URL(request.url).searchParams.get("download") === "1";
  return fileResponse(db, { id: params.fileId ?? "", shop: me.shop, vendorId: me.vendor.id }, download);
};
