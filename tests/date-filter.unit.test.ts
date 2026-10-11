import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/app-error.js";
import {
  presetRange,
  resolveDateFilter,
} from "../src/utils/date-filter.js";

const DAY_MS = 86_400_000;

function utc(y: number, m: number, d: number, h = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h));
}

describe("date-filter: presetRange (UTC calendar windows)", () => {
  it("today spans the current UTC calendar day, half-open", () => {
    const { gte, lt } = presetRange("today", utc(2026, 10, 11, 15));
    expect(gte?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(lt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("this_week starts on Monday and is exactly seven days (Mid-week)", () => {
    // 2026-10-07 is a Wednesday.
    const now = utc(2026, 10, 7, 9);
    const { gte, lt } = presetRange("this_week", now);
    expect(gte?.getUTCDay()).toBe(1); // Monday
    expect(lt!.getTime() - gte!.getTime()).toBe(7 * DAY_MS);
    expect(gte!.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime()).toBeLessThan(lt!.getTime());
  });

  it("this_week on a Sunday belongs to the week that started the prior Monday", () => {
    // 2026-10-11 is a Sunday.
    const { gte, lt } = presetRange("this_week", utc(2026, 10, 11, 23));
    expect(gte?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(lt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("this_week on a Monday includes that Monday", () => {
    const { gte } = presetRange("this_week", utc(2026, 10, 5, 0));
    expect(gte?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("this_month spans the first through the last calendar day", () => {
    const { gte, lt } = presetRange("this_month", utc(2026, 10, 11, 15));
    expect(gte?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(lt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("this_month crosses the year boundary", () => {
    const { gte, lt } = presetRange("this_month", utc(2026, 12, 15));
    expect(gte?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(lt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("this_month handles a leap-year February", () => {
    const { gte, lt } = presetRange("this_month", utc(2028, 2, 15));
    expect(gte?.toISOString()).toBe("2028-02-01T00:00:00.000Z");
    expect(lt?.toISOString()).toBe("2028-03-01T00:00:00.000Z");
    // 2028 is a leap year: the window covers 29 days.
    expect((lt!.getTime() - gte!.getTime()) / DAY_MS).toBe(29);
  });
});

describe("date-filter: resolveDateFilter", () => {
  it("returns undefined when no filter is supplied", () => {
    expect(resolveDateFilter({})).toBeUndefined();
  });

  it("preset always produces both bounds", () => {
    const range = resolveDateFilter({ datePreset: "today" }, utc(2026, 10, 11, 12));
    expect(range?.gte).toBeInstanceOf(Date);
    expect(range?.lt).toBeInstanceOf(Date);
  });

  it("custom range is inclusive of both calendar days", () => {
    const range = resolveDateFilter({
      dateFrom: new Date("2026-10-01T00:00:00.000Z"),
      dateTo: new Date("2026-10-11T00:00:00.000Z"),
    });
    expect(range?.gte?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // Exclusive next-day bound so the whole of 2026-10-11 is included.
    expect(range?.lt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("accepts a timestamp anywhere in the day and truncates to the calendar day", () => {
    const range = resolveDateFilter({
      dateFrom: new Date("2026-10-01T18:45:10.000Z"),
      dateTo: new Date("2026-10-11T05:00:00.000Z"),
    });
    expect(range?.gte?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(range?.lt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("leaves the upper bound open when only dateFrom is supplied", () => {
    const range = resolveDateFilter({ dateFrom: new Date("2026-10-01T00:00:00.000Z") });
    expect(range?.gte?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(range?.lt).toBeUndefined();
  });

  it("leaves the lower bound open when only dateTo is supplied", () => {
    const range = resolveDateFilter({ dateTo: new Date("2026-10-11T00:00:00.000Z") });
    expect(range?.gte).toBeUndefined();
    expect(range?.lt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("a single-day range includes that whole day", () => {
    const range = resolveDateFilter({
      dateFrom: new Date("2026-10-11T00:00:00.000Z"),
      dateTo: new Date("2026-10-11T00:00:00.000Z"),
    });
    expect(range?.gte?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(range?.lt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("rejects an inverted range", () => {
    expect(() =>
      resolveDateFilter({
        dateFrom: new Date("2026-10-12T00:00:00.000Z"),
        dateTo: new Date("2026-10-11T00:00:00.000Z"),
      }),
    ).toThrowError(AppError);
  });

  it("preset takes precedence over custom bounds when both are present (service level)", () => {
    const range = resolveDateFilter(
      {
        datePreset: "today",
        dateFrom: new Date("2020-01-01T00:00:00.000Z"),
        dateTo: new Date("2020-01-02T00:00:00.000Z"),
      },
      utc(2026, 10, 11, 12),
    );
    expect(range?.gte?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(range?.lt?.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("timezone boundary: a timestamp at 23:30Z is inside 'today', 00:00Z next day is not", () => {
    const { gte, lt } = presetRange("today", utc(2026, 10, 11, 12));
    const late = utc(2026, 10, 11, 23).getTime() + 30 * 60_000;
    const nextMidnight = utc(2026, 10, 12, 0).getTime();
    expect(late).toBeGreaterThanOrEqual(gte!.getTime());
    expect(late).toBeLessThan(lt!.getTime());
    expect(nextMidnight).toBeGreaterThanOrEqual(lt!.getTime());
  });
});
