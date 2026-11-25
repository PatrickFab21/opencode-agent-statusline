# OpenCode Agent Statusline

A terminal plugin for OpenCode v2 that keeps the main model's context and usage visible while letting you browse the providers used by subagents in the same conversation.

```text
Model: GPT-6.2 Sol (medium) | Provider: OpenAI | Session 5h: 21.0% | Reset: 4hr 9m | Weekly: 3.0%
Context: [█████░░░░░░░░░░░] 209k/628k (33%) | Mem: 25.6G/31.4G
Agents: ◀ 1/2 ▶ Claude Agent | Session 5h: 23.0% | Reset: 3hr 21m | Weekly: 4.0%
```

- The first two rows stay with the current conversation. Browsing agent providers does not switch the main model.
- The third row groups subagents by provider and skips the main provider. Click the arrows or run `/agent-provider` to advance. The row is hidden when there are no other providers to show.
- Claude and ChatGPT/Codex quota figures are account-wide, not per-agent. For Google and other providers without a quota integration, the row shows recorded tokens and estimated cost when available, not provider-wide totals or actual charges.
- Run `/statusline` to view the latest available quota figures. `*` marks a stale reading.

## Install locally

Requires the OpenCode v2 terminal UI. The plugin was exercised on OpenCode 2.4.1 in Windows Terminal.

1. Clone or download the repository to a local directory.
2. Add its path to the existing `plugins` array in `~/.config/opencode/cli.json`. Leave unrelated settings intact.

   ```json
   {
     "$schema": "https://opencode.ai/v2/cli.json",
     "plugins": ["C:/path/to/opencode-agent-statusline"]
   }
   ```

3. Open a session and use `/reload` if needed. If you previously installed a copy under `~/.config/opencode/plugins/`, use only one copy.

## Credentials and limits

The plugin reads existing local Claude Code and OpenCode/Codex sign-ins for subscription usage checks. It does not write or refresh OAuth credentials. Requests use the Anthropic and ChatGPT usage endpoints, whose behavior may change. The plugin caches usage readings locally and backs off after rate-limit responses. Google usage in the status line comes from OpenCode's session records; Google AI Studio is the source for project-wide limits.

## Tests

```sh
node --test
```

The tests use synthetic session data and do not access your credentials or the network. Use Node.js 24 or newer.
