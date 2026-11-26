import { describe, expect, it } from "vitest";
import { cleanBrandValues, splitBrandValues, SUGGESTED_BRAND_VALUES, toggleBrandValue } from "../app/lib/vendors/values";

describe("brand values (tags)", () => {
  it("every suggested value passes its own rules", () => {
    for (const tag of SUGGESTED_BRAND_VALUES) expect(cleanBrandValues(tag), tag).toEqual({ values: [tag] });
    expect(new Set(SUGGESTED_BRAND_VALUES.map((t) => t.toLowerCase())).size).toBe(SUGGESTED_BRAND_VALUES.length);
  });

  it("splits on commas, new lines and semicolons, and tidies spaces and a leading #", () => {
    expect(splitBrandValues(" Women owned ,#Organic; ##Vegan\n  Small   batch ,, ")).toEqual(["Women owned", "Organic", "Vegan", "Small batch"]);
    expect(cleanBrandValues("")).toEqual({ values: [] });
  });

  it("tapping a choice adds it, tapping again takes it out, whatever the letter case", () => {
    expect(toggleBrandValue("", "Organic")).toBe("Organic");
    expect(toggleBrandValue("Women owned", "Organic")).toBe("Women owned, Organic");
    expect(toggleBrandValue("Women owned, organic", "Organic")).toBe("Women owned");
  });

  it("says what is wrong in plain words", () => {
    expect(cleanBrandValues("a, b, c, d, e, f").error).toBe("Choose up to 5. You have 6.");
    expect(cleanBrandValues("x".repeat(31)).error).toMatch(/30 characters or fewer/);
    expect(cleanBrandValues("see www.example.com/now").error).toBeUndefined(); // plain dots and slashes are allowed; no scheme, no link
    expect(cleanBrandValues("https://example.com").error).toMatch(/plain words only/);
  });
});
