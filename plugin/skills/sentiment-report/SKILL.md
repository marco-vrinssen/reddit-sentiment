---
name: sentiment-report
description: Method for turning Reddit discussions into an investment report with an Invest, Watch or Avoid verdict. Use for a market sentiment report from the largest investing and finance communities, or an industry report from the communities where that industry's customers talk, such as fashion, tents, tools or cars. Needs the plugin's reddit MCP tools.
---

# Sentiment report

Write one Markdown report that lets a reader decide whether to invest in an industry, or in the market, right now. Every number comes from the tools, and every claim about what people say cites the threads behind it.

The scoring rules and their reasons are in `${CLAUDE_PLUGIN_ROOT}/skills/sentiment-report/method.md`. The report layout is in `${CLAUDE_PLUGIN_ROOT}/skills/sentiment-report/report-template.md`. Read both before writing.

## Modes

| Mode | Communities | Default window | Stance is the tone toward |
|---|---|---|---|
| market | The ten largest investing, stock and finance communities | 7 days | Where the market goes next: +1 bullish, -1 bearish, 0 mixed |
| industry | The communities where the industry's buyers, owners and fans talk | 30 days | The industry's products and category: +1 positive, -1 negative, 0 neutral |

In market mode the verdict reads as Invest, Watch or Avoid for broad equity exposure now, from the retail sentiment angle.

## Steps

### 1. Check the connection

Call `check_connection`. If it fails, stop and show its message. Never fill the gap with web search, memory or another data source: a report must rest on the scan it claims.

Its `data_source` is `official_api`, or `browser_fallback` when the API credentials are missing and the user turned the plugin's browser fallback on. With `browser_fallback`:

- Tell the user in one line that this report uses unofficial data, read from the Reddit website through their Chrome, then continue.
- Each page takes a few seconds, so measure at most 15 candidates with `max_pages` 1, and read comments for the 10 highest-weighted posts.
- Mark the report as unofficial, as the Rules say.

### 2. Choose communities on evidence

Market:

1. `find_communities` with about ten queries: investing, stocks, stock market, personal finance, options trading, dividends, ETFs, value investing, day trading, financial independence, economy.
2. Keep communities whose main topic is stocks, investing, markets or personal finance. Leave out single-company, single-coin and crypto-only communities, since the report ties sentiment to listed equities.
3. `measure_communities` on the 25 largest that remain, with `days` 7.
4. Take the ten with the highest `rank_score`.

Industry:

1. Write 8 to 12 queries from the customer's side: the product category, its types, the activities and uses around it, buying advice, and the three to five brands you know lead the category. For tents: tents, camping, backpacking, ultralight, car camping, camping gear, hiking gear, plus brand names.
2. Keep communities where buyers, owners and fans talk: hobby, use-case, owner and buying-advice communities. Leave out investor, deal-only, swap and marketplace, meme and off-topic communities.
3. `measure_communities` on up to 25 candidates, with `days` set to the window, at most 30.
4. Take five to ten by `rank_score`, with at least three dedicated to the industry. A broad community such as BuyItForLife enters with a `query` naming the industry, so only matching posts count.

Both modes:

- Leave out communities with fewer than 5 comments per day, since they are too quiet to read, and communities that failed to measure.
- When fewer communities qualify than the mode asks for, use those that do and say so under Risks and limits. In industry mode, with fewer than three, stop and tell the user that Reddit has too little customer conversation about this industry to judge it. That is the finding.
- Note every candidate you measured and every one you left out, with the reason. They go into the Sources section.

### 3. Collect

`collect_posts` takes up to five communities per call. Start the scan with the first five, then add the rest in more calls with the returned `scan_id`, which keeps the same window. Use `days` for the window, `per_community` 20 and `fetch_limit` 100, or 300 for windows over 31 days, since Reddit's year listing is cut down to the window.

Read `complete`, `warnings`, `coverage` and `scan_totals` after every call. If a community failed, add the next one in the ranking to the same scan, once. Without a next one, keep the gap and report it.

### 4. Read the threads

`get_comments` takes up to ten posts per call. Read the 20 highest-weighted posts, plus at least the top two of each community. The thread is the unit: judge the post together with its top comments, not the title alone. Read sarcasm and irony for what they mean. When a thread's comments are unavailable, label it from the post alone.

### 5. Label every returned post

First skim the first 30 posts, or all if fewer, and fix a theme vocabulary of 10 to 20 short tags. Reuse the exact strings. Then label every post `collect_posts` returned, low weights included, since unlabeled posts drop out of the index.

