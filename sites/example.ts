import type { Site } from '../src/site.ts';

export default {
  baseURL: 'https://example.test',
  pages: ['/', '/about/'],
  // Third parties to save with the references and replay, such as an embedded form. All others are blocked.
  replay: /forms\.example\.test/,
} satisfies Site;
