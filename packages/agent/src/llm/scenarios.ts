export const demoPhrases = ['Weekend in Goa under 20k'];

export const scenarios = [
  {
    id: 'goa-weekend',
    match: /weekend\s+in\s+goa.*under\s*(?:inr\s*)?20k/i,
    budget: 20_000,
  },
] as const;

export const unknownScenarioMessage = `I can help plan a trip. Try: ${demoPhrases.join('; ')}.`;
