import { describe, expect, test } from 'vitest';
import { flightsFor, forecast, places, stays } from './seed/index.js';
import { inr } from './money.js';
import { signConfirm, verifyConfirm } from './token.js';
import { comfortPlan, cheapestPlan } from './plan-helpers.js';

describe('core seed bundle', () => {
  test('same inputs are deterministic', () => {
    const left = flightsFor('BLR', 'GOX', '2026-06-30', '2026-06-27');
    const right = flightsFor('BLR', 'GOX', '2026-06-30', '2026-06-27');
    expect(left).toEqual(right);
    expect(stays()).toEqual(stays());
    expect(places()).toEqual(places());
  });

  test('flight pricing and timing bands match the spec', () => {
    const offers = flightsFor('BLR', 'GOX', '2026-06-30', '2026-06-27');
    expect(offers.length).toBeGreaterThanOrEqual(7);
    expect(offers.length).toBeLessThanOrEqual(9);
    expect(offers.every((item) => item.price_per_pax >= 2400)).toBe(true);
    expect(offers.every((item) => item.price_per_pax <= 9500)).toBe(true);
    expect(offers.some((item) => item.depart.includes('05:') || item.depart.includes('06:'))).toBe(true);
    expect(offers.every((item) => item.depart <= '2026-06-30T22:30:00')).toBe(true);
  });

  test('feasibility invariant holds', () => {
    const cheap = cheapestPlan(1, 2);
    const comfy = comfortPlan(1, 2);
    expect(cheap.total).toBeLessThanOrEqual(20000);
    expect(comfy.total).toBeGreaterThan(20000);
  });

  test('forecast pricing rule matches the spec', () => {
    const sunny = forecast('north', '2026-07-04', '2026-07-01');
    const rainy = forecast('south', '2026-07-11', '2026-07-10');
    const nearRain = forecast('central', '2026-07-12', '2026-07-11');
    expect(sunny.rain).toBe(false);
    expect(rainy.rain).toBe(true);
    expect(nearRain.rain).toBe(false);
  });

  test('confirm token round-trips and rejects tamper', () => {
    const token = signConfirm('dev-secret', 'hold_123', 'plan_456');
    expect(verifyConfirm('dev-secret', 'hold_123', 'plan_456', token)).toBe(true);
    expect(verifyConfirm('dev-secret', 'hold_999', 'plan_456', token)).toBe(false);
  });

  test('money formatter uses INR grouping', () => {
    expect(inr(18640)).toBe('₹18,640');
    expect(inr(123456)).toBe('₹1,23,456');
  });
});
