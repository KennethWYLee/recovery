export function resolveOrganizationTimeZone(value?: string | null): string {
  const candidate = value?.trim() || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function validDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateTimeParts(value: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function toZonedDateTimeInput(value: string | null | undefined, timeZone: string): string {
  const date = validDate(value);
  if (!date) return "";
  const parts = dateTimeParts(date, timeZone);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function parseZonedDateTimeInput(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = (instant: number) => {
    const parts = dateTimeParts(new Date(instant), timeZone);
    const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return representedUtc - Math.floor(instant / 1000) * 1000;
  };
  let instant = targetUtc - offsetAt(targetUtc);
  instant = targetUtc - offsetAt(instant);
  const matchingInstants = new Set<number>();
  for (let deltaMinutes = -180; deltaMinutes <= 180; deltaMinutes += 30) {
    const candidate = instant + deltaMinutes * 60_000;
    if (toZonedDateTimeInput(new Date(candidate).toISOString(), timeZone) === value) matchingInstants.add(candidate);
  }
  if (matchingInstants.size !== 1) return null;
  return new Date([...matchingInstants][0]);
}
