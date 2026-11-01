[← Spillway](../README.md)

# Security and terms

Read this before you use Spillway.

## Provider terms

Spillway lets you use several of your own subscription accounts without signing out and in. It does that by running their logins through a local proxy rather than the providers' own apps.

- Using a subscription login outside the provider's apps, or pooling several accounts, may break a provider's terms. Providers can limit or close accounts for it. Read each provider's current terms; Spillway doesn't check them.
- When an account runs out, routing sends requests to another account. A provider may treat that as getting around its usage limits, whatever the intent.
- The proxy disguises requests by default (upstream settings): Claude-account requests from clients other than Claude Code are made to look like Claude Code, system prompt included (`disable-claude-cloak-mode: false`), and Codex-account requests get Codex's User-Agent and Originator headers (`disable-codex-cloaking: false`).

## What each secret unlocks

| Secret | Stored in | Anyone holding it can |
|---|---|---|
| Account logins (OAuth tokens) | `proxy/auths/*.json`, unencrypted | act as that account at the provider until the login is revoked |
| Management key | `secrets.bin` (encrypted); the proxy keeps only a hash | read every account login (auth-file download, `api-call` with any account's token) and change the proxy's config, from this machine only |
| Supervisor password | the proxy's environment, new each launch, never on disk | the same as the management key |
| Client key | `secrets.bin`, and in plain text in `~/.claude/settings.json` and anywhere you paste it | spend every pooled account's quota |
| Codex's own ChatGPT login | `~/.codex/auth.json`, written by Codex | its usual ChatGPT access, and, while that account is in the pool, the client key's access too |

The client key can't reach a ChatGPT account's data. Codex's account calls (usage, plan, plugins, cloud tasks) go to chatgpt.com with Codex's own login; the proxy serves only model, image and search calls, plus Codex's model list.

## Exposure

- **Network.** The proxy listens on 127.0.0.1. **Allow LAN connections** makes it listen on every interface over plain HTTP: the client key crosses the network unencrypted, and anyone who has it can use the pool. Management stays local-only either way.
- **This machine.** Any program running as you can read the account logins and the client key. Spillway doesn't defend against malware on your machine.
- **Codex accounts.** Codex's model calls run on whichever pooled account routing picks, not necessarily the one Codex is signed in to. Pool only your own accounts.
- **Outside tools.** T3 Code's usage hub gets the management key, so it can read every account login.
- **Logs.** Failed requests are logged with their full request body (prompts and code) in `proxy/auths/logs/`. The Activity page's history stores only metadata (account, model, status, tokens, timing).
- **Custom proxy executable.** It runs with every account login. Point it only at a build you trust.
