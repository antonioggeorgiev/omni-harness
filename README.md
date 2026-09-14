# Omni Harness

Omni Harness is a local-first desktop inventory for AI development harnesses and the tools they connect to.

The initial release inspects Codex CLI's `~/.codex/config.toml` without modifying it. It discovers the CLI, extracts configured MCP servers and selected settings, shows their relationships, and redacts secret-like values before returning data to the frontend.

## Development

Prerequisites: Node.js 22+, pnpm, Rust, and the platform dependencies required by Tauri.

```bash
pnpm install
pnpm tauri dev
```

Useful validation commands:

```bash
pnpm build
pnpm test:core
pnpm check
```

## Security model

- The React renderer has no general filesystem or shell API.
- Rust commands inspect only known harness paths.
- The app is read-only.
- Secret-like fields such as tokens, passwords, API keys, and authorization values are redacted in Rust before the UI receives them.
- No configuration contents are executed.

## Adding a harness

Adapters belong in `src-tauri/src/adapters` once the initial module is split out. Each adapter should detect installations, identify only its known config sources, normalize configured connections, preserve source paths, and provide fixture-backed parser tests.
