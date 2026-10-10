import { z } from 'zod';

export const FlightOfferSchema = z.object({
  id: z.string(),
  kind: z.literal('flight'),
  from: z.string(),
  to: z.string(),
  depart: z.string(),
  arrive: z.string(),
  carrier: z.string(),
  flight_no: z.string(),
  price_per_pax: z.number().int(),
  stops: z.literal(0),
});

export const StayOfferSchema = z.object({
  id: z.string(),
  kind: z.literal('stay'),
  name: z.string(),
  area: z.enum(['north', 'south', 'central']),
  price_per_night: z.number().int(),
  rating: z.number(),
  tags: z.array(z.string()),
});

export const PlaceOfferSchema = z.object({
  id: z.string(),
  kind: z.enum(['food', 'activity']),
  name: z.string(),
  area: z.enum(['north', 'south', 'central']),
  price_per_head: z.number().int(),
  tags: z.array(z.string()),
  outdoor: z.boolean(),
});

export const HoldSchema = z.object({
  hold_id: z.string(),
  server: z.enum(['air', 'stay', 'local', 'vault']),
  offer_id: z.string(),
  amount: z.number().int(),
  qty: z.number().int(),
  expires_at: z.string(),
  state: z.enum(['held', 'confirmed', 'released', 'expired', 'cancelled']),
});

export const PlanSchema = z.object({
  plan_id: z.string(),
  session_id: z.string(),
  kind: z.enum(['trip', 'swap']),
  hold_ids: z.array(z.string()),
  total: z.number().int(),
  budget: z.number().int(),
  created: z.string(),
});

export const CarouselItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  price: z.number().int().optional(),
  badges: z.array(z.string()),
  offer_id: z.string().optional(),
});

export const CarouselSchema = z.object({
  id: z.string(),
  title: z.string(),
  items: z.array(CarouselItemSchema),
  speech: z.string(),
  kind: z.literal('carousel'),
});

export const ItineraryItemSchema = z.object({
  time: z.string().optional(),
  title: z.string(),
  kind: z.string(),
  amount: z.number().int().optional(),
  hold_id: z.string().optional(),
  status: z.string(),
});

export const ItineraryDaySchema = z.object({
  label: z.string(),
  items: z.array(ItineraryItemSchema),
});

export const ItinerarySchema = z.object({
  plan_id: z.string(),
  title: z.string(),
  days: z.array(ItineraryDaySchema),
  total: z.number().int(),
  budget: z.number().int(),
  remaining: z.number().int(),
  expires_at: z.string(),
  status: z.enum(['proposed', 'confirmed', 'failed', 'rolled_back']),
  speech: z.string(),
  kind: z.literal('itinerary'),
});

export const NudgeSchema = z.object({
  id: z.string(),
  text: z.string(),
  action_label: z.string(),
  plan_id: z.string().optional(),
  speech: z.string(),
  kind: z.literal('nudge'),
});

export const CardSchema = z.discriminatedUnion('kind', [
  CarouselSchema,
  ItinerarySchema,
  NudgeSchema,
]);

export const ErrorResultSchema = z.object({
  isError: z.literal(true),
  structuredContent: z.object({
    code: z.enum(['NOT_FOUND', 'SOLD_OUT', 'HOLD_EXPIRED', 'FORBIDDEN', 'INVALID']),
    message: z.string(),
    retryable: z.boolean(),
  }),
});

export const SseSaySchema = z.object({
  type: z.literal('say'),
  text: z.string(),
  speech: z.string().optional(),
});

export const SseCallSchema = z.object({
  type: z.literal('call'),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  args: z.record(z.any()),
  ts: z.string(),
});

export const SseResultSchema = z.object({
  type: z.literal('result'),
  id: z.string(),
  ms: z.number(),
  ok: z.boolean(),
  summary: z.string(),
});

export const SseCardSchema = z.object({
  type: z.literal('card'),
  card: CardSchema,
});

export const SseChipSchema = z.object({
  type: z.literal('chip'),
  text: z.string(),
});

export const SseRecoverySchema = z.object({
  type: z.literal('recovery'),
  step: z.number(),
  detail: z.string(),
});

export const SseNudgeSchema = z.object({
  type: z.literal('nudge'),
  card: NudgeSchema,
});

export const SseClockSchema = z.object({
  type: z.literal('clock'),
  now: z.string(),
});

export const SseErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const SseDoneSchema = z.object({
  type: z.literal('done'),
});

export const SseEventSchema = z.discriminatedUnion('type', [
  SseSaySchema,
  SseCallSchema,
  SseResultSchema,
  SseCardSchema,
  SseChipSchema,
  SseRecoverySchema,
  SseNudgeSchema,
  SseClockSchema,
  SseErrorSchema,
  SseDoneSchema,
]);

export type FlightOffer = z.infer<typeof FlightOfferSchema>;
export type StayOffer = z.infer<typeof StayOfferSchema>;
export type PlaceOffer = z.infer<typeof PlaceOfferSchema>;
export type Hold = z.infer<typeof HoldSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type CarouselItem = z.infer<typeof CarouselItemSchema>;
export type Carousel = z.infer<typeof CarouselSchema>;
export type ItineraryItem = z.infer<typeof ItineraryItemSchema>;
export type ItineraryDay = z.infer<typeof ItineraryDaySchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
export type Nudge = z.infer<typeof NudgeSchema>;
export type Card = z.infer<typeof CardSchema>;
export type ErrorResult = z.infer<typeof ErrorResultSchema>;
export type SseEvent = z.infer<typeof SseEventSchema>;
