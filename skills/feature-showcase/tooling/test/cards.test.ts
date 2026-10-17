import { describe, expect, it } from 'vitest';
import { renderCard } from '../src/browser/cards';

describe('renderCard', () => {
  it('renders heading, sub, bullets and ticket, escaping HTML', () => {
    const html = renderCard({ heading: 'A <b>new</b> view', sub: 'Sub', bullets: ['One & two'] }, { ticket: 'PROJ-1' });
    expect(html).toContain('A &lt;b&gt;new&lt;/b&gt; view');
    expect(html).toContain('<li>One &amp; two</li>');
    expect(html).toContain('PROJ-1');
  });

  it('prefixes the kicker with the brand when one is configured', () => {
    const html = renderCard({ heading: 'H' }, { ticket: 'PROJ-123' }, 'Example App');
    expect(html).toContain('<div class="kicker">Example App · PROJ-123</div>');
  });

  it('shows only the ticket when there is no brand', () => {
    const html = renderCard({ heading: 'H' }, { ticket: 'PROJ-123' });
    expect(html).toContain('<div class="kicker">PROJ-123</div>');
  });
});
