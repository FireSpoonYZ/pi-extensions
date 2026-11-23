# Engines

Turns run through one of two engines behind the same provider surface (`config.engine`, default `acp`). A first-run picker explains the choices, and `/agy engine` reopens it. Direct switches work too: `/agy engine acp|stream-json`. Restart applies the switch.

Both engines require the same `agy` CLI installation and use its cached Google credentials. There is no separate ACP binary or second sign-in.

- **acp** (default): `agy acp`, JSON-RPC 2.0 over stdio. Verified live on agy 1.5.3 with text streaming, exact token usage, session resume, bridge tools, separate model/thinking options, and notification-based cancellation.
- **stream-json** (fallback): a persistent `agy` CLI process using the stream-json protocol. Live token usage and conversation resume via `--conversation`.

## First run and CLI setup

On a fresh install, the first interactive pi start opens the engine picker. `acp` is preselected; `esc` decides later and writes nothing.

If `agy` is missing, interactive pi asks once per process before running Google's official installer without blocking bridge startup. Linux and macOS run `set -o pipefail; curl -fsSL https://antigravity.google/cli/install.sh | bash`. Windows PowerShell runs `irm https://antigravity.google/cli/install.ps1 | iex`. Headless sessions print instructions once and never install automatically. A bad explicit `AGY_BIN` gets correction instructions instead of a useless install.

After installation, the bridge verifies that agy is available, then asks you to run `agy` in a terminal, complete Google sign-in, and restart pi. ACP requires agy 1.5.3 or newer. An older installation triggers the same confirmed installer offer. `/agy engine acp` checks availability immediately.

Existing installs clean up the retired ACP server only under `~/.local/opt/agy-acp`. A build must contain `agy_acp_server.par` plus `zip.sha256`, the unpacked `localharness_external` directory, or a matching interrupted `.download-<build>.zip` archive. Interrupted archives and empty build directories are removed too. The managed `current` symlink is removed with those builds. Unmarked binaries, unrelated files, and custom installation paths stay untouched. The retired `acp.bin` key is removed from `~/.pi/agent/antigravity-bridge/config.json` automatically at startup; the rest of the file keeps its shape. A set `AGY_ACP_BIN` environment variable cannot be removed by the bridge; it is ignored and warns with removal instructions. If the config rewrite fails, the warning names the file and the manual fix. Retired `~/.gemini/antigravity-acp` credentials are not deleted automatically; `/agy doctor` identifies them for manual removal.

## Capabilities

| Capability | `stream-json` | `acp` |
| --- | --- | --- |
| Show thinking text | No (token count only) | Yes, when the server sends thought chunks |
| Token usage | Live CLI metrics | Exact server usage; client estimates remain a fallback |
| Image prompt input | Staged temp files plus bridge read tool | Native image blocks |
| Image tool results | Yes | Yes |
| Review-only provider turns | Refused; the CLI does not enforce plan read-only | Refused by the bridge |
| Dynamic model / effort switch | Recycles process on drift | Per-turn `model` and `thought_level` config options |
| Process lifecycle | Persistent `agy` process | Persistent `agy acp` process |
| Session resume | `--conversation <id>` | `session/load` and `session/new` (versioned session key preserves legacy ACP conversations without reusing them automatically) |
| Turn cancel | Kills process group | `session/cancel` notification, with teardown fallback |
| MCP tool bridge | Isolated per-session MCP home (`--gemini_dir`); global registration is the probe-verified fallback (`bridgeTools: all` includes active Pi builtins) | Injects only the current Pi bridge via `mcpServers` and explicit private agent frontmatter (no foreign global MCP, global config untouched); generated restricted agent removes workspace file/shell tools (`tools: []`) and carries the live MCP tool catalog + JSON Schemas + `call_mcp_tool` convention in the body (`all` includes active Pi builtins; `mcp` adapter + skills only; `none` exposes no Pi tools) |
| Tool visibility | Native re-exec plus wrapper replay (plus genuine Pi cards for bridged tools) | Genuine Pi tool cards via MCP bridge round-trips (`call_mcp_tool` -> `toolUse -> Pi executes -> toolResult completes MCP`); display-only native ACP cards retained as event compatibility |
| Context digest | Inline prompt text | `embeddedContext` resource block |
| System prompt | Staged agy agent file (`--agent`; `/agy agent` is stream-json only) | Carried in generated restricted custom agent body (`--agent generated`, `--include-default-customizations=false`); `systemPrompt: false` omits Pi text only while retaining the bridge protocol and live tool catalog |
| Authentication | Shared `agy` CLI credentials | Shared `agy` CLI credentials |
| Wire protocol | CLI NDJSON stream | JSON-RPC 2.0 over stdio |

