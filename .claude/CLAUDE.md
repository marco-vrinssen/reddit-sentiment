# reddit-sentiment

## Layout

- The repository is a one-plugin marketplace: `.claude-plugin/marketplace.json` at the root, the plugin in `plugin/`. Only `plugin/` ships. Tests, scripts and docs stay at the root.
- `plugin/server/` is the MCP server, plain ESM JavaScript with no dependencies, so the plugin installs without `npm install`. `index.js` speaks MCP over stdio (newline-delimited JSON-RPC), `tools.js` defines the six tools, `reddit.js` is the only module that calls Reddit, `filters.js` drops noise, `scoring.js` does all the arithmetic, `credentials.js` loads the app credentials, `schema.js` checks tool input.
- `plugin/package.json` only sets `"type": "module"`, since an installed plugin has no root `package.json`.
- The version lives in `plugin/.claude-plugin/plugin.json`. The server reads it for `serverInfo` and the User-Agent. Keep the root `package.json` version equal.
- `plugin/skills/sentiment-report/` holds the method: `SKILL.md` (steps and rules), `method.md` (formulas and thresholds for readers), `report-template.md`. `plugin/commands/` has `market.md` and `industry.md`, which load the skill.

## Rules

- Reddit access through the official Data API with application-only OAuth (`client_credentials`). No anonymous API calls, no third-party archives.
- The browser fallback (`browser.js`) is the one exception: only when the `browser_fallback` setting is on and credentials are missing, never on rejected credentials. It reads the website's `.json` pages through the user's Chrome with playwright-cli, at a fixed pace, and stops at blocks, sign-in walls and CAPTCHAs. Never add stealth, proxies, user-agent spoofing, random delays or CAPTCHA handling to it. Every result carries `data_source`, and a scan never mixes sources.
- Credentials come from `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, then the macOS keychain (service `reddit-sentiment`, accounts `client-id`, `client-secret`, `username`). Never log or return their values. They load on the first tool call, not at start, so `tools/list` works without them and a keychain fix applies without a restart.
- Reddit requires a User-Agent of the form `<platform>:<app id>:<version> (by /u/<username>)`. `REDDIT_USER_AGENT` overrides it.
- Error kinds in `errors.js` decide what happens: `credentials`, `auth`, `access`, `rate_limited` and `input` stop the tool; `not_found`, `forbidden`, `upstream` and `shape` become a listed gap. A 403 without a `reason` is `access`, since it usually means the app lacks API approval, and stopping beats partial data.
- Every tool result that covers several items carries `complete` and lists its failures. Never drop a failure silently.
- A changed response shape fails with a `shape` error through `listing()`, never reads as empty.
- `scoring.js` and `method.md` describe the same rules. Change both together, and the tests in `test/scoring.test.js`.
- Tool output never contains Reddit usernames.
- The code was written from scratch for this project. No code was copied from another project, so no third-party notice applies.

## Checks

- `npm test` after every change. It needs no credentials and no network.
- `npm run validate` after changing a manifest, command or skill.
- `claude mcp list` from any folder with `--plugin-dir plugin` shows whether Claude Code starts the server.
- `npm run fake-reddit` serves the synthetic fixture on port 8765 for manual runs. Point the server at it with `REDDIT_API_BASE=http://127.0.0.1:8765`, `REDDIT_AUTH_URL=http://127.0.0.1:8765/api/v1/access_token` and the test credentials it prints.
- `npm run setup` stores the three credentials in the keychain (the secret through `security`'s own hidden prompt, never argv) and runs `npm run check`, which authenticates with 2 API calls.
- With credentials: `npm run record` refreshes `test/fixtures/recorded.json`, `npm run test:live` calls the live API. Both cost API calls. `recorded.json` holds real Reddit content and usernames, so it stays git-ignored and is never published.

## Facts

- playwright-cli: `attach --extension=chrome --session=reddit-sentiment --idle-timeout=600000`, then `-s=reddit-sentiment goto <url>` and `-s=reddit-sentiment --raw eval <expr>`, which prints the value as a JSON string. Failures exit 1 with the message on stdout. Chrome shows the extension's connect page on attach and the user must approve it; closing it drops the session even though attach returned 0, so the client checks the session after attaching. playwright-cli writes snapshot files into its working folder, so it runs in `CLAUDE_PLUGIN_DATA` or a temp folder (checked 2026-11-10, playwright-cli 0.1.23).
- The plugin setting `browser_fallback` reaches the server as `REDDIT_SENTIMENT_BROWSER_FALLBACK` through `.mcp.json`, which overrides the same variable from the shell.

- Rate limit headers: `x-ratelimit-remaining`, `x-ratelimit-used`, `x-ratelimit-reset` (seconds). The commonly cited free limit is 100 queries per minute per OAuth client, averaged over 10 minutes. Paid limits depend on the agreement, so `REDDIT_MAX_QPM` sets the ceiling.
- Since November 2025 every new Data API client needs Reddit's approval (secondhand sources, checked 2026-11-10). Reddit's own wiki page answered 403 to a fetch.
- `restrict_sr=on` keeps a community search inside the community. `raw_json=1` avoids HTML-escaped text.
- Listings stop at about 1000 items. `measure_communities` reports `capped` when the newest posts do not reach the window start.
- `claude plugin validate` warns about a `CLAUDE.md` at a plugin root, so this file lives in `.claude/`.
