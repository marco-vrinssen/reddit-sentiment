# Changelog

## 0.2.0

- Browser fallback, off by default: with the new Browser fallback setting on and the API credentials missing, the plugin reads the Reddit website through your Chrome with playwright-cli. Every result and report is marked as unofficial data.
- `npm run setup` stores the credentials in the macOS keychain and checks them. `npm run check` checks them again.
- Every tool result names its `data_source`.

## 0.1.0

- First version: MCP server on the official Reddit Data API with six read-only tools, the `sentiment-report` skill, and the `/reddit-sentiment:market` and `/reddit-sentiment:industry` commands.
