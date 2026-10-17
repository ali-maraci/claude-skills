import type { Card } from '../storyboard';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderCard(card: Card, sb: { ticket: string }, brand?: string): string {
  const bullets = card.bullets?.length ? `<ul>${card.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;justify-content:center;padding:0 160px;box-sizing:border-box;
  background:linear-gradient(135deg,#0f172a,#134e4a);color:#f8fafc;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
.kicker{font-size:28px;letter-spacing:.08em;text-transform:uppercase;color:#5eead4;margin-bottom:24px}
h1{font-size:88px;line-height:1.05;margin:0 0 28px;font-weight:700}
p{font-size:40px;line-height:1.35;margin:0;color:#cbd5e1;max-width:1400px}
ul{font-size:44px;line-height:1.5;margin:24px 0 0;padding-left:1.1em}
li::marker{color:#5eead4}
</style></head><body>
<div class="kicker">${esc(brand ? `${brand} · ${sb.ticket}` : sb.ticket)}</div>
${card.heading ? `<h1>${esc(card.heading)}</h1>` : ''}
${card.sub ? `<p>${esc(card.sub)}</p>` : ''}
${bullets}
</body></html>`;
}
