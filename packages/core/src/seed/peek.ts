import { flightsFor, forecast, places, stays } from './index.js';

const flight = flightsFor('BLR', 'GOX', '2026-06-30', '2026-06-27')[0];
const stay = stays()[0];
const place = places()[0];
const weather = forecast('north', '2026-07-04', '2026-07-01');

console.log(`flight ${flight.carrier} ${flight.flight_no} ${flight.price_per_pax}`);
console.log(`stay ${stay.name} ${stay.area} ${stay.price_per_night}`);
console.log(`place ${place.name} ${place.kind} ${place.price_per_head}`);
console.log(`forecast ${weather.area} ${weather.rain ? 'rain' : 'sunny'} ${weather.chance}%`);
