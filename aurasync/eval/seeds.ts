import type { Seed } from '../src/core/types';

// Five predefined seeds across cities and audiences (slide 8 success test).
export const SEEDS: Seed[] = [
  { concept: 'a café', audience: 'friend group in their mid 20s', city: 'Bengaluru', ageBand: '25_to_29' },
  { concept: 'a streetwear pop-up', audience: 'college students and Gen Z creators', city: 'Mumbai', ageBand: '24_and_younger' },
  { concept: 'a rooftop listening bar', audience: 'young professionals who love indie music', city: 'Delhi', ageBand: '30_to_34' },
  { concept: 'a bookstore café', audience: 'remote workers and freelancers', city: 'London', ageBand: '30_to_34' },
  { concept: 'a sneaker and coffee pop-up', audience: 'design-minded twenty-somethings', city: 'New York', ageBand: '25_to_29' },
];
