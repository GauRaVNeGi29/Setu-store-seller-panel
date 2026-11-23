/** Vendor detail fields and their labels. Safe to use in the browser. */

/** Business details: sent to the Setu Store team for approval. */
export const BUSINESS_TEXT = ["companyName", "addressLine", "city", "state", "postalCode"] as const;
export const BUSINESS_FILES = ["gstFileId", "iecFileId", "adCodeFileId"] as const;
export const BUSINESS_FIELDS = [...BUSINESS_TEXT, ...BUSINESS_FILES] as const;

/** Brand details: saved at once. */
export const BRAND_TEXT = ["description", "shortDescription", "minimumOrderValue"] as const;
export const BRAND_FILES = ["logoFileId", "bannerFileId"] as const;
export const BRAND_FIELDS = [...BRAND_TEXT, ...BRAND_FILES] as const;

export type BusinessField = (typeof BUSINESS_FIELDS)[number];
export type BrandField = (typeof BRAND_FIELDS)[number];
export type FileField = (typeof BUSINESS_FILES)[number] | (typeof BRAND_FILES)[number];

/** Which kind of file each *FileId field holds. */
export const FILE_FIELD_KIND = {
  gstFileId: "gst", iecFileId: "iec", adCodeFileId: "ad_code", logoFileId: "logo", bannerFileId: "banner",
} as const satisfies Record<FileField, string>;

/** Form input name for each file field (e.g. gstFileId → "gstFile"). */
export const fileInputName = (f: FileField) => f.replace(/Id$/, "");

export const FIELD_LABEL: Record<BusinessField | BrandField, string> = {
  companyName: "Company name", addressLine: "Street address", city: "City", state: "State", postalCode: "PIN code",
  gstFileId: "GST certificate", iecFileId: "IEC certificate", adCodeFileId: "AD code letter",
  description: "Description", shortDescription: "Short description", minimumOrderValue: "Minimum order value",
  logoFileId: "Brand logo", bannerFileId: "Brand banner",
};

export const SHORT_DESCRIPTION_MAX = 160;

/** Required details a vendor hasn't filled in yet (shown as a reminder). */
export function missingDetails(v: {
  companyName?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; postalCode?: string | null;
  minimumOrderValue?: string | null;
}): string[] {
  const out: string[] = [];
  if (!v.companyName) out.push("company name");
  if (!v.addressLine || !v.city || !v.state || !v.postalCode) out.push("business address");
  if (!v.minimumOrderValue) out.push("minimum order value");
  return out;
}
