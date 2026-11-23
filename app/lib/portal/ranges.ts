/** Dashboard periods. Safe to use in the browser. */
export const RANGES = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days", all: "All time" } as const;
export type RangeKey = keyof typeof RANGES;
export const isRange = (v: string | null): v is RangeKey => !!v && v in RANGES;
