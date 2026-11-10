# Reddit Sentiment

A Claude Code plugin that scans Reddit for discussions that matter to investors and writes an investment report with a verdict of Invest, Watch or Avoid. It reads Reddit only through the official Reddit Data API, using its own MCP server.

- **Market report**: the ten largest investing, stock and finance communities, and the overall sentiment in them.
- **Industry report**: one industry, such as fashion, tents, tools or cars. It finds the communities where that industry's buyers and fans talk and reports their sentiment, what they care about, what they look for and what they want to have.

Unofficial, and not affiliated with or endorsed by Reddit, Inc.

## Disclaimer

This tool and its reports are for information and research only. They are not financial, investment, legal or tax advice, and not a recommendation to buy, sell or hold any security.

The author is not a licensed financial adviser and accepts no responsibility or liability for any investment decision, loss or damage that results from using this tool or its reports. Reddit sentiment can be wrong, incomplete or manipulated, and the verdicts come from automated analysis by an AI model. Do your own research and consult a licensed professional before you invest.

The software is provided as is, without warranty of any kind, under the [MIT License](LICENSE).

## User setup

### What you need

- [Claude Code](https://code.claude.com).
- [Node.js](https://nodejs.org) 22 or later.
- Access to the Reddit Data API: a Reddit app approved for your use, its client id and client secret, and the Reddit username that owns the app. New API clients need Reddit's approval, and commercial use needs Reddit's written approval under its Data API Terms. The plugin never asks for your Reddit password.

### 1. Store your Reddit credentials

On macOS, put them in the keychain. Each command asks for the value, so it never lands in your shell history or a file.

```bash
security add-generic-password -s reddit-sentiment -a client-id -w
```

```bash
security add-generic-password -s reddit-sentiment -a client-secret -w
```

```bash
security add-generic-password -s reddit-sentiment -a username -w
```

On other systems, set `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and `REDDIT_USERNAME` in the environment you start Claude Code from. These also take precedence over the keychain. Never put them in a file inside a repository.

### 2. Install the plugin

```bash
claude plugin marketplace add marco-vrinssen/reddit-sentiment
```

```bash
claude plugin install reddit-sentiment@reddit-sentiment
```

Inside Claude Code, `/plugin marketplace add` and `/plugin install` do the same. Then start a new Claude Code session.

### 3. Check the connection

Ask Claude: "Check the Reddit connection." It shows where each credential came from and the current rate limit. If a credential is missing or rejected, the answer names it and says how to fix it.

### 4. Write a report

```text
/reddit-sentiment:industry tents
```

```text
/reddit-sentiment:market
```

| Command | Arguments | Default window |
|---|---|---|
| `/reddit-sentiment:market` | `[days]`, 1 to 30 | 7 days |
| `/reddit-sentiment:industry` | `<industry> [days]`, days 1 to 365 | 30 days |

You can also ask in your own words, such as "How do Reddit's car buyers feel right now?"

A report takes 100 to 150 API calls and a few minutes. It is saved in `reports/` in the folder Claude Code runs in, for example `reports/2026-11-10-tents.md`. Next to it, `reports/2026-11-10-tents.evidence.json` lists every thread with its weight and label.

### What a report contains

1. **Verdict**: Invest, Watch or Avoid, its confidence, the numbers behind it and what would change it.
2. **Evidence**: themes, what buyers look for and want, brands or tickers, and the communities scanned.
3. **Companies to watch**: listed companies with their tickers and one line on why each matters.
4. **Risks and limits**: gaps in the scan and the limits of Reddit as a source.
5. **Sources**: every cited Reddit thread with its link, and the method.

## Technical setup

### Layout

| Path | Holds |
|---|---|
| `.claude-plugin/marketplace.json` | A one-plugin marketplace, so the repository installs directly |
| `plugin/.claude-plugin/plugin.json` | Plugin manifest and version |
| `plugin/.mcp.json` | Starts the MCP server with `node` |
| `plugin/server/` | The MCP server: plain JavaScript, no dependencies, no build step |
| `plugin/skills/sentiment-report/` | The method: `SKILL.md` (steps), [`method.md`](plugin/skills/sentiment-report/method.md) (formulas and thresholds), `report-template.md` |
| `plugin/commands/` | The `market` and `industry` commands |
| `test/`, `scripts/` | Tests, a local fake Reddit and the fixture recorder. Not part of the installed plugin |

### Tools

The MCP server, `reddit`, is read-only.

| Tool | Does |
|---|---|
| `check_connection` | Authenticates and shows the credential sources and rate limit |
| `find_communities` | Searches communities for several queries and merges them, without NSFW, private and quarantined ones |
| `measure_communities` | Measures subscribers and posts and comments per day, and ranks by size and activity together |
| `collect_posts` | Collects top posts of up to five communities over the window, filters noise, weights by engagement and recency, and returns a scan id that later calls add to |
| `get_comments` | Top-level comments of up to ten threads, without bots, moderators or usernames |
| `score_sentiment` | Turns Claude's per-thread labels into the index, trend, evidence strength, verdict and tallies, and writes the evidence file |

### How it behaves

- **Official access only.** Application-only OAuth (`client_credentials`) against `oauth.reddit.com`, with a User-Agent of the form Reddit requires. No scraping, no anonymous fallback.
- **Communities on evidence.** Candidates come from community search and are ranked by `log10(1 + subscribers) + log10(1 + comments per day)`. Industry reports use customer communities. An optional investor view is scored and reported separately.
- **Signal over noise.** Removed posts, bots, moderator and pinned posts, promotions, memes, low-engagement posts, crossposts and posts outside the window are dropped and counted. Engagement is damped with logarithms and taken relative to each community, and older posts weigh less.
- **Arithmetic in code.** Claude labels each thread's stance and topics; the server computes every number, so a report can be reproduced from its evidence file.
- **Uncertainty in the verdict.** Evidence strength (High, Medium, Low) comes from the effective sample, how much the top three threads carry, how far communities agree, and coverage. Low evidence always means Watch. Each verdict lists what would change it.
- **No silent gaps.** Missing or rejected credentials stop every tool with a clear message. A refusal without a reason stops the scan rather than return partial data. A community that cannot be read is listed as a gap, and the report says so.
- **Rate limits.** One request at a time, at most `REDDIT_MAX_QPM` per minute (default 100), slowing down as Reddit's `x-ratelimit-remaining` runs low. A 429 waits as long as Reddit asks, up to two minutes, then fails with a clear message. Reads are cached for 15 minutes.
- **Small answers.** By default a call returns at most 100 posts or 80 comments, so each answer stays under Claude Code's default MCP output limit of 25,000 tokens.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME` | keychain | Credentials, ahead of the keychain |
| `REDDIT_USER_AGENT` | `<platform>:reddit-sentiment:<version> (by /u/<username>)` | Override the User-Agent |
| `REDDIT_MAX_QPM` | 100 | Request ceiling per minute, for a paid plan with other limits |
| `REDDIT_SENTIMENT_NO_KEYCHAIN` | unset | `1` reads credentials from the environment only |

### Limits

- Reddit sentiment is one input among several. Reddit users skew young, English-speaking and enthusiast, are not all buyers, and their tone is not sales.
- Reddit's `top` listing favours older posts. Recency weighting offsets part of this.
- Filters catch obvious bots and promotion, not coordinated campaigns.
- Stance labels are a model's reading of text. The evidence file lists every label for audit.
- Scans live in the server's memory for one Claude Code session.

### Develop

```bash
git clone https://github.com/marco-vrinssen/reddit-sentiment.git
```

```bash
npm test
```

Runs offline, without credentials, against a local fake Reddit (`test/fake-reddit.js`) serving `test/fixtures/synthetic.json`. That file is hand-built in the Data API's response shapes and holds no real posts. The tests cover the filters, the scoring, the HTTP client with its auth, retry and rate-limit paths, and the MCP server end to end over stdio.

```bash
npm run validate
```

Validates the plugin and marketplace manifests.

```bash
claude --plugin-dir ./plugin
```

Runs Claude Code with the local checkout instead of the installed plugin.

With credentials:

```bash
npm run test:live
```

Calls the live API, about 6 calls.

```bash
npm run record
```

Records real responses to `test/fixtures/recorded.json` (about 7 calls), which `npm test` then replays. The file holds real Reddit content and usernames, so Git ignores it and it is never published.

## License

[MIT](LICENSE) © 2026 Marco Vrinssen
