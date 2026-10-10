export type Area = 'north' | 'south' | 'central';
export type PriceBand = 'cheap' | 'mid' | 'premium';

export type FlightOffer = {
  id: string;
  kind: 'flight';
  from: string;
  to: string;
  depart: string;
  arrive: string;
  carrier: string;
  flight_no: string;
  price_per_pax: number;
  stops: 0;
};

export type StayOffer = {
  id: string;
  kind: 'stay';
  name: string;
  area: Area;
  price_per_night: number;
  rating: number;
  tags: string[];
};

export type PlaceOffer = {
  id: string;
  kind: 'food' | 'activity';
  name: string;
  area: Area;
  price_per_head: number;
  tags: string[];
  outdoor: boolean;
};

export type ForecastResult = {
  area: Area;
  date: string;
  as_of: string;
  rain: boolean;
  chance: number;
  summary: string;
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stableRandom(...parts: string[]): () => number {
  const seed = parts.reduce((acc, part) => {
    const hash = hashString(part);
    return (acc ^ hash) >>> 0;
  }, 0x811c9dc5);
  return mulberry32(seed);
}

function parseDay(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function isoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function dateDiffDays(a: string, b: string): number {
  const left = parseDay(isoDate(a)).getTime();
  const right = parseDay(isoDate(b)).getTime();
  return Math.round((left - right) / 86400000);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${pad(hours)}:${pad(mins)}:00`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function flightsFor(origin: string, destination: string, date: string, asOf: string): FlightOffer[] {
  const random = stableRandom(origin, destination, date, asOf);
  const count = 7 + Math.floor(random() * 3);
  const times = [330, 390, 480, 570, 690, 840, 1010, 1210, 1500, 1770, 1980, 1350];
  const carriers = ['AeroMitra', 'SkyFable'];
  const baseFlights: FlightOffer[] = [];
  const daysAhead = Math.max(0, dateDiffDays(date, asOf));

  for (let index = 0; index < count; index += 1) {
    const departMinutes = times[index % times.length] + (index >= times.length ? index * 15 : 0);
    const arriveMinutes = departMinutes + 90 + ((index % 3) * 45);
    const departIso = `${date}T${formatTime(departMinutes)}`;
    const arriveIso = `${date}T${formatTime(arriveMinutes)}`;
    const basePrice = 2600 + Math.round(random() * 6800);
    const nearBoost = clamp(600 + daysAhead * 320, 0, 3600);
    let adjusted = basePrice + nearBoost;
    if (departMinutes < 420) adjusted = Math.max(2400, adjusted - 600);
    if (departMinutes >= 1260) adjusted = Math.max(2400, adjusted - 500);
    const carrier = carriers[index % carriers.length];
    const flightNo = `${carrier.slice(0, 2).toUpperCase()}${String(index + 12).padStart(3, '0')}`;
    baseFlights.push({
      id: `flt_${origin}_${destination}_${date}_${index}`,
      kind: 'flight',
      from: origin,
      to: destination,
      depart: departIso,
      arrive: arriveIso,
      carrier,
      flight_no: flightNo,
      price_per_pax: Math.round(adjusted),
      stops: 0,
    });
  }

  return baseFlights.sort((a, b) => a.price_per_pax - b.price_per_pax);
}

const stayNames = [
  'Moss & Moon', 'Peony Keep', 'White Grove', 'Harbor Nook', 'Cedar Bungalow', 'Ridge Bloom',
  'Copper Lantern', 'Sunline Lodge', 'Drift Haven', 'Tide Deck', 'Pine Arc', 'Kite House',
  'Amber Bloom', 'Palm Court', 'Treetop Vale', 'Lantern Dunes', 'Horizon Nest', 'Dune Crest',
  'Moonwell Rooms', 'Summit Ember', 'Evergreen Ring', 'Maple Quay', 'River Glo', 'Saffron Rest'
];

export function stays(): StayOffer[] {
  const offers: StayOffer[] = [];
  const areas: Area[] = ['north', 'north', 'north', 'north', 'north', 'north', 'north', 'north', 'north', 'north', 'north', 'north', 'south', 'south', 'south', 'south', 'south', 'south', 'south', 'south', 'central', 'central', 'central', 'central'];
  const ratings = [3.5, 3.8, 4.1, 4.4, 4.7, 3.2, 3.9, 4.2, 4.6, 3.7, 4.3, 4.8, 3.6, 4.0, 4.5, 3.4, 4.1, 4.7, 3.8, 4.2, 3.9, 4.3, 4.6, 4.9];

  for (let index = 0; index < stayNames.length; index += 1) {
    const area = areas[index];
    const rating = ratings[index];
    const price = 800 + ((index * 191) % 8600);
    const tags = ['wifi', area === 'north' ? 'hillside' : area === 'south' ? 'beach' : 'civic', 'breakfast'];
    offers.push({
      id: `stay_${index + 1}`,
      kind: 'stay',
      name: stayNames[index],
      area,
      price_per_night: price,
      rating,
      tags,
    });
  }

  return offers;
}

const foodNames = [
  'Saffron Lantern', 'Fern & Crumb', 'Mango Rail', 'Peach Thread', 'Cumin Drift', 'Lime Bloom',
  'Hearth Dune', 'Morn Terrace', 'Basil Wisp', 'Golden Silo', 'Night Market', 'Clover Bowl',
  'Sun Lotus', 'Amber Table', 'Kite Kitchen', 'Mango Lantern', 'Curry Thread', 'Hush Pepper',
  'Canopy Canteen', 'Mint & Map'
];

const activityNames = [
  'Mopa Walk', 'Mango Ridge', 'Sunset Cycle', 'Cedar Boardwalk', 'Harbor Kayaks', 'River Trail',
  'Grove Yoga', 'Lantern Market', 'Stone Path', 'Palm Art', 'Birdwatch Loop', 'Banyan Trek',
  'Skyline Picnic', 'Downtown Flow', 'Dune Run', 'Cove Paddle'
];

export function places(): PlaceOffer[] {
  const offers: PlaceOffer[] = [];
  const areas: Area[] = ['north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'central', 'north', 'south', 'central', 'north'];

  for (let index = 0; index < foodNames.length; index += 1) {
    const area = areas[index];
    const price = 150 + ((index * 83) % 1650);
    offers.push({
      id: `food_${index + 1}`,
      kind: 'food',
      name: foodNames[index],
      area,
      price_per_head: price,
      tags: ['local', index % 2 === 0 ? 'family' : 'quick'],
      outdoor: false,
    });
  }

  for (let index = 0; index < activityNames.length; index += 1) {
    const area = areas[foodNames.length + index];
    const price = (index % 5 === 0 ? 0 : 320 + ((index * 67) % 3200));
    offers.push({
      id: `activity_${index + 1}`,
      kind: 'activity',
      name: activityNames[index],
      area,
      price_per_head: price,
      tags: index % 2 === 0 ? ['outdoor', 'active'] : ['calm', 'guided'],
      outdoor: index % 2 === 0,
    });
  }

  return offers;
}

export function forecast(area: Area, date: string, asOf: string): ForecastResult {
  const safeArea = area;
  const parsedDate = parseDay(date);
  const parsedAsOf = new Date(asOf);
  const daysAhead = Math.round((parsedDate.getTime() - parsedAsOf.getTime()) / 86400000);
  const isSaturday = parsedDate.getUTCDay() === 6;
  const random = stableRandom(safeArea, date, asOf);

  let rain: boolean;
  let chance: number;

  if (isSaturday && daysAhead >= 3) {
    rain = false;
    chance = 18;
  } else if (isSaturday && daysAhead <= 1) {
    rain = true;
    chance = 82;
  } else {
    rain = random() > 0.58;
    chance = Math.round(30 + random() * 50);
  }

  return {
    area: safeArea,
    date: isoDate(date),
    as_of: isoDate(asOf),
    rain,
    chance,
    summary: rain ? 'Rain likely; keep a backup plan.' : 'Mostly clear skies for the day.',
  };
}
