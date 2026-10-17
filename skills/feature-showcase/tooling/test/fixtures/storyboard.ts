// Matches test/fixtures/demo.html (used by the smoke test).
export function sampleStoryboard() {
  return {
    ticket: 'PROJ-123',
    title: 'Details panel',
    scenes: [
      {
        id: 'title',
        kind: 'card',
        card: { heading: 'Details panel', sub: 'Everything about an item, one click away' },
        narration: 'You can now open a details panel for any item.',
      },
      {
        id: 'open-details',
        kind: 'ui',
        surface: 'app-web',
        actions: [
          { do: 'goto', path: '/' },
          { do: 'click', target: { role: 'button', name: 'Show details' } },
          { do: 'waitFor', target: { text: 'Details panel' } },
          { do: 'fill', target: { label: 'Search' }, value: 'invoice' },
        ],
        narration: 'Tap Show details and the panel opens right in place, with search built in.',
      },
      {
        id: 'recap',
        kind: 'card',
        card: { bullets: ['Details in one click', 'Search inside the panel'] },
        narration: 'That is the new details panel.',
      },
    ],
  };
}
