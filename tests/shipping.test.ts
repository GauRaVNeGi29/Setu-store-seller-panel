import { describe, expect, it } from "vitest";
import { cleanDayRange, daysText, rangeOf, totalDays } from "../app/lib/vendors/shipping";

describe("day ranges (processing and delivery time)", () => {
  it("reads two whole numbers, and treats both empty as not set", () => {
    expect(cleanDayRange("10", "15", "processing time")).toEqual({ range: { min: 10, max: 15 } });
    expect(cleanDayRange(" 3 ", "3", "delivery time")).toEqual({ range: { min: 3, max: 3 } });
    expect(cleanDayRange("", "  ", "delivery time")).toEqual({ range: null });
  });

  it("says what is wrong in plain words", () => {
    expect(cleanDayRange("10", "", "delivery time").error).toBe("Enter both numbers for the delivery time, e.g. 10 and 15.");
    expect(cleanDayRange("15", "10", "x").error).toMatch(/can't be smaller/);
    expect(cleanDayRange("1.5", "2", "x").error).toMatch(/whole numbers/);
    expect(cleanDayRange("1", "366", "x").error).toMatch(/365 days or fewer/);
    expect(cleanDayRange("0", "0", "x").error).toMatch(/at least 1 day/);
  });

  it("writes a range as words", () => {
    expect([daysText({ min: 10, max: 15 }), daysText({ min: 7, max: 7 }), daysText({ min: 1, max: 1 }), daysText({ min: 0, max: 1 })]).toEqual(["10–15 days", "7 days", "1 day", "0–1 days"]);
  });

  it("adds processing and delivery end to end, and only when both are known", () => {
    expect(totalDays({ min: 10, max: 15 }, { min: 5, max: 7 })).toEqual({ min: 15, max: 22 });
    expect(totalDays(null, { min: 5, max: 7 })).toBeNull();
    expect(totalDays({ min: 10, max: 15 }, null)).toBeNull();
    expect([rangeOf(1, null), rangeOf(null, 2), rangeOf(0, 2)]).toEqual([null, null, { min: 0, max: 2 }]);
  });
});
