// Weights and aggregation. Claude labels each thread's stance and topics; this module does all the
// arithmetic, so every number in a report is reproducible from the scan and the labels.
// The method is written out for readers in skills/sentiment-report/method.md. Keep both in sync.

export const RULES = {
  deadband: 10,
  invest: { index: 25, trendFloor: -10 },
  avoid: { index: -15, trend: -25 },
  extreme: 60,
  high: { effectiveN: 60, top3: 0.25, agreement: 0.7, coverage: 1 },
  medium: { effectiveN: 25, top3: 0.4, agreement: 0.55, coverage: 0.8 },
  trendMinEffectiveN: 10,
  unlabeledWarn: 0.1,
}

const DAY = 86_400

export function redditTimeRange(days) {
  if (days <= 1) return 'day'
  if (days <= 7) return 'week'
  if (days <= 31) return 'month'
  return 'year'
}

export function engagement(post) {
  return 1 + Math.log1p(Math.max(post.score ?? 0, 0)) + Math.log1p(Math.max(post.num_comments ?? 0, 0))
}

export function recency(ageDays, days) {
  return 0.5 ** (Math.max(ageDays, 0) / Math.max(days / 2, 0.5))
}

// Weight = engagement relative to the community's own kept posts, times a recency half-life of half
// the window. Relative engagement keeps one giant community from drowning the rest.
export function weighCommunity(posts, days, nowSeconds) {
  if (posts.length === 0) return posts
  const mean = posts.reduce((sum, p) => sum + engagement(p), 0) / posts.length
  for (const post of posts) {
    post.age_days = (nowSeconds - post.created_utc) / DAY
    post.weight = (engagement(post) / mean) * recency(post.age_days, days)
  }
  return posts
}

function bucket(index) {
  if (index > RULES.deadband) return 1
  if (index < -RULES.deadband) return -1
  return 0
}

function weightedIndex(items) {
  const total = items.reduce((sum, item) => sum + item.g, 0)
  if (total === 0) return null
  return (100 * items.reduce((sum, item) => sum + item.g * item.stance, 0)) / total
}

function effectiveN(items) {
  const total = items.reduce((sum, item) => sum + item.g, 0)
  if (total === 0) return 0
  return total ** 2 / items.reduce((sum, item) => sum + item.g ** 2, 0)
}

function round(value, digits = 0) {
  if (value === null || value === undefined) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function tally(items, pick, normalizeKey, limit) {
  const groups = new Map()
  for (const item of items) {
    const seen = new Set()
    for (const raw of pick(item) ?? []) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const key = normalizeKey(raw.trim())
      if (seen.has(key)) continue
      seen.add(key)
      if (!groups.has(key)) groups.set(key, { name: raw.trim(), items: [] })
      groups.get(key).items.push(item)
    }
  }
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      share: round(group.items.reduce((sum, item) => sum + item.g, 0), 3),
      net: round(weightedIndex(group.items)),
      threads: group.items.length,
      communities: new Set(group.items.map((item) => item.community)).size,
      top_threads: [...group.items].sort((a, b) => b.g - a.g).slice(0, 3).map((item) => ({ id: item.id, stance: item.stance })),
    }))
    .sort((a, b) => b.share - a.share)
    .slice(0, limit)
}

