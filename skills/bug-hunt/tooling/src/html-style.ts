// Stylesheet for report.html. Tokens on :root, redefined for dark mode, so the page follows the viewer's theme.
export const REPORT_CSS = `
:root {
  --bg: #f5f7f8; --surface: #ffffff; --fg: #17252b; --muted: #5b6b72; --line: #dde4e7;
  --accent: #237a93; --accent-soft: #e2f0f4;
  --blocker: #b42318; --major: #c4320a; --minor: #b7791f; --cosmetic: #4f6d8f; --info: #6b7a80;
  --ok: #2f7d4f; --ok-soft: #e3f2e8; --bad: #b42318; --bad-soft: #fbe9e7; --warn: #8a6d1f; --warn-soft: #f7efd9;
  --font-body: "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f1719; --surface: #162125; --fg: #e3ecef; --muted: #93a5ac; --line: #26363b; --accent: #5fb7d0; --accent-soft: #17323a;
  --blocker: #f97066; --major: #fb8c5a; --minor: #e8b04b; --cosmetic: #8fb0d6; --info: #9aabb1;
  --ok: #6cc890; --ok-soft: #173326; --bad: #f97066; --bad-soft: #3a1d1b; --warn: #e3c46a; --warn-soft: #33301a; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0f1719; --surface: #162125; --fg: #e3ecef; --muted: #93a5ac; --line: #26363b; --accent: #5fb7d0; --accent-soft: #17323a;
  --blocker: #f97066; --major: #fb8c5a; --minor: #e8b04b; --cosmetic: #8fb0d6; --info: #9aabb1;
  --ok: #6cc890; --ok-soft: #173326; --bad: #f97066; --bad-soft: #3a1d1b; --warn: #e3c46a; --warn-soft: #33301a; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: var(--font-body); font-size: 15px; line-height: 1.55; }
.wrap { max-width: 980px; margin: 0 auto; padding-inline: 20px; padding-block: 36px 64px; display: grid; gap: 40px; }
h1, h2, h3 { text-wrap: balance; margin: 0; line-height: 1.25; }
h1 { font-size: clamp(26px, 4vw, 36px); font-weight: 700; letter-spacing: -0.02em; }
h2 { font-size: 21px; font-weight: 650; }
h3 { font-size: 16px; font-weight: 600; }
p { margin: 0; max-width: 72ch; }
section, header { display: grid; gap: 14px; min-width: 0; }
.eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }
.muted { color: var(--muted); }
code { font-family: var(--font-mono); font-size: 0.86em; background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.stat { background: var(--surface); padding: 14px 16px; display: grid; gap: 2px; }
.stat b { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat span { font-size: 13px; color: var(--muted); }
.stat.good b { color: var(--ok); } .stat.alert b { color: var(--bad); }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; min-width: 0; }
.diagram { overflow-x: auto; }
.diagram pre.mermaid { margin: 0; display: flex; justify-content: center; min-width: 520px; background: transparent; }
.bars { display: grid; gap: 8px; }
.bar { display: grid; grid-template-columns: 96px 1fr 36px; gap: 12px; align-items: center; font-size: 13px; }
.track { height: 12px; background: var(--bg); border-radius: 3px; overflow: hidden; }
.fill { height: 100%; border-radius: 3px; }
.bar .v { font-family: var(--font-mono); text-align: right; font-variant-numeric: tabular-nums; }
.cards { display: grid; gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--sev); border-radius: 10px; padding: 16px 18px; display: grid; gap: 10px; min-width: 0; }
.card.blocker { --sev: var(--blocker); } .card.major { --sev: var(--major); } .card.minor { --sev: var(--minor); }
.card.cosmetic { --sev: var(--cosmetic); } .card.info { --sev: var(--info); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 13px; color: var(--muted); align-items: center; }
.sev { font-family: var(--font-mono); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sev); }
.tag { font-family: var(--font-mono); font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; overflow-wrap: anywhere; }
ol { margin: 0; padding-left: 20px; display: grid; gap: 2px; }
.ea { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.ea div { display: grid; gap: 2px; min-width: 0; }
.label { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.shots a { display: block; } .shots img { width: 100%; display: block; border: 1px solid var(--line); border-radius: 6px; }
.ev { font-family: var(--font-mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.cell { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.cell .id { font-family: var(--font-mono); font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
.modes { display: flex; gap: 4px; flex-shrink: 0; }
.dot { min-width: 24px; height: 20px; padding: 0 4px; border-radius: 4px; font-family: var(--font-mono); font-size: 10px; display: grid; place-items: center; }
.dot.ok { color: var(--ok); background: var(--ok-soft); } .dot.incomplete { color: var(--warn); background: var(--warn-soft); }
.dot.setup-failed { color: var(--bad); background: var(--bad-soft); } .dot.none { color: var(--muted); background: var(--bg); }
details { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; }
summary { cursor: pointer; font-weight: 600; }
details ul { margin: 10px 0 0; padding-left: 18px; display: grid; gap: 6px; font-size: 14px; }
details li { overflow-wrap: anywhere; }
footer { font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 14px; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 560px) { .bar { grid-template-columns: 76px 1fr 28px; } }
`;
