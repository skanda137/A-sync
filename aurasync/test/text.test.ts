import { describe, expect, it } from 'vitest';
import { norm, sharesWord, slugWords } from '../src/core/text';

describe('text matching', () => {
  it('norm strips accents, case and punctuation', () => {
    expect(norm('Café  “Déjà-Vu”!')).toBe(' cafe deja vu ');
  });
  it('sharesWord matches whole words and long prefixes only', () => {
    expect(sharesWord('specialty coffee', 'Coffee')).toBe(true);
    expect(sharesWord('roast', 'roasted beans')).toBe(true);
    expect(sharesWord('pop', 'popcorn')).toBe(false); // 3-letter words must match exactly
    expect(sharesWord('indie rock', 'Pasta Carbonara')).toBe(false);
  });
  it('slugWords reads the last URN segment', () => {
    expect(slugWords('urn:tag:genre:place:specialty_coffee')).toBe('specialty coffee');
  });
});
