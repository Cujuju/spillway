[← Spillway](../README.md)

# Data

Everything lives in `%APPDATA%\Spillway` (macOS: `~/Library/Application Support/Spillway`):

| Item | Path |
|---|---|
| Settings | `settings.json` |
| Keys | `secrets.bin`, encrypted with DPAPI (Windows) or the Keychain (macOS) |
| Usage history | `usage-history.json` |
| Generated proxy config | `proxy/config.yaml` |
| Your proxy settings | `proxy/config.user.yaml` |
| Account logins | `proxy/auths/` |
| Logs | `proxy/proxy.log` (previous run: `proxy.prev.log`) |

`config.yaml` is generated from the app settings and `config.user.yaml`; don't edit it. Put custom proxy keys (v8 layout) in `config.user.yaml` (Proxy page → Edit config.user.yaml). Saving it applies live; keys the app owns (server, management, routing strategy and affinity, auth dir, first-byte timeout) are replaced by the app's values.

The app manages the proxy with a random password created per launch and passed in `MANAGEMENT_SUPERVISOR_PASSWORD`. A custom proxy executable must support it.

Outside tools use a separate, stable management key from `secrets.bin` (the proxy stores it hashed). T3 Code shows every pooled account's quota with it: Settings → Providers → Usage providers → Add a CLIProxyAPI hub, with the Hub URL and Management key from the Proxy page's T3 Code steps. Use the management key there, not the client key (that gets `401`). Wrong keys from other tools lock 127.0.0.1 out of management: 5 minutes after 5 failures, then 30 minutes after 3 more. The Proxy page's **Management lockouts** row shows them and resets them; the app itself is never locked out.

Activity history: [activity-retention.md](activity-retention.md).