export function evidenceStrength({ effectiveN: n, top3, agreement, coverage }) {
  const meets = (rule) => n >= rule.effectiveN && top3 <= rule.top3 && agreement >= rule.agreement && coverage >= rule.coverage
  if (meets(RULES.high)) return 'High'
  if (meets(RULES.medium)) return 'Medium'
  return 'Low'
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`
}

function percent(value) {
  return `${Math.round(value * 100)}%`
}

export function verdictFor({ index, trend, evidence, effectiveN: n, top3, agreement, coverage }) {
  const reasons = []
  const wouldChange = []
  const trendText = trend === null ? 'too thin to read' : signed(trend)
  const sentimentCall = () => {
    if (index >= RULES.invest.index && (trend === null || trend >= RULES.invest.trendFloor)) return 'Invest'
    if (index <= RULES.avoid.index || (trend !== null && trend <= RULES.avoid.trend)) return 'Avoid'
    return 'Watch'
  }

  if (evidence === 'Low') {
    const gaps = []
    if (n < RULES.medium.effectiveN) gaps.push(`effective sample ${round(n)} (needs ${RULES.medium.effectiveN})`)
    if (top3 > RULES.medium.top3) gaps.push(`top 3 threads hold ${percent(top3)} of the weight (needs at most ${percent(RULES.medium.top3)})`)
    if (agreement < RULES.medium.agreement) gaps.push(`communities agree at ${percent(agreement)} (needs ${percent(RULES.medium.agreement)})`)
    if (coverage < RULES.medium.coverage) gaps.push(`coverage ${percent(coverage)} (needs ${percent(RULES.medium.coverage)})`)
    reasons.push(`Evidence is Low: ${gaps.join('; ')}.`)
    wouldChange.push(`With Medium evidence the current numbers would read ${sentimentCall()}.`)
    return { call: 'Watch', confidence: 'Low', reasons, would_change: wouldChange }
  }

  const call = sentimentCall()
  if (call === 'Invest') {
    reasons.push(`Index ${signed(index)} is at or above +${RULES.invest.index} and the trend (${trendText}) is not falling past ${RULES.invest.trendFloor}.`)
    wouldChange.push(`Watch if the index falls below +${RULES.invest.index} (now ${signed(index)}).`)
    wouldChange.push(`Watch if the trend falls below ${RULES.invest.trendFloor} (now ${trendText}).`)
  } else if (call === 'Avoid') {
    if (index <= RULES.avoid.index) reasons.push(`Index ${signed(index)} is at or below ${RULES.avoid.index}.`)
    if (trend !== null && trend <= RULES.avoid.trend) reasons.push(`Trend ${signed(trend)} is falling at or past ${RULES.avoid.trend}.`)
    wouldChange.push(`Watch if the index rises above ${RULES.avoid.index} (now ${signed(index)}) and the trend above ${RULES.avoid.trend} (now ${trendText}).`)
  } else {
    reasons.push(`Index ${signed(index)} and trend ${trendText} sit between the Invest and Avoid lines.`)
    wouldChange.push(`Invest if the index reaches +${RULES.invest.index} (now ${signed(index)}) with a trend of at least ${RULES.invest.trendFloor}.`)
    wouldChange.push(`Avoid if the index falls to ${RULES.avoid.index} or the trend to ${RULES.avoid.trend} (now ${trendText}).`)
  }
  wouldChange.push(`Confidence drops to Low, and the call to Watch, if evidence falls below Medium (now ${evidence}).`)
  return { call, confidence: evidence, reasons, would_change: wouldChange }
}

// posts: the scan's returned posts with weight. labels: Map id -> { stance, intent, themes, brands, tickers }.
export function aggregate({ posts, labels, days, coverage, mode }) {
  const scored = posts
    .filter((post) => labels.has(post.id) && labels.get(post.id).stance !== null)
    .map((post) => ({ ...post, ...labels.get(post.id) }))
  if (scored.length === 0) return null

  const byCommunity = new Map()
  for (const item of scored) {
    if (!byCommunity.has(item.community)) byCommunity.set(item.community, [])
    byCommunity.get(item.community).push(item)
  }

  // Each community counts by the square root of its scored threads.
  const rootTotal = [...byCommunity.values()].reduce((sum, items) => sum + Math.sqrt(items.length), 0)
  const communities = []
  for (const [name, items] of byCommunity) {
    const share = Math.sqrt(items.length) / rootTotal
    const weightTotal = items.reduce((sum, item) => sum + item.weight, 0)
    for (const item of items) item.g = weightTotal > 0 ? (share * item.weight) / weightTotal : share / items.length
    communities.push({ name, share, index: weightedIndex(items), threads: items.length })
  }

  const index = weightedIndex(scored)
  const n = effectiveN(scored)
  const top3 = [...scored].sort((a, b) => b.g - a.g).slice(0, 3).reduce((sum, item) => sum + item.g, 0)
  const agreement = communities.filter((c) => bucket(c.index) === bucket(index)).reduce((sum, c) => sum + c.share, 0)

  const recent = scored.filter((item) => item.age_days <= days / 2)
  const earlier = scored.filter((item) => item.age_days > days / 2)
  const trendReadable = effectiveN(recent) >= RULES.trendMinEffectiveN && effectiveN(earlier) >= RULES.trendMinEffectiveN
  const trend = trendReadable ? weightedIndex(recent) - weightedIndex(earlier) : null

  const evidence = evidenceStrength({ effectiveN: n, top3, agreement, coverage })
  const rounded = { index: round(index), trend: round(trend) }
  const verdict = verdictFor({ ...rounded, evidence, effectiveN: n, top3, agreement, coverage })

  const warnings = []
  if (top3 > RULES.medium.top3) warnings.push(`Three threads carry ${percent(top3)} of the weight. Treat the result as anecdote, not trend.`)
  if (mode === 'market' && Math.abs(index) >= RULES.extreme) {
    warnings.push(`Index ${signed(round(index))} is extreme. Retail crowd extremes often precede reversals, so weigh a contrarian reading.`)
  }

  return {
    index: rounded.index,
    trend: rounded.trend,
    trend_halves: {
      recent: { days: `0-${round(days / 2, 1)}`, index: round(weightedIndex(recent)), effective_n: round(effectiveN(recent), 1) },
      earlier: { days: `${round(days / 2, 1)}-${days}`, index: round(weightedIndex(earlier)), effective_n: round(effectiveN(earlier), 1) },
    },
    effective_n: round(n, 1),
    top3_share: round(top3, 3),
    agreement: round(agreement, 3),
    coverage: round(coverage, 3),
    evidence_strength: evidence,
    verdict,
    communities: communities
      .map((c) => ({ name: c.name, share: round(c.share, 3), index: round(c.index), threads: c.threads }))
      .sort((a, b) => b.share - a.share),
    themes: tally(scored, (item) => item.themes, (key) => key.toLowerCase(), 20),
    intents: tally(scored, (item) => (item.intent ? [item.intent] : []), (key) => key.toLowerCase(), 10).map((intent) => ({
      ...intent,
      top_themes: tally(
        scored.filter((item) => item.intent?.toLowerCase() === intent.name.toLowerCase()),
        (item) => item.themes,
        (key) => key.toLowerCase(),
        6,
      ).map((theme) => theme.name),
    })),
    brands: tally(scored, (item) => item.brands, (key) => key.toLowerCase(), 25),
    tickers: tally(scored, (item) => item.tickers, (key) => key.replace(/^\$/, '').toUpperCase(), 25).map((ticker) => ({
      ...ticker,
      name: ticker.name.replace(/^\$/, '').toUpperCase(),
    })),
    weights: new Map(scored.map((item) => [item.id, item.g])),
    warnings,
  }
}
