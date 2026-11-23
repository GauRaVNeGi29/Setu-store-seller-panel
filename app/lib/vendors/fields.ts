/** Vendor detail fields and their labels. Safe to use in the browser. */

export const BRAND_FIELDS = ["description", "policy", "minimumOrderValue", "productNote"] as const;
export const BUSINESS_FIELDS = ["displayName", "gstNumber", "phone", "city", "state"] as const;
export type BrandField = (typeof BRAND_FIELDS)[number];
export type BusinessField = (typeof BUSINESS_FIELDS)[number];

export const FIELD_LABEL: Record<BrandField | BusinessField, string> = {
  displayName: "Business name", gstNumber: "GST number", phone: "Business phone", city: "City", state: "State",
  description: "Brand description", policy: "Short policy", minimumOrderValue: "Minimum order value", productNote: "What you sell",
};
