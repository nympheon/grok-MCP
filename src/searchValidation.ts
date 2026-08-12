export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function filtersAreExclusive(
  allowed: readonly string[] | undefined,
  excluded: readonly string[] | undefined,
): boolean {
  return !(allowed && allowed.length > 0 && excluded && excluded.length > 0);
}

export function dateRangeIsOrdered(fromDate?: string, toDate?: string): boolean {
  return !fromDate || !toDate || fromDate <= toDate;
}
