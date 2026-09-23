/**
 * When a When next comes Due, read on the clock of the Job's own time zone.
 *
 * A time of day is not a moment until a zone says which one, and this file is
 * where that happens. Three facts about clocks shape all of it:
 *
 * - The machine's zone is not the Job's. A Job records its own, so its time
 *   means the same thing after the clock changes or the operator travels.
 * - Some wall times are not moments at all. The hour a clock skips going
 *   forward has none, so a Job set inside it comes Due at the next minute that
 *   exists, once.
 * - Some wall times are two moments. The hour a clock repeats going back has
 *   two, so a Job set inside it takes the first, and comes Due once.
 *
 * Nothing here stores an offset or a duration. Every answer is derived from
 * the wall clock at the moment it is asked for, which is why a suspend, an NTP
 * step, a manual clock change and a DST shift need no code of their own
 * (ADR-0001).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How far around a good guess the first matching minute can be. No zone has
 * ever moved its clock by more than two hours at once, and the guess is
 * already within one such move of the answer.
 */
const SEARCH_REACH = 4 * HOUR;

/** How many hours ahead an `hourly` Job is looked for. */
const HOURS_AHEAD = 48;

/** How many days ahead every other Job is looked for. */
const DAYS_AHEAD = 8;

/** The days of the week, in the order `Date` counts them. */
export const DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type Day = (typeof DAYS)[number];

/** How often a Job comes Due. There is no cron here and no expression to parse. */
export const EVERY = ['hourly', 'daily', 'weekdays', 'weekly'] as const;

export type Every = (typeof EVERY)[number];

/** The part of a Job that says at which times it is Due. */
export type When = {
  readonly every: Every;
  /** The time of day, `HH:MM`. Every When but `hourly` carries one. */
  readonly at?: string;
  /** The day of the week. Only a `weekly` When carries one. */
  readonly day?: Day;
  /** The IANA zone the time of day is read in. */
  readonly timezone: string;
};

