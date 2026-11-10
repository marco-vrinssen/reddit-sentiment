# Method

How the plugin turns Reddit threads into an index, a trend, an evidence grade and a verdict. The server computes all of it in `server/scoring.js`; this file explains it for readers. Keep the two in sync.

## Data

- Source: Reddit's official Data API, application-only OAuth. No third-party archives.
- Browser fallback: only when the user turned it on and the API credentials are missing. It reads the same JSON pages from the Reddit website through the user's Chrome, one every 3 seconds, and stops at any block, sign-in wall or CAPTCHA. The data has the same shape, so every rule below applies unchanged, and every result and report is marked as unofficial.
- Communities are chosen by measurement: subscribers plus comments per day over the window, ranked by `log10(1 + subscribers) + log10(1 + comments per day)`. A big but quiet community and a small but busy one both rank below one that is big and busy.
- Posts are each community's top posts over the window (Reddit's `top` listing), or the top posts matching a query for broad communities.

## Noise filters

Dropped and counted, in this order:

| Reason | Rule |
|---|---|
| outside_window | Created before the window start |
| removed | Removed by moderators or deleted |
| bot | Known bot accounts and names ending in Bot or bot-separated |
| moderator | Pinned, stickied or moderator-distinguished posts, such as daily threads and rules |
| promotional | Promo, sponsored, deal or giveaway flair, discount-code titles, affiliate and short-link domains |
| meme | Meme, shitpost, humor or satire flair, meme-generator domains |
| low_engagement | Fewer than 2 points and fewer than 2 comments |
| duplicate | Crossposts and repeats of a post already kept |

Comments drop removed text, bots, moderator comments and scores below 1.

## Weights

For each kept post in a community:

- Engagement `e = 1 + ln(1 + score) + ln(1 + comments)`. Logarithms damp viral threads, so a few loud threads cannot carry the result.
- Relative engagement `r = e / mean(e)` within the community, so a giant community does not drown smaller ones.
- Recency `0.5 ^ (age in days / (window / 2))`. A post at the window start counts a quarter of a new one.
- Weight `w = r × recency`. The highest-weighted posts per community are returned for labeling.

## Labels

Claude labels each returned thread after reading the post and, for the top threads, its comments: a stance of +1, 0 or -1, or off-topic, plus intent, themes, brands and tickers. The server rejects labels for posts that are not in the scan.

## Index

- Community index: `100 × Σ(w × stance) / Σw` over its labeled threads.
- Each community counts by the square root of its labeled threads, so a community with more evidence counts more but cannot dominate.
- Sentiment index: the weighted mean of community indices, from -100 (all negative) to +100 (all positive).
- Trend: the index over the recent half of the window minus the index over the earlier half. It is left out when either half has an effective sample below 10.

## Evidence strength

| Grade | Effective sample | Top 3 threads' weight | Community agreement | Coverage |
|---|---|---|---|---|
| High | 60 or more | at most 25% | at least 70% | 100% |
| Medium | 25 or more | at most 40% | at least 55% | at least 80% |
| Low | anything less | | | |

- Effective sample: `(Σg)² / Σg²` over all thread weights. It counts how many equally weighted threads the evidence is worth.
- Agreement: the weight share of communities whose index falls in the same band as the overall index, with bands below -10, -10 to +10, and above +10. A low agreement with a neutral index means communities pull in opposite directions, not that they are all neutral.
- Coverage: the share of planned communities that were scanned.

## Verdict

| Verdict | Rule |
|---|---|
| Invest | Index at least +25, trend not below -10, evidence Medium or High |
| Avoid | Index at most -15, or trend at or below -25, evidence Medium or High |
| Watch | Everything else, and always when evidence is Low |

The lines are asymmetric because Reddit communities about a product or about investing lean positive: enthusiasts post more than people who left. A neutral community reads slightly positive, so Invest needs a clear lead and Avoid triggers sooner.

Confidence equals the evidence grade. The analyst may move the verdict one step for a stated reason the numbers cannot capture, and then lowers confidence one step. In market mode an index beyond ±60 is flagged as extreme, since crowd extremes often precede reversals.

## Limits

- Reddit users skew younger, male, English-speaking and enthusiast. They are not all buyers, and a community's tone is not sales.
- The `top` listing favours older posts, which had more time to collect votes. Recency weighting offsets part of this.
- Votes and comments can be gamed, and filters catch only obvious bots and promotion.
- Stance labels are a model's reading of text. The evidence file lists every label, so a reader can audit them.
