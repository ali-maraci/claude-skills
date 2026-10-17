# Storyboard format

`<SHOWCASE_OUTPUT_DIR>/<KEY>/storyboard.json` — validated by `feature-showcase validate <KEY>`.

## Shape

```jsonc
{
  "ticket": "PROJ-123",                 // must equal the KEY you run with
  "title": "Usage trends",
  "setup": [                           // optional, NOT recorded — prepare state
    { "surface": "portal", "actions": [ { "do": "goto", "path": "/items" } ] }
  ],
  "scenes": [
    { "id": "title", "kind": "card",
      "card": { "heading": "Usage trends", "sub": "See how each item is used over time" },
      "narration": "You can now see how each item is used over time." },
    { "id": "open-trends", "kind": "ui", "surface": "app-web",
      "actions": [
        { "do": "goto", "path": "/items" },
        { "do": "click", "target": { "role": "button", "name": "Trends" } },
        { "do": "hover", "target": { "text": "Weekly" } }
      ],
      "narration": "From the items list, one tap on Trends shows each item's usage as a simple line over time." },
    { "id": "recap", "kind": "card",
      "card": { "bullets": ["Trends in one tap", "Usage for every item over time"] },
      "narration": "That's usage trends — live on staging now." }
  ]
}
```

- `kind: "card"` — full-screen title/recap slide; needs `heading` or `bullets` (≤5). First scene **must** be a card (title), last **must** be a card (recap).
- `kind: "ui"` — `surface` is `app-web` or `portal`; `goto.path` is relative to that surface's staging URL (the portal base URL may include a path prefix). A `goto` may set `"surface"` to jump to the other app.
- Scene `id`: lowercase kebab-case, unique.
- **Every action runs at least three times** on shared staging: the `dry-run` step, `produce`'s own dry run (so a broken storyboard never spends ElevenLabs credit), and the recording — plus any repair loops. `setup` must bring the data to the same state however many times it runs, and scenes must either change nothing that persists or undo their own changes. A scene that submits a form or flips a toggle shows a duplicate row or the opposite state on the second run.
- A UI scene that follows a card **must** open with `goto`: the card replaced the page, so there is nothing to act on until the scene navigates back to staging.
- A UI scene that opens with `goto` loads that page before its narration starts, so slow staging adds silence, not narration over the previous frame.

## Actions

| `do` | fields | notes |
|---|---|---|
| `goto` | `path` (starts `/`), `surface?` | waits for load + network idle |
| `click` | `target` | cursor glides to the element, ripple on click |
| `hover` | `target` | lingers ~0.6 s |
| `fill` | `target`, `value` | types visibly; synthetic/obviously-fake values only |
| `scroll` | `y` (px, +down) | |
| `waitFor` | `target` | up to 15 s |
| `pause` | `ms` (≤10000) | |

`click`, `hover` and `fill` already wait up to 15 s for their target to be visible, so don't put a `waitFor` in front of them.

`target` is exactly one of `{ "role", "name" }`, `{ "label" }`, `{ "text" }`, `{ "testId" }` — copied from `probe` output.

## Narration style

- Audience: internal team + stakeholders. Present tense, benefit first, then what we see.
- 1–2 sentences per scene; **≤300 words total** (~2 min). The content decides the scene count.
- No implementation words: endpoint, migration, PR, API, component, refactor.
- Write numbers and symbols as words ("twenty minutes", "percent") — the narration must come back from ElevenLabs verbatim so it can be split per scene.
- The scene's actions should finish before its narration does; if a scene needs more on-screen time, give it more narration rather than `pause`s.
