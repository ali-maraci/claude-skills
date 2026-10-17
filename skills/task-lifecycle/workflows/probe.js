export const meta = {
  name: 'task-lifecycle-probe',
  description: 'One Haiku agent reports which tools, skills and MCP servers a workflow subagent can actually reach. Run once before adopting the lifecycle scripts.',
  phases: [{ title: 'Probe', detail: 'single Haiku agent, no task performed', model: 'haiku' }],
}

// Settles the load-bearing unknowns of the lifecycle design:
//  - is the Skill tool present (tdd / receiving-code-review / verify are invoked by name inside agents)?
//  - is the Agent tool present (the built-in code-review / security-review skills fan out through it)?
//  - can ToolSearch load Playwright, Maestro, Atlassian and Slack MCP tools?
//  - is CLAUDE.md injected (the authoring reference says yes for the default workflow agent)?
const PROBE = {
  type: 'object',
  required: ['tools', 'hasSkillTool', 'skillLoaded', 'hasAgentTool', 'mcpFound', 'mcpMissing', 'claudeMdFirstHeading', 'contextNotes'],
  properties: {
    tools: { type: 'array', items: { type: 'string' } },
    hasSkillTool: { type: 'boolean' },
    skillLoaded: { type: 'boolean' },
    hasAgentTool: { type: 'boolean' },
    mcpFound: { type: 'array', items: { type: 'string' } },
    mcpMissing: { type: 'array', items: { type: 'string' } },
    claudeMdFirstHeading: { type: 'string' },
    contextNotes: { type: 'string' },
  },
}

phase('Probe')
const r = await agent(`Do not perform any task and do not edit anything. Report, exactly:
1. tools: the exact names of every tool available to you right now (as listed in your tool definitions), including deferred ones if you can see their names.
2. hasSkillTool: whether a tool named "Skill" exists. If it does, call it with skill "superpowers:receiving-code-review" and set skillLoaded to whether its content loaded (do not follow the skill).
3. hasAgentTool: whether a tool named "Agent" (or "Task") exists. Do not call it.
4. Call ToolSearch once with query "select:mcp__playwright__browser_navigate,mcp__maestro__list_devices,mcp__claude_ai_Atlassian_Rovo__getJiraIssue,mcp__claude_ai_Slack__slack_send_message" and report which names came back in mcpFound and which did not in mcpMissing. Do not call any of them.
5. claudeMdFirstHeading: the first markdown heading of any CLAUDE.md content present in your context, or "none".
6. contextNotes: one line on anything else notable (e.g. memory files present, skills listing present, system prompt size hints).`,
  { label: 'probe', phase: 'Probe', model: 'haiku', effort: 'low', schema: PROBE })

return r
