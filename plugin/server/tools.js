// The six MCP tools. Each states its coverage, so a gap is never silent.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RedditError } from './errors.js'
import { listing } from './reddit.js'
import { commentNoiseReason, postNoiseReason } from './filters.js'
import { RULES, aggregate, redditTimeRange, weighCommunity } from './scoring.js'
import { validate, withDefaults } from './schema.js'

const DAY = 86_400
const MAX_SCANS = 20
const COMMUNITY_NAME = /^[A-Za-z0-9_]{2,21}$/
const POST_ID = /^[a-z0-9]{1,12}$/i
const READABLE_TYPES = new Set(['public', 'restricted', 'archived'])
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

const inputError = (message) => new RedditError('input', message)

function communityName(raw) {
  const name = String(raw).trim().replace(/^\/?r\//i, '')
  if (!COMMUNITY_NAME.test(name)) throw inputError(`"${raw}" is not a valid community name.`)
  return name
}

function postId(raw) {
  const id = String(raw).trim().replace(/^t3_/, '')
  if (!POST_ID.test(id)) throw inputError(`"${raw}" is not a valid post id.`)
  return id
}

function trimText(text, max) {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// Runs fn for each item in order. Gaps are collected; fatal errors stop the whole tool.
async function eachItem(items, fn) {
  const results = []
  const failures = []
  for (const item of items) {
    try {
      results.push(await fn(item))
    } catch (error) {
      if (!(error instanceof RedditError) || error.fatal) throw error
      failures.push({ item, kind: error.kind, reason: error.message })
    }
  }
  return { results, failures }
}

function allFailed(what, failures) {
  return new RedditError('upstream', `Every ${what} failed, so there is no data to report:\n${failures.map((f) => `- ${f.reason}`).join('\n')}`)
}

export function createTools({ getClient, now = Date.now, version = '0' }) {
  const scans = new Map()
  const nowSeconds = () => now() / 1000

  const definitions = [
    {
      name: 'check_connection',
      title: 'Check Reddit connection',
      description:
        'Checks the data source before a scan. With credentials: that they load and authenticate, where each came from (environment or keychain, never the values) and the rate limit. Without credentials and with the browser fallback turned on: that the browser can read Reddit. data_source says which: official_api or browser_fallback.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const client = getClient()
        const path = '/subreddits/popular'
        listing(await client.get(path, { limit: 1 }), 't5', path)
        return { ok: true, credentials_from: client.credentials.sources, user_agent: client.credentials.userAgent, ...client.stats() }
      },
    },
    {
      name: 'find_communities',
      title: 'Find communities',
      description:
        'Searches Reddit for communities matching each query and merges the results. Returns candidates with subscriber counts, sorted by size. Size alone is not activity: pass the candidates to measure_communities before choosing. NSFW, private and quarantined communities are left out and counted.',
      inputSchema: {
        type: 'object',
        required: ['queries'],
        properties: {
          queries: {
            type: 'array',
            minItems: 1,
            maxItems: 15,
            items: { type: 'string', minLength: 1, maxLength: 100 },
            description: 'Search terms, one community search per term, such as "tents", "backpacking", "car camping".',
          },
          limit_per_query: { type: 'integer', minimum: 1, maximum: 50, default: 15, description: 'Communities per query.' },
          include_nsfw: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
      async handler({ queries, limit_per_query, include_nsfw }) {
        const client = getClient()
        const path = '/subreddits/search'
        const candidates = new Map()
        const excluded = new Map()
        const { failures } = await eachItem(queries, async (query) => {
          const params = { q: query, limit: limit_per_query, sort: 'relevance', include_over_18: include_nsfw ? 'on' : 'off' }
          const { items } = listing(await client.get(path, params), 't5', `${path}?q=${query}`)
          for (const s of items) {
            const key = s.display_name?.toLowerCase()
            if (!key) continue
            if (candidates.has(key)) {
              candidates.get(key).matched_queries.push(query)
              continue
            }
            if (s.over18 && !include_nsfw) excluded.set(key, 'nsfw')
            else if (s.quarantine || !READABLE_TYPES.has(s.subreddit_type)) excluded.set(key, 'unreadable')
            else {
              candidates.set(key, {
                name: s.display_name,
                title: trimText(s.title, 100),
                subscribers: s.subscribers ?? 0,
                description: trimText(s.public_description, 120),
                type: s.subreddit_type,
                matched_queries: [query],
              })
            }
          }
        })
        if (failures.length === queries.length) throw allFailed('community search', failures)
        const counts = [...excluded.values()].reduce((acc, reason) => ({ ...acc, [reason]: (acc[reason] ?? 0) + 1 }), {})
        return {
          complete: failures.length === 0,
          candidates: [...candidates.values()].sort((a, b) => b.subscribers - a.subscribers),
          excluded: { nsfw: counts.nsfw ?? 0, unreadable: counts.unreadable ?? 0 },
          failures: failures.map((f) => ({ query: f.item, reason: f.reason })),
          ...client.stats(),
        }
      },
    },
    {
      name: 'measure_communities',
      title: 'Measure community size and activity',
      description:
        'Measures each community: subscribers, and posts and comments per day from its newest posts over the window. Ranks by rank_score = log10(1 + subscribers) + log10(1 + comments per day), so size and current activity both count. Communities that cannot be read are listed under failures. Costs about 3 API calls per community.',
      inputSchema: {
        type: 'object',
        required: ['communities'],
        properties: {
          communities: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string', minLength: 2, maxLength: 24 }, description: 'Community names, with or without r/.' },
          days: { type: 'integer', minimum: 1, maximum: 30, default: 7, description: 'Activity window in days.' },
          max_pages: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: 'Pages of 100 newest posts to read per community.' },
        },
        additionalProperties: false,
      },
      async handler({ communities, days, max_pages }) {
        const names = [...new Set(communities.map(communityName))]
        const client = getClient()
        const cutoff = nowSeconds() - days * DAY
        const { results, failures } = await eachItem(names, async (name) => {
          const aboutPath = `/r/${name}/about`
          const about = await client.get(aboutPath)
          if (about?.kind !== 't5' || !about.data) throw new RedditError('shape', `Reddit answered ${aboutPath} with an unexpected shape.`)
          const info = about.data
          if (info.quarantine || !READABLE_TYPES.has(info.subreddit_type)) {
            throw new RedditError('forbidden', `r/${name} is ${info.quarantine ? 'quarantined' : info.subreddit_type}`)
          }
          const sample = []
          let after = null
          let reachedCutoff = false
          for (let page = 0; page < max_pages; page++) {
            const path = `/r/${name}/new`
            const result = listing(await client.get(path, { limit: 100, after }), 't3', path)
            sample.push(...result.items)
            after = result.after
            if (sample.some((p) => p.created_utc < cutoff)) {
              reachedCutoff = true
              break
            }
            if (!after) {
              reachedCutoff = true
              break
            }
          }
          const inWindow = sample.filter((p) => p.created_utc >= cutoff)
          const oldest = Math.min(...inWindow.map((p) => p.created_utc), nowSeconds())
          const spanDays = reachedCutoff ? days : Math.max((nowSeconds() - oldest) / DAY, 1 / 24)
          const commentsPerDay = inWindow.reduce((sum, p) => sum + (p.num_comments ?? 0), 0) / spanDays
          const subscribers = info.subscribers ?? 0
          return {
            name: info.display_name ?? name,
            subscribers,
            posts_per_day: round(inWindow.length / spanDays, 1),
            comments_per_day: round(commentsPerDay, 1),
            sample_posts: inWindow.length,
            sample_days: round(spanDays, 2),
            capped: !reachedCutoff,
            rank_score: round(Math.log10(1 + subscribers) + Math.log10(1 + commentsPerDay), 3),
            description: trimText(info.public_description, 120),
          }
        })
        if (results.length === 0) throw allFailed('community measurement', failures)
        results.sort((a, b) => b.rank_score - a.rank_score)
        return {
          complete: failures.length === 0,
          window_days: days,
          measured: results.map((r, i) => ({ rank: i + 1, ...r })),
          failures: failures.map((f) => ({ community: f.item, kind: f.kind, reason: f.reason })),
          note: 'capped means the newest posts did not reach back to the window start; the rates then cover sample_days only.',
          ...client.stats(),
        }
      },
    },
    {
      name: 'collect_posts',
      title: 'Collect posts',
      description:
        "Collects the top posts of up to 5 communities over the window, or the top posts matching a query inside a community. Pass the scan_id of an earlier call to add more communities to the same scan, with the same window. Drops removed posts, bots, moderator and pinned posts, promotions, memes, low-engagement posts, duplicates and posts outside the window, and counts each reason. Weights each kept post by engagement relative to its community and by recency (half-life of half the window) and returns the highest-weighted ones per community. Read 'complete' and 'warnings' before using the data.",
      inputSchema: {
        type: 'object',
        required: ['communities'],
        properties: {
          communities: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', minLength: 2, maxLength: 24 },
                query: { type: 'string', minLength: 1, maxLength: 200, description: 'Only posts matching this search, for communities that cover more than the topic.' },
              },
              additionalProperties: false,
            },
          },
          scan_id: { type: 'string', minLength: 1, maxLength: 40, description: 'Add to this scan instead of starting a new one. Its window is kept.' },
          days: { type: 'integer', minimum: 1, maximum: 365, default: 7, description: 'Analysis window in days. Ignored when adding to a scan.' },
          per_community: { type: 'integer', minimum: 5, maximum: 30, default: 20, description: 'Highest-weighted posts returned per community.' },
          fetch_limit: { type: 'integer', minimum: 25, maximum: 500, default: 100, description: 'Posts read per community before filtering, in pages of 100.' },
        },
        additionalProperties: false,
      },
      async handler({ communities, scan_id, days, per_community, fetch_limit }) {
        const targets = communities.map((c) => ({ name: communityName(c.name), query: c.query?.trim() || null }))
        let scan = null
        if (scan_id) {
          scan = scans.get(scan_id)
          if (!scan) throw inputError(`Unknown scan_id "${scan_id}". Scans live in memory for this session only. Start a new scan.`)
        } else {
          const at = nowSeconds()
          scan = {
            id: `scan-${randomUUID().slice(0, 8)}`,
            days,
            at,
            cutoff: at - days * DAY,
            coverage: [],
            filtered: { outside_window: 0, removed: 0, bot: 0, moderator: 0, promotional: 0, meme: 0, low_engagement: 0, duplicate: 0 },
            warnings: [],
            posts: [],
            seen: new Set(),
          }
        }
        const scanned = new Set(scan.coverage.map((c) => `${c.community.toLowerCase()}|${c.query ?? ''}`))
        const repeats = targets.filter((target) => scanned.has(`${target.name.toLowerCase()}|${target.query ?? ''}`))
        if (repeats.length > 0) throw inputError(`Already in ${scan.id}: ${repeats.map((r) => r.name).join(', ')}.`)

        const client = getClient()
        const source = client.stats().data_source
        scan.source ??= source
        if (scan.source !== source) {
          throw inputError(`${scan.id} holds ${scan.source} data and the current source is ${source}. Start a new scan, since one scan never mixes sources.`)
        }
        const t = redditTimeRange(scan.days)
        const coverage = []
        const added = []

        const { failures } = await eachItem(targets, async ({ name, query }) => {
          const path = query ? `/r/${name}/search` : `/r/${name}/top`
          const raw = []
          let after = null
          do {
            const params = query ? { q: query, restrict_sr: 'on', sort: 'top', t, limit: 100, after } : { t, limit: 100, after }
            const result = listing(await client.get(path, params), 't3', path)
            raw.push(...result.items)
            after = result.after
          } while (after && raw.length < fetch_limit)

          const filtered = { ...scan.filtered }
          const kept = []
          for (const post of raw) {
            if (post.created_utc < scan.cutoff) {
              filtered.outside_window++
              continue
            }
            const reason = postNoiseReason(post)
            if (reason) {
              filtered[reason]++
              continue
            }
            const key = post.crosspost_parent ?? `t3_${post.id}`
            if (scan.seen.has(key) || kept.some((k) => k.key === key)) {
              filtered.duplicate++
              continue
            }
            kept.push({
              key,
              id: post.id,
              community: post.subreddit ?? name,
              title: trimText(post.title, 200),
              text: trimText(post.selftext, 200),
              link: post.is_self || /(^|\.)(reddit\.com|redd\.it)$/.test(post.domain ?? '') ? null : post.domain,
              flair: post.link_flair_text || null,
              score: post.score ?? 0,
              num_comments: post.num_comments ?? 0,
              created_utc: post.created_utc,
              url: `https://www.reddit.com/r/${post.subreddit ?? name}/comments/${post.id}/`,
            })
          }
          // Commit only after the whole community succeeded, so a failure leaves no partial counts.
          scan.filtered = filtered
          for (const post of kept) scan.seen.add(post.key)
          weighCommunity(kept, scan.days, scan.at)
          kept.sort((a, b) => b.weight - a.weight)
          const top = kept.slice(0, per_community)
          added.push(...top)
          coverage.push({ community: name, query, status: kept.length > 0 ? 'ok' : 'empty', read: raw.length, kept: kept.length, returned: top.length, more_available: Boolean(after) })
        })

        for (const f of failures) coverage.push({ community: f.item.name, query: f.item.query, status: 'failed', reason: f.reason })
        const warnings = []
        for (const c of coverage) {
          if (c.status === 'failed') warnings.push(`r/${c.community} was not scanned: ${c.reason}`)
          if (c.status === 'empty') warnings.push(`r/${c.community} had no qualifying posts in the window.`)
        }
        if (failures.length === targets.length && scan.posts.length === 0) {
          throw allFailed('community scan', failures.map((f) => ({ reason: f.reason })))
        }

        scan.coverage.push(...coverage)
        scan.warnings.push(...warnings)
        scan.posts.push(...added)
        scan.window = { from: new Date(scan.cutoff * 1000).toISOString(), to: new Date(scan.at * 1000).toISOString() }
        if (!scans.has(scan.id)) {
          scans.set(scan.id, scan)
          if (scans.size > MAX_SCANS) scans.delete(scans.keys().next().value)
        }

        return {
          scan_id: scan.id,
          complete: failures.length === 0,
          warnings,
          window: { days: scan.days, ...scan.window },
          coverage,
          scan_totals: {
            communities: scan.coverage.length,
            failed: scan.coverage.filter((c) => c.status === 'failed').length,
            posts: scan.posts.length,
            filtered: scan.filtered,
          },
          posts: added.map((p) => ({
            id: p.id,
            community: p.community,
            title: p.title,
            text: p.text || undefined,
            link: p.link || undefined,
            flair: p.flair || undefined,
            score: p.score,
            comments: p.num_comments,
            date: new Date(p.created_utc * 1000).toISOString().slice(0, 10),
            weight: round(p.weight, 3),
            url: p.url,
          })),
          ...client.stats(),
        }
      },
    },
    {
      name: 'get_comments',
      title: 'Get top comments',
      description:
        'Returns the top-level comments with the highest scores for up to 10 posts, without bots, moderator comments and removed comments. Use it on the highest-weighted threads to read what people actually say. Usernames are not returned.',
      inputSchema: {
        type: 'object',
        required: ['post_ids'],
        properties: {
          post_ids: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 15 } },
          per_post: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
        },
        additionalProperties: false,
      },
      async handler({ post_ids, per_post }) {
        const ids = [...new Set(post_ids.map(postId))]
        const client = getClient()
        const { results, failures } = await eachItem(ids, async (id) => {
          const path = `/comments/${id}`
          const body = await client.get(path, { sort: 'top', limit: Math.min(per_post * 2, 100), depth: 1 })
          if (!Array.isArray(body) || body.length < 2) throw new RedditError('shape', `Reddit answered ${path} with an unexpected shape.`)
          const [post] = listing(body[0], 't3', path).items
          const { items } = listing(body[1], 't1', path)
          const kept = items.filter((c) => !commentNoiseReason(c)).sort((a, b) => b.score - a.score).slice(0, per_post)
          return {
            id,
            community: post?.subreddit,
            title: trimText(post?.title, 200),
            total_comments: post?.num_comments ?? null,
            comments: kept.map((c) => ({
              score: c.score,
              text: trimText(c.body, 300),
              url: `https://www.reddit.com${c.permalink}`,
            })),
            dropped: items.length - kept.length,
          }
        })
        if (results.length === 0) throw allFailed('comment request', failures)
        return {
          complete: failures.length === 0,
          threads: results,
          failures: failures.map((f) => ({ post_id: f.item, reason: f.reason })),
          ...client.stats(),
        }
      },
    },
    {
      name: 'score_sentiment',
      title: 'Score sentiment',
      description:
        'Turns your per-thread labels into the sentiment index (-100 to +100), the trend between the recent and earlier half of the window, per-community indices, evidence strength, the rule-based verdict with what would change it, and weighted tallies of themes, intents, brands and tickers with their top thread ids. Label only posts from the scan; unknown ids are rejected. stance null marks an off-topic thread, which is left out. Optionally writes every thread with its weight and label to an evidence JSON file.',
      inputSchema: {
        type: 'object',
        required: ['scan_id', 'mode', 'labels'],
        properties: {
          scan_id: { type: 'string', minLength: 1, maxLength: 40 },
          mode: { type: 'string', enum: ['market', 'industry'] },
          labels: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: {
              type: 'object',
              required: ['id', 'stance'],
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 15 },
                stance: {
                  type: ['integer', 'null'],
                  enum: [-1, 0, 1, null],
                  description: 'market: 1 bullish, -1 bearish, 0 mixed or neutral. industry: 1 positive or wants to buy, -1 negative or regrets, 0 neutral or asking. null: off-topic.',
                },
                intent: { type: 'string', maxLength: 40, description: 'industry: buying, owning, wanting, complaint or discussion. market: outlook, position, news or discussion.' },
                themes: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 60 }, description: 'Short topic tags from a consistent vocabulary, such as "price", "durability".' },
                brands: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 60 } },
                tickers: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 12 } },
              },
              additionalProperties: false,
            },
          },
          evidence_path: { type: 'string', maxLength: 1000, description: 'Absolute path of a .json file to write the evidence to.' },
        },
        additionalProperties: false,
      },
      async handler({ scan_id, mode, labels, evidence_path }) {
        const scan = scans.get(scan_id)
        if (!scan) throw inputError(`Unknown scan_id "${scan_id}". Scans live in memory for this session only. Run collect_posts again.`)
        if (evidence_path && (!isAbsolute(evidence_path) || !evidence_path.endsWith('.json'))) {
          throw inputError('evidence_path must be an absolute path ending in .json.')
        }
        const known = new Set(scan.posts.map((p) => p.id))
        const unknown = labels.map((l) => l.id.replace(/^t3_/, '')).filter((id) => !known.has(id))
        if (unknown.length > 0) {
          throw inputError(`${unknown.length} labels name posts that are not in ${scan_id}: ${unknown.slice(0, 10).join(', ')}. Label only posts from the scan.`)
        }
        const labelMap = new Map(
          labels.map((l) => [
            l.id.replace(/^t3_/, ''),
            { stance: l.stance, intent: l.intent?.trim() || null, themes: l.themes ?? [], brands: l.brands ?? [], tickers: l.tickers ?? [] },
          ]),
        )
        const unlabeled = scan.posts.filter((p) => !labelMap.has(p.id)).length
        const offTopic = [...labelMap.values()].filter((l) => l.stance === null).length
        const coverage = scan.coverage.filter((c) => c.status !== 'failed').length / scan.coverage.length

        const result = aggregate({ posts: scan.posts, labels: labelMap, days: scan.days, coverage, mode })
        if (!result) throw inputError('No label has a stance, so there is nothing to score. Every thread was marked off-topic.')
        const { weights, ...metrics } = result

        const warnings = [...scan.warnings, ...metrics.warnings]
        if (scan.source === 'browser_fallback') {
          warnings.unshift('Unofficial data: read from the Reddit website through a browser, not the official Data API. Reddit does not permit this. Mark the report as unofficial.')
        }
        if (unlabeled / scan.posts.length > RULES.unlabeledWarn) {
          warnings.push(`${unlabeled} of ${scan.posts.length} returned posts are unlabeled and left out of the index.`)
        }
        const sample = { returned: scan.posts.length, labeled: labelMap.size, scored: labelMap.size - offTopic, off_topic: offTopic, unlabeled }

        if (evidence_path) {
          mkdirSync(dirname(evidence_path), { recursive: true })
          const evidence = {
            generated_at: new Date(now()).toISOString(),
            plugin_version: version,
            data_source: scan.source,
            mode,
            scan: { id: scan.id, window_days: scan.days, window: scan.window, coverage: scan.coverage, filtered: scan.filtered },
            rules: RULES,
            sample,
            result: { ...metrics, warnings },
            threads: scan.posts.map((p) => ({
              id: p.id,
              community: p.community,
              title: p.title,
              url: p.url,
              score: p.score,
              comments: p.num_comments,
              date: new Date(p.created_utc * 1000).toISOString().slice(0, 10),
              age_days: round(p.age_days, 2),
              weight: round(p.weight, 4),
              index_weight: round(weights.get(p.id) ?? 0, 5),
              label: labelMap.get(p.id) ?? null,
            })),
          }
          writeFileSync(evidence_path, `${JSON.stringify(evidence, null, 2)}\n`)
        }

        return {
          scan_id,
          data_source: scan.source,
          mode,
          window: { days: scan.days, ...scan.window },
          sample,
          ...metrics,
          warnings,
          evidence_file: evidence_path ?? null,
        }
      },
    },
  ]

  const byName = new Map(definitions.map((d) => [d.name, d]))

  async function call(name, args) {
    const tool = byName.get(name)
    if (!tool) return null
    const errors = validate(tool.inputSchema, args ?? {})
    if (errors.length > 0) throw inputError(`Invalid input: ${errors.join('; ')}`)
    return tool.handler(withDefaults(tool.inputSchema, args ?? {}))
  }

  return {
    definitions: definitions.map(({ handler, ...definition }) => ({ ...definition, annotations: { title: definition.title, ...READ_ONLY } })),
    call,
  }
}
