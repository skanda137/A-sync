// Text matching shared by the Analyst (is this Qloo hit really what we asked for?) and the Auditor
// (does the brief text actually use the thing it cites?). One definition, one behaviour.

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'your', 'our', 'out', 'all', 'new', 'are', 'you']);

/** Lowercased, accent-stripped, punctuation-free, padded with spaces so `includes` matches whole words. */
export function norm(s: string): string {
  return ` ${s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

export function words(s: string): string[] {
  return norm(s).trim().split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}

// "coffee" ~ "coffees", "roast" ~ "roasted"; shorter words must match exactly.
const near = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** True when any significant word of `a` matches any significant word of `b`. */
export function sharesWord(a: string, b: string): boolean {
  const wb = words(b);
  return words(a).some((x) => wb.some((y) => near(x, y)));
}

/** "urn:tag:genre:place:specialty_coffee" -> "specialty coffee" (last URN segment). */
export function slugWords(urn: string): string {
  return (urn.split(':').pop() ?? urn).replace(/[_-]+/g, ' ');
}
