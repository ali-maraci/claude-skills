# Contributing

Low ceremony on purpose. If a skill helped you, it'll probably help someone else.

## Adding a skill

1. Create `skills/<your-skill-name>/SKILL.md`. The folder name and the `name:` in the frontmatter should match.
2. Every skill needs YAML frontmatter with a `name` and a `description` — the `description` is what tells Claude *when* to trigger the skill, so make it specific:

   ```markdown
   ---
   name: my-skill
   description: Use when <the situation>, or when the user says "<trigger phrases>".
   ---

   # My Skill
   ...
   ```
3. If your skill needs supporting files (references, scripts, templates), put them in the same folder and link to them with relative paths.
4. Add a row to the table in [README.md](README.md).
5. Open a PR.

## Adding a prompt / md file that isn't a full skill

Put it under `docs/` with a descriptive filename. A one-liner at the top saying what it's for is plenty.

## Guardrails

- **No secrets, no real personal data.** Synthetic fixtures only, no tokens or keys in examples, and no binary fixtures (images, PDFs) with text in them.
- **Say what a skill assumes.** If it depends on a particular repo layout, an MCP server, or `gh`/Slack being configured, note it so the next person isn't surprised.
- **Keep it self-contained.** A skill someone can install and try in five minutes beats a perfect one nobody adopts.