## Switching and authentication

Switch with `/agy engine acp|stream-json`, then restart pi. `/agy auth` and `/agy auth-manual` show the shared CLI authentication instructions. `/agy doctor` checks the CLI version and reports the active ACP server version without spending tokens. Sessions are engine-scoped, so switching engines never crosses conversations.

## Restricted ACP profile and tool catalog

On `acp`, the provider spawns `agy acp` as a generated restricted custom agent (`--agent generated`, `--include-default-customizations=false`) configured with `excludeDefaultComponents: true`, `tools: []`, `inheritMcp: true`, `inheritCustomizations: false`, and empty `skills`/`rules`/`agents`/`hooks`/`plugins`. The private agent frontmatter declares an explicit list-of-objects entry for the current session's `pi-bridge` MCP server (no foreign global MCP entries; `session/new` and `session/load` `mcpServers` remains in place, and the global MCP config stays untouched). The agent body carries a concise live MCP tool catalog, JSON Schemas, and the `call_mcp_tool` calling convention alongside Pi's `systemPrompt` rather than placing Pi's system prompt in the first ACP user message (`systemPrompt: false` omits Pi's system prompt text only while still including the bridge protocol, tool catalog, and restricted profile). Existing `ToolRoundTrips` (`toolUse -> Pi executes -> toolResult completes MCP`) handle all bridged tools, and native ACP step rendering stays in place as event compatibility.

**Code Mode only:** The ACP MCP catalog lists only `codemode` when Pi's `codemode.mode` is `"only"` and the active tool is permitted by the bridge. Script calls still use Pi's own allowlist. For long calls, the same tool accepts `pollCallId` instead of `code`.

**Known limit (retained runtime infrastructure):** Official component exclusion (`excludeDefaultComponents: true`, `tools: []`) removes agy's native workspace file and shell tools. Runtime declarations such as `list_resources`, `read_resource`, and `manage_task` remain under AGY's control. The Code Mode only carrier's `PreToolUse` hook rejects them and accepts only `call_mcp_tool` targeting `pi-bridge` / `codemode`.

Because ACP uses a new versioned session key, prior ACP conversations are preserved and are not reused automatically — start a **new Pi conversation** to pick up the new restricted profile. `/agy agent` remains `stream-json` only (no new user-facing toggles), and `stream-json` keeps its existing fallback behavior with native tools and staged Pi carrier.

Under `bridgeTools`:
- **`all`** (default): exposes every **active** Pi tool, including active Pi builtins (`read`, `write`, `edit`, `bash`, etc.), extension tools, `pi-mcp-adapter` tools, and other `Ask*` delegations (excluding the bridge's own internal tools).
- **`mcp`**: exposes only active `pi-mcp-adapter` tools plus the skills bridge — on the restricted ACP agent, no Pi builtins or non-adapter extension tools are bridged.
- **`none`**: turns the MCP bridge off — on the restricted ACP agent, no Pi file/shell/extension/adapter tools are bridged (only agy's retained foundational runtime tools remain), whereas `stream-json` retains agy's own native workspace tools.
