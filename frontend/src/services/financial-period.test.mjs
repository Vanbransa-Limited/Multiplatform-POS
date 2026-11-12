import test from 'node:test';
import assert from 'node:assert/strict';
import { quickFinancialPeriod, tradingDayOf, tradingRange, tradingDayConfig } from './financial-period.js';

// Trading day: 06:00 -> 05:59 next morning, night session from 17:00.
const at = (iso) => new Date(iso);

test('a moment before the morning opening still belongs to the night being worked', () => {
  // 02:00 Saturday is Friday night's trade, not a new Saturday.
  assert.equal(tradingDayOf(at('2026-09-12T02:00:00')), '2026-09-11');
  assert.equal(tradingDayOf(at('2026-09-12T05:59:59')), '2026-09-11');
  // The moment the day opens, the books roll over.
  assert.equal(tradingDayOf(at('2026-09-12T06:00:00')), '2026-09-12');
  assert.equal(tradingDayOf(at('2026-09-12T23:30:00')), '2026-09-12');
});

test('quick ranges anchor on the trading day, so at 2am "today" is the night in progress', () => {
  const small = at('2026-09-12T02:00:00');
  assert.deepEqual(quickFinancialPeriod('today', small), { start: '2026-09-11', end: '2026-09-11' });
  assert.deepEqual(quickFinancialPeriod('yesterday', small), { start: '2026-09-10', end: '2026-09-10' });

  const afternoon = at('2026-09-12T15:00:00');
  assert.deepEqual(quickFinancialPeriod('today', afternoon), { start: '2026-09-12', end: '2026-09-12' });
  // Seven trading days inclusive of today.
  assert.deepEqual(quickFinancialPeriod('week', afternoon), { start: '2026-09-06', end: '2026-09-12' });
});

test('a full trading day runs from the opening to the next opening, covering the whole night', () => {
  const { from, to } = tradingRange('2026-09-11', '2026-09-11', 'full');
  assert.equal(new Date(from).toString(), new Date(2026, 8, 11, 6, 0, 0, 0).toString());
  // Ends the instant before the next morning opens, so 02:00 is included.
  assert.equal(new Date(to).getTime(), new Date(2026, 8, 12, 6, 0, 0, 0).getTime() - 1);
  const twoAm = new Date(2026, 8, 12, 2, 0, 0).getTime();
  assert.ok(twoAm > from && twoAm < to, 'after-midnight trade belongs to the day it started');
});

test('sessions split the trading day and the night wraps past midnight', () => {
  const morning = tradingRange('2026-09-11', '2026-09-11', 'morning');
  assert.equal(new Date(morning.from).getHours(), 6);
  assert.equal(new Date(morning.to).getTime(), new Date(2026, 8, 11, 17, 0, 0, 0).getTime() - 1);

  const night = tradingRange('2026-09-11', '2026-09-11', 'night');
  assert.equal(new Date(night.from).getHours(), 17);
  assert.equal(new Date(night.to).getTime(), new Date(2026, 8, 12, 6, 0, 0, 0).getTime() - 1);
});

test('trading hours are per business, and a nonsensical pair falls back instead of inverting', () => {
  assert.deepEqual(tradingDayConfig({ dayStartHour: 6, nightStartHour: 18 }), { dayStartHour: 6, nightStartHour: 18 });
  // Night before the day would make one session empty and the other inverted.
  assert.deepEqual(tradingDayConfig({ dayStartHour: 18, nightStartHour: 6 }), { dayStartHour: 6, nightStartHour: 17 });
  assert.deepEqual(tradingDayConfig({ dayStartHour: 9, nightStartHour: 9 }), { dayStartHour: 6, nightStartHour: 17 });
  assert.deepEqual(tradingDayConfig(null), { dayStartHour: 6, nightStartHour: 17 });
  assert.deepEqual(tradingDayConfig({ dayStartHour: 'x', nightStartHour: 99 }), { dayStartHour: 6, nightStartHour: 17 });
});

test('an invalid span is refused rather than silently reporting nothing', () => {
  assert.throws(() => tradingRange('2026-09-12', '2026-09-11', 'full'), /valid period/);
  assert.throws(() => quickFinancialPeriod('fortnight'), /Unknown financial period/);
});