`stance` is tone, as in the modes table. Demand shows in `intent`, not in stance:

- A plain question about what to buy is 0 with intent buying. It is +1 when the poster is excited or has decided, -1 when frustrated with every option.
- A wish for something the market does not offer yet is intent wanting, +1 when eager, 0 when matter-of-fact.
- Frustration that a product sells out or is hard to get is +1 with the theme availability: people want it.
- A price complaint is -1 with the theme price, even when the poster still buys.
- Market mode: a gain or loss on a position is 0 unless the thread draws a view on where the market goes next.
- `null` marks a thread that is not about the market or the industry.

The other fields:

- `intent`: industry: buying (asks what to buy, about to buy), owning (review, experience, trip report), wanting (wish list, dream item, missing feature), complaint, discussion. Market: outlook, position, news, discussion.
- `themes`: one to four tags. Industry tags say what people care about, such as price, durability, weight, weather protection, setup, warranty, availability, brand trust. Market tags name the drivers, such as rates, inflation, earnings, AI, jobs, tariffs, valuations, recession.
- `brands`: the brand, not the product line, in its usual spelling: MSR, not Hubba Hubba.
- `tickers`: listed companies the thread discusses, as tickers without `$`.

Label from the content, never from the weight.

### 6. Name the report and score

Name the report now: `reports/<YYYY-MM-DD>-<slug>.md` under the current working directory, with today's date. The slug is `market`, or the industry in lowercase with hyphens, such as `power-tools`, and ends in `-unofficial` with `browser_fallback` data. Add `-2`, `-3` when a report of that name exists. The evidence file has the same name ending in `.evidence.json`.

Call `score_sentiment` with the scan id, the mode, all labels and the evidence file's absolute path as `evidence_path`.

### 7. Companies to watch

- Market: the tickers with the largest share, with their net stance and the theme that drives them.
- Industry: map the brands with the largest share to their owners, and add the listed retailers and channels customers name. Name brands that are private or co-operatives in one line under the table, since they offer no listed exposure.
- Verify every owner and ticker with web search. Without web search, name an owner or ticker only when you are sure, and mark it unverified.
- Up to eight companies, each with one line on why it matters, tied to the evidence with citations. When customers name fewer brands with listed owners, list fewer and say why in one line.

### 8. Investor view (industry)

When the companies table holds listed companies, run `collect_posts` as a new scan on the three highest-ranked investing communities from a `measure_communities` call, with a `query` of the industry terms and the main tickers. Label those posts with the market stance and score them in their own `score_sentiment` call, without an evidence path. Report them as the Investor view, and never merge them into the demand index: the demand signal comes from customers. Without listed companies, drop the section.

### 9. Verdict

Start from the rule-based verdict that `score_sentiment` returns. You may move it one step, only for a reason the numbers cannot capture, and you state that reason in the report. Valid reasons: an extreme market index read as a contrarian signal, demand that goes to brands with no listed exposure, or an event in the window that changes the picture. Coverage gaps already lower the evidence grade, so they are no reason to move the verdict. Never move a verdict up when evidence is Low.

Confidence is the evidence strength, one step lower when you moved the verdict.

### 10. Write

Fill the template and save the report under the name from step 6.

## Rules

- Never invent data, numbers, threads or quotes. Every number comes from tool output.
- Number sources T1, T2 and so on in order of first citation. Every claim about what people say cites at least one, usually from the `top_threads` that `score_sentiment` returns, matching the stance of the claim. Cite only threads you have seen.
- Quotes stay under 20 words, from posts or comments. Never name Reddit users.
- A theme carried by fewer than three threads or by one community is an anecdote. Say so, and never build the verdict on it.
- When any tool reports `complete: false`, the Verdict section says so in one line and Risks and limits lists every gap.
- With `browser_fallback` data, the title ends in "(unofficial data)", the Verdict section opens with "Unofficial data: read from the Reddit website through a browser, not the official Reddit Data API.", and Risks and limits says that Reddit's terms do not permit this collection.
- Say once, in Risks and limits: "This report is automated analysis, not financial advice. The tool's author accepts no responsibility for decisions based on it." Do not repeat it or soften the verdict around it.
- State the limits of the data plainly: Reddit sentiment is one input among several, and its users are not all buyers.
- Write in English, in plain Markdown a reader can scan: short sentences, tables for numbers, no decoration.
