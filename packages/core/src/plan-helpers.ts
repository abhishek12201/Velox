import { flightsFor, places, stays } from './seed/index.js';

export function cheapestPlan(pax = 1, nights = 2) {
  const flight = flightsFor('BLR', 'GOX', '2026-06-30', '2026-06-27')[0];
  const stay = stays().filter((item) => item.area === 'north').sort((a, b) => a.price_per_night - b.price_per_night)[0];
  const cheapFood = places().filter((item) => item.kind === 'food').sort((a, b) => a.price_per_head - b.price_per_head)[0];
  const cheapActivity = places().filter((item) => item.kind === 'activity').sort((a, b) => a.price_per_head - b.price_per_head)[0];
  const total = flight.price_per_pax * pax + stay.price_per_night * nights + cheapFood.price_per_head * pax + cheapActivity.price_per_head * pax;
  return {
    total,
    flight,
    stay,
    cheapFood,
    cheapActivity,
  };
}

export function comfortPlan(pax = 1, nights = 2) {
  const flight = flightsFor('BLR', 'GOX', '2026-06-30', '2026-06-27').at(-1) ?? flightsFor('BLR', 'GOX', '2026-06-30', '2026-06-27')[0];
  const stay = stays().sort((a, b) => b.rating - a.rating)[0];
  const premiumFood = places().filter((item) => item.kind === 'food').sort((a, b) => b.price_per_head - a.price_per_head)[0];
  const premiumActivity = places().filter((item) => item.kind === 'activity').sort((a, b) => b.price_per_head - a.price_per_head)[0];
  const total = flight.price_per_pax * pax + stay.price_per_night * nights + premiumFood.price_per_head * pax + premiumActivity.price_per_head * pax;
  return {
    total,
    flight,
    stay,
    premiumFood,
    premiumActivity,
  };
}
