import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULES, aggregate, engagement, evidenceStrength, recency, redditTimeRange, verdictFor, weighCommunity } from '../plugin/server/scoring.js'

const NOW = 1_800_000_000
const DAY = 86_400

// n threads per community, spread evenly over the window, equal engagement.
function sample({ communities = ['a', 'b', 'c', 'd', 'e'], perCommunity = 40, days = 30, stance = () => 1 }) {
  const posts = []
  const labels = new Map()
  for (const community of communities) {
    const group = []
    for (let i = 0; i < perCommunity; i++) {
      const id = `${community}${i}`
      group.push({ id, community, score: 100, num_comments: 20, created_utc: NOW - ((i + 0.5) / perCommunity) * days * DAY })
      labels.set(id, { stance: stance(community, i), intent: i % 2 ? 'buying' : 'owning', themes: ['price', i % 3 ? 'durability' : 'weight'], brands: ['Big Agnes'], tickers: ['$nwl'] })
    }
    posts.push(...weighCommunity(group, days, NOW))
  }
  return { posts, labels, days }
}

test('time ranges', () => {
  assert.equal(redditTimeRange(1), 'day')
  assert.equal(redditTimeRange(7), 'week')
  assert.equal(redditTimeRange(30), 'month')
  assert.equal(redditTimeRange(90), 'year')
})

test('engagement is damped and recency halves at half the window', () => {
  assert.ok(engagement({ score: 10_000, num_comments: 1000 }) < 20)
  assert.equal(recency(0, 30), 1)
  assert.equal(recency(15, 30), 0.5)
  assert.equal(recency(30, 30), 0.25)
})

test('weights are relative to the community', () => {
  const posts = weighCommunity(
    [
      { score: 100, num_comments: 10, created_utc: NOW },
      { score: 100, num_comments: 10, created_utc: NOW },
    ],
    7,
    NOW,
  )
  assert.deepEqual(posts.map((p) => p.weight), [1, 1])
})

test('uniform positive sample reads +100 with High evidence and Invest', () => {
  const { posts, labels, days } = sample({})
  const result = aggregate({ posts, labels, days, coverage: 1, mode: 'industry' })
  assert.equal(result.index, 100)
  assert.equal(result.trend, 0)
  assert.equal(result.evidence_strength, 'High')
  assert.equal(result.verdict.call, 'Invest')
  assert.equal(result.verdict.confidence, 'High')
  assert.equal(result.communities.length, 5)
  assert.equal(result.themes[0].name, 'price')
  assert.equal(result.themes[0].share, 1)
  assert.equal(result.tickers[0].name, 'NWL')
  assert.deepEqual(result.intents.map((i) => i.name).sort(), ['buying', 'owning'])
})

test('mixed sample sits in Watch', () => {
  const { posts, labels, days } = sample({ stance: (c, i) => [1, 1, 0, 0, -1][i % 5] })
  const result = aggregate({ posts, labels, days, coverage: 1, mode: 'industry' })
  assert.ok(result.index > 10 && result.index < 25, `index ${result.index}`)
  assert.equal(result.verdict.call, 'Watch')
})

test('a falling trend turns the call to Avoid', () => {
  // Recent half negative, earlier half positive.
  const { posts, labels, days } = sample({ stance: (c, i) => (i < 20 ? -1 : 1) })
  const result = aggregate({ posts, labels, days, coverage: 1, mode: 'industry' })
  assert.ok(result.trend <= RULES.avoid.trend, `trend ${result.trend}`)
  assert.equal(result.verdict.call, 'Avoid')
})

test('thin evidence forces Watch with Low confidence', () => {
  const { posts, labels, days } = sample({ communities: ['a'], perCommunity: 8 })
  const result = aggregate({ posts, labels, days, coverage: 1, mode: 'industry' })
  assert.equal(result.index, 100)
  assert.equal(result.evidence_strength, 'Low')
  assert.equal(result.verdict.call, 'Watch')
  assert.equal(result.verdict.confidence, 'Low')
  assert.equal(result.trend, null)
  assert.match(result.verdict.would_change.join(' '), /Invest/)
})

test('off-topic labels are left out and an all-off-topic set returns null', () => {
  const { posts, labels, days } = sample({ communities: ['a'], perCommunity: 4 })
  for (const label of labels.values()) label.stance = null
  assert.equal(aggregate({ posts, labels, days, coverage: 1, mode: 'industry' }), null)
})

test('one dominant thread is flagged as anecdote', () => {
  const { posts, labels, days } = sample({ communities: ['a'], perCommunity: 5 })
  posts[0].weight = 100
  const result = aggregate({ posts, labels, days, coverage: 1, mode: 'industry' })
  assert.ok(result.top3_share > RULES.medium.top3)
  assert.match(result.warnings.join(' '), /anecdote/)
})

test('market extremes are flagged', () => {
  const { posts, labels, days } = sample({ days: 7 })
  const result = aggregate({ posts, labels, days, coverage: 1, mode: 'market' })
  assert.match(result.warnings.join(' '), /contrarian/)
})

test('evidence grades follow the rules table', () => {
  assert.equal(evidenceStrength({ effectiveN: 60, top3: 0.25, agreement: 0.7, coverage: 1 }), 'High')
  assert.equal(evidenceStrength({ effectiveN: 60, top3: 0.25, agreement: 0.7, coverage: 0.9 }), 'Medium')
  assert.equal(evidenceStrength({ effectiveN: 24, top3: 0.1, agreement: 1, coverage: 1 }), 'Low')
})

test('verdict lines', () => {
  const base = { evidence: 'Medium', effectiveN: 40, top3: 0.2, agreement: 0.8, coverage: 1 }
  assert.equal(verdictFor({ ...base, index: 25, trend: -10 }).call, 'Invest')
  assert.equal(verdictFor({ ...base, index: 25, trend: -11 }).call, 'Watch')
  assert.equal(verdictFor({ ...base, index: 24, trend: 5 }).call, 'Watch')
  assert.equal(verdictFor({ ...base, index: -15, trend: 0 }).call, 'Avoid')
  assert.equal(verdictFor({ ...base, index: 10, trend: -25 }).call, 'Avoid')
  assert.equal(verdictFor({ ...base, index: 40, trend: null }).call, 'Invest')
})
