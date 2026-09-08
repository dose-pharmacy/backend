const DAY_MS = 86_400_000;

/** Truncates a date to the start of its UTC day (used for date-only fields). */
export function toUtcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function startOfTodayUtc(): Date {
  return toUtcDayStart(new Date());
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * A batch is considered expired once its expiry date (a UTC day start) is
 * strictly before today. A batch expiring today is still valid today.
 */
export function isExpired(expiryDate: Date): boolean {
  return expiryDate.getTime() < startOfTodayUtc().getTime();
}

/** Normalizes a client-supplied date to a UTC day start. */
export function toUtcDay(date: Date): Date {
  return toUtcDayStart(date);
}
