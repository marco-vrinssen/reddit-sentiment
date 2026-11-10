# Report template

Replace everything in angle brackets. Sections marked industry only or optional are dropped in market mode or when they have no content.

The title line depends on the mode:

- Industry: `# <Industry> on Reddit: <Invest | Watch | Avoid>`
- Market: `# Market sentiment on Reddit: <Invest | Watch | Avoid>`
- With `browser_fallback` data, either title ends in ` (unofficial data)`.

The rest:

```markdown
<YYYY-MM-DD, today> · window <from date> to <to date> (<days> days) · <communities scored> communities · <threads scored> threads scored

## Verdict

<Only with browser_fallback data: "Unofficial data: read from the Reddit website through a browser, not the official Reddit Data API.">

**<Invest | Watch | Avoid>**, confidence <High | Medium | Low>

<Two to four sentences: what customers (or investors) are saying, the main driver, and why this verdict. Cite threads [T1].>

<Only when a tool reported complete: false: "Partial scan: <what is missing>. See Risks and limits.">

| Measure | Value |
|---|---|
| Sentiment index | <+34> on a scale from -100 to +100 |
| Trend | <+6>, recent half against earlier half of the window. When trend is null: "Too thin to read (recent half <x>, earlier half <y>)" |
| Evidence | <Medium>: effective sample <42>, top 3 threads hold <18%>, communities agree <76%>, coverage <100%> |
| Rule-based verdict | <Invest>. <Any deviation and its reason> |

What would change it:

- <Each line from verdict.would_change>
- <One or two concrete events or signals from the threads that would move the call>

## Evidence

### <Industry: What people care about | Market: What drives sentiment>

| Theme | Share | Net | Threads | Sources |
|---|---|---|---|---|
| <durability> | <22%> | <+40> | <18> | [T2] [T5] |

- <What the top themes mean, with citations. Mark anecdotes as anecdotes.>

### What they look for (industry only)

- <Themes in buying-intent threads: the criteria buyers name, with citations>

### What they want to have (industry only)

- <Products and features in wanting-intent threads, with citations>

### <Industry: Brands in the conversation | Market: Most-discussed tickers>

| <Brand or Ticker> | Share | Net | Threads | Sources |
|---|---|---|---|---|

### Communities

| Community | Members | Comments per day | Index | Threads scored | Share of index |
|---|---|---|---|---|---|

<Members and comments per day come from measure_communities; mark a capped sample, such as "800 (3-day sample)". Index, threads and share come from score_sentiment.>

### Investor view (industry, optional)

<Index, evidence and the main points from investing communities, kept apart from the demand index.>

## Companies to watch

| Company | Ticker | Why it matters |
|---|---|---|
| <Company> | <NYSE: XXX> | <One line tied to the evidence [T3]> |

Not listed: <brands that are private or co-operatives>.

## Risks and limits

- <Only with browser_fallback data: "Collected from the Reddit website through a browser, which Reddit's terms do not permit. The official Data API was not used.">
- <Gaps: failed or empty communities, fewer communities than planned, partial data>
- <Concentration: themes or results carried by few threads>
- <Industry and company risks raised in the threads, with citations>
- Reddit sentiment is one input among several. Its users skew young, English-speaking and enthusiast, are not all buyers, and their tone is not sales. Check this against sales data, earnings, valuations and other sources.
- This report is automated analysis, not financial advice. The tool's author accepts no responsibility for decisions based on it.

## Sources

Threads:

1. T1 · <Title> · r/<community> · <score> points · <comments> comments · <date> · <url>

Method:

- Communities: <chosen ones with rank_score; measured but left out ones with the reason>
- Collected <read> posts, kept <kept>, returned <returned> for labeling. Filtered: <counts by reason>.
- Scored with the plugin's method: engagement relative to each community, recency half-life of half the window, communities weighted by the square root of their threads. Every thread, weight and label: <evidence file name>.
```
