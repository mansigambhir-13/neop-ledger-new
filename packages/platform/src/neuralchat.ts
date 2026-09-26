/** One installed app as NeuralChat sees it (registry context, 5a). */
export interface RegistryEntry {
  key: string;
  name: string;
  subject: string;
  description: string;
  abilities: { key: string; title: string; description: string; needs_yes: boolean }[];
}

/**
 * Pilot stand-in for NeuralChat's app choice (step 3). NeuralChat proper
 * reasons over this same registry context; the stand-in scores the ask
 * against each installed app's words. Only installed apps are candidates.
 */
export function pickApp(ask: string, apps: RegistryEntry[]): string | null {
  const words = new Set(ask.toLowerCase().match(/[a-z&]{3,}/g) ?? []);
  let best: { key: string; score: number } | null = null;
  for (const a of apps) {
    const text = [a.name, a.subject, a.description, ...a.abilities.flatMap((x) => [x.title, x.description])].join(' ').toLowerCase();
    const vocab = new Set(text.match(/[a-z&]{3,}/g) ?? []);
    let score = 0;
    for (const w of words) if (vocab.has(w)) score++;
    if (score > 0 && (!best || score > best.score)) best = { key: a.key, score };
  }
  return best?.key ?? null;
}