/** Whether this machine knows a zone by that name at all. */
export function knowsZone(timezone: string): boolean {
  try {
    clockOf(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Whether this is a time of day written the one way this project writes it. */
export function isTimeOfDay(at: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(at);
}

/**
 * The first moment after `after` at which this When is Due.
 *
 * Strictly after, so asking at a Due minute answers with the following one.
 * The Page shows it and nothing stores it: a stored next Due time goes stale
 * the moment a clock moves.
 */
export function nextDue(when: When, after: number): number {
  const from = partsOf(readingAt(when.timezone, after));
  for (const want of candidates(when, from, 0, 1)) {
    const moment = momentOf(when.timezone, want);
    if (moment > after) return moment;
  }
  throw new Error(`A Job that is ${said(when)} never comes Due.`);
}

/**
 * The most recent moment at or before `at` when this When was Due, or null
 * when it has never yet been Due at all.
 *
 * This is the whole of what "Due" means to the clock: a Job is Due when its
 * most recent Due time is later than its last start. Three days off collapses
 * to one of these, which is why a Job missed over a weekend Runs once.
 */
export function previousDue(when: When, at: number): number | null {
  const from = partsOf(readingAt(when.timezone, at));
  let best: number | null = null;
  for (const want of candidates(when, from, -1, 0)) {
    const moment = momentOf(when.timezone, want);
    if (moment <= at && (best === null || moment > best)) best = moment;
  }
  return best;
}

/** The When as the sentence the Page shows. */
export function said(when: When): string {
  const zone = ` (${when.timezone})`;
  switch (when.every) {
    case 'hourly':
      return `every hour, on the hour${zone}`;
    case 'daily':
      return `every day at ${when.at}${zone}`;
    case 'weekdays':
      return `every weekday at ${when.at}${zone}`;
    case 'weekly':
      return `every ${named(when.day ?? 'sunday')} at ${when.at}${zone}`;
  }
}

/** A day of the week as a person writes it in a sentence. */
function named(day: Day): string {
  return day.slice(0, 1).toUpperCase() + day.slice(1);
}

/**
 * Every moment this When could next be Due, in the order it could be, as
 * clock readings rather than as instants. Turning one into a moment is the
 * zone's business, and it is done one at a time so that the first one that is
 * genuinely ahead wins.
 */
function candidates(when: When, from: Parts, back: number, forward: number): number[] {
  if (when.every === 'hourly') {
    const hours: number[] = [];
    for (let step = back * HOURS_AHEAD; step <= forward * HOURS_AHEAD; step += 1) {
      const at = new Date(Date.UTC(from.year, from.month - 1, from.day, from.hour + step));
      hours.push(readingOf(at, at.getUTCHours(), 0));
    }
    return hours;
  }

  const [hour, minute] = timeOf(when.at);
  const days: number[] = [];
  for (let step = back * DAYS_AHEAD; step <= forward * DAYS_AHEAD; step += 1) {
    const at = new Date(Date.UTC(from.year, from.month - 1, from.day + step));
    const weekday = DAYS[at.getUTCDay()] ?? 'sunday';
    if (when.every === 'weekdays' && (weekday === 'saturday' || weekday === 'sunday')) continue;
    if (when.every === 'weekly' && weekday !== when.day) continue;
    days.push(readingOf(at, hour, minute));
  }
  return days;
}

/** The hour and the minute of a `HH:MM`. */
function timeOf(at: string | undefined): [number, number] {
  const [hour, minute] = (at ?? '00:00').split(':');
  return [Number(hour), Number(minute)];
}

/**
 * The first moment at which the clock in a zone has reached a reading.
 *
 * Two passes of the zone's own offset land within one clock move of the
 * answer. Almost always that is the answer, and the two readings taken to
 * prove it are all this costs. When a clock moved near this time it is not,
 * and the walk forward finds the first minute whose clock has reached the
 * reading: the wanted minute when it exists, the next one that does when a
 * clock skipped it, and the first of the two when a clock repeated it.
 */
function momentOf(timezone: string, want: number): number {
  const parts = partsOf(want);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = asIfUtc - offsetAt(timezone, asIfUtc);
  guess = asIfUtc - offsetAt(timezone, guess);

  if (readingAt(timezone, guess) >= want && readingAt(timezone, guess - MINUTE) < want) {
    return guess;
  }
  for (let at = guess - SEARCH_REACH; at <= guess + SEARCH_REACH; at += MINUTE) {
    if (readingAt(timezone, at) >= want) return at;
  }
  return guess;
}

/** How far the clock in a zone is from UTC at a moment. */
function offsetAt(timezone: string, instant: number): number {
  const parts = partsOf(readingAt(timezone, instant));
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // A reading carries no seconds, so the moment it is compared against carries
  // none either.
  return asIfUtc - Math.floor(instant / MINUTE) * MINUTE;
}

/**
 * What the clock in a zone reads at a moment, as one number that sorts the way
 * a clock reads: 2026-09-23 09:00 reads 202609230900.
 */
function readingAt(timezone: string, instant: number): number {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of clockOf(timezone).formatToParts(instant)) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        // Some clocks write midnight as hour 24 of the day before.
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      default:
        break;
    }
  }
  return ((((year * 100 + month) * 100 + day) * 100 + hour) * 100) + minute;
}

type Parts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
};

function partsOf(value: number): Parts {
  return {
    year: Math.floor(value / 100_000_000),
    month: Math.floor(value / 1_000_000) % 100,
    day: Math.floor(value / 10_000) % 100,
    hour: Math.floor(value / 100) % 100,
    minute: value % 100,
  };
}

/** A reading built from a calendar day and a time of day. */
function readingOf(day: Date, hour: number, minute: number): number {
  return (
    ((((day.getUTCFullYear() * 100 + day.getUTCMonth() + 1) * 100 + day.getUTCDate()) * 100 +
      hour) *
      100) +
    minute
  );
}

/** One clock per zone. Building one is the expensive half of reading it. */
const CLOCKS = new Map<string, Intl.DateTimeFormat>();

function clockOf(timezone: string): Intl.DateTimeFormat {
  const held = CLOCKS.get(timezone);
  if (held !== undefined) return held;
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  CLOCKS.set(timezone, clock);
  return clock;
}
