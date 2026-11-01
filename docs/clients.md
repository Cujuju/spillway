[← Spillway](../README.md)

# Connect clients

The Proxy page shows the endpoint and the client key. **Apply** writes them into a client's own config; **Undo** reverses it.

| Client | File | Apply sets |
|---|---|---|
| Claude Code | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) | `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_CUSTOM_HEADERS` (`X-Api-Key: <client key>`), and removes `env.ANTHROPIC_AUTH_TOKEN` |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`) | root `openai_base_url = "<endpoint>/backend-api/codex"` at the top |

- The first Apply copies the file to `<file>.spillway-backup` (an empty backup when the file did not exist). Undo removes the backup.
- Claude Code: the key goes in a header so Claude Code keeps its subscription login (it must stay signed in; requests still use the proxy's accounts). In token mode it ignores usage-limit headers, so T3 Code can't snooze a thread until the reset. Apply keeps other `ANTHROPIC_CUSTOM_HEADERS` lines. Undo puts back only these variables' earlier values (or removes them); other edits made since stay.
- Codex: the app's lines sit between `# >>> spillway` and `# <<< spillway` markers. Existing root `model_provider` or `openai_base_url` lines are commented out with `# spillway disabled: `; Undo removes the markers' blocks and restores those lines. Codex keeps its built-in OpenAI provider, pointed at the proxy: a custom provider loses the tools Codex offers only on that provider, such as image generation. A `model_provider` line would switch provider, so Apply turns it off. Apply replaces an older apply's `[model_providers.spillway]` block.
- Codex login: Codex keeps its own ChatGPT login and sends it with every model call. The proxy accepts it when it is an unexpired auth.openai.com token for an account the proxy holds as a Codex credential, so Codex must be signed in to one of the pooled accounts. Account calls (usage, plan, plugins, apps) go to chatgpt.com directly. Apply and Undo remove the pool login earlier versions wrote to `auth.json`.
- A Codex process started before Apply or Undo keeps its old URLs; the page names the apps running Codex (a dev Electron app by its project folder). Restart them (in T3 Code, start a new Codex session).
- Changing the port or regenerating the key marks an applied client **Out of date**; Re-apply updates it. The app never rewrites these files on its own.
- Codex edits are text-level, not parsed TOML: a multi-line string containing a line that starts with `[` or one of those root keys can be misread.

Or set environment variables for Claude Code (the page copies them):

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
$env:ANTHROPIC_CUSTOM_HEADERS = "X-Api-Key: <client key from the Proxy page>"
```
