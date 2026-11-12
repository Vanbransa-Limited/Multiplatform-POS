/**
 * Trading days, not calendar days.
 *
 * A night's trade crosses midnight, so booking money to the calendar date it
 * landed on splits one night across two reports - which is exactly what makes
 * last night's takings look missing. A trading day therefore runs from
 * dayStart one morning to dayStart the next, and is split into the two
 * sessions the floor actually works:
 *
 *   morning  dayStart   -> nightStart      (05:00 -> 17:00)
 *   night    nightStart -> dayStart + 1d   (17:00 -> 05:00)
 *
 * Both sessions belong to the trading day the morning started, so a sale rung
 * at 02:00 on Saturday belongs to Friday's books, where the person who worked
 * that night expects to find it.
 */

/**
 * Overridden per business from tenant_settings; these are the fallbacks.
 *
 * The trading day opens at 06:00 and runs to 05:59 the next morning, which is
 * how this business keeps its books: a night that ends at four in the morning
 * belongs to the day it started.
 */
export const DEFAULT_TRADING_DAY = { dayStartHour: 6, nightStartHour: 17 };

export function tradingDayConfig(settings) {
  const hour = (value, fallback) => (Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback);
  const dayStartHour = hour(settings?.dayStartHour, DEFAULT_TRADING_DAY.dayStartHour);
  const nightStartHour = hour(settings?.nightStartHour, DEFAULT_TRADING_DAY.nightStartHour);
  // A night that starts before the day has begun is not a night; fall back
  // rather than silently producing an empty or inverted session.
  return nightStartHour > dayStartHour
    ? { dayStartHour, nightStartHour }
    : { ...DEFAULT_TRADING_DAY };
}

const asLocalDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** The trading day a moment belongs to. Before dayStart, that is yesterday. */
export function tradingDayOf(now = new Date(), config = DEFAULT_TRADING_DAY) {
  const { dayStartHour } = tradingDayConfig(config);
  const shifted = new Date(now);
  if (shifted.getHours() < dayStartHour) shifted.setDate(shifted.getDate() - 1);
  return asLocalDate(shifted);
}

/** Rolling report shortcuts, inclusive of today's trading day. */
export function quickFinancialPeriod(period, now = new Date(), config = DEFAULT_TRADING_DAY) {
  const offsets = { today: 0, yesterday: 1, week: 6, month: 29 };
  if (!(period in offsets)) throw new Error('Unknown financial period.');
  // Anchored on the trading day, so at 02:00 "today" is still the night that
  // is currently being worked rather than a day that has barely begun.
  const [year, month, day] = tradingDayOf(now, config).split('-').map(Number);
  const end = new Date(year, month - 1, day);
  if (period === 'yesterday') end.setDate(end.getDate() - 1);
  const start = new Date(end);
  if (period !== 'yesterday') start.setDate(start.getDate() - offsets[period]);
  return { start: asLocalDate(start), end: asLocalDate(end) };
}

/**
 * The wall-clock window covered by a span of trading days.
 *
 * `session` narrows to one half of each day; the snapshot applies that per day
 * across the span, because this window is only the outer bound.
 */
export function tradingRange(startStr, endStr, session = 'full', config = DEFAULT_TRADING_DAY) {
  const { dayStartHour, nightStartHour } = tradingDayConfig(config);
  if (!startStr || !endStr || startStr > endStr) throw new Error('Choose a valid period.');
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);

  const from = new Date(sy, sm - 1, sd, session === 'night' ? nightStartHour : dayStartHour, 0, 0, 0);
  const to = new Date(ey, em - 1, ed);
  if (session === 'morning') {
    to.setHours(nightStartHour, 0, 0, -1);
  } else {
    // Both "full" and "night" run past midnight into the following morning.
    to.setDate(to.getDate() + 1);
    to.setHours(dayStartHour, 0, 0, -1);
  }
  return { from: from.getTime(), to: to.getTime(), session, dayStartHour, nightStartHour };
}
