// Noise filters. Each returns the reason a post or comment is dropped, or null to keep it.
// Reasons are counted per scan, so a report can say exactly what was left out and why.

const BOT_ACCOUNTS = new Set(
  [
    'AutoModerator',
    'VisualMod',
    'RemindMeBot',
    'sneakpeekbot',
    'RepostSleuthBot',
    'SaveVideo',
    'savevideobot',
    'vredditdownloader',
    'WikiSummarizerBot',
    'B0tRank',
    'TweetLinkerBot',
    'timezone_bot',
    'converter-bot',
    'LinkifyBot',
    'FatFingerHelperBot',
    'GifReversingBot',
    'image_linker_bot',
    'TrendingTickersSmall',
    'QualityVote',
    'ModeratelyHelpfulBot',
  ].map((name) => name.toLowerCase()),
)

const REMOVED_TEXT = new Set(['[removed]', '[deleted]'])
const MEME_FLAIR = /\b(memes?|shitpost(ing)?|humou?r|satire|jokes?|funny)\b/i
const MEME_DOMAINS = new Set(['imgflip.com', '9gag.com', 'knowyourmeme.com', 'tenor.com', 'giphy.com'])
const PROMO_FLAIR = /\b(promo(tion(al)?)?|sponsored|advertisement|ads?|giveaways?|self[- ]?promo(tion)?|affiliate|deals?|sales?|discounts?)\b/i
const PROMO_TITLE = /(promo code|discount code|coupon|use (my )?code|\d+\s?% off|giveaway|affiliate link|referral (link|code)|sign up (with|using) my|link in (bio|comments))/i
const PROMO_DOMAINS = new Set([
  'amzn.to',
  'a.co',
  'bit.ly',
  'tinyurl.com',
  'linktr.ee',
  'shareasale.com',
  'rstyle.me',
  'go.skimresources.com',
  'shopstyle.it',
  'clickbank.net',
])

export function isBotAccount(author) {
  if (!author) return false
  if (BOT_ACCOUNTS.has(author.toLowerCase())) return true
  return /(^|[-_])bot($|[-_\d])/i.test(author) || /[a-z0-9]Bot\d*$/.test(author)
}

function isRemoved(post) {
  return Boolean(post.removed_by_category) || REMOVED_TEXT.has(post.selftext?.trim()) || post.title === '[deleted by user]'
}

function isModeratorPost(post) {
  return Boolean(post.stickied || post.pinned) || post.distinguished === 'moderator' || post.distinguished === 'admin'
}

function isPromotional(post) {
  return (
    Boolean(post.promoted) ||
    PROMO_FLAIR.test(post.link_flair_text ?? '') ||
    PROMO_TITLE.test(post.title ?? '') ||
    PROMO_DOMAINS.has(post.domain ?? '')
  )
}

function isMeme(post) {
  return MEME_FLAIR.test(post.link_flair_text ?? '') || MEME_DOMAINS.has(post.domain ?? '')
}

export function postNoiseReason(post) {
  if (isRemoved(post)) return 'removed'
  if (isBotAccount(post.author)) return 'bot'
  if (isModeratorPost(post)) return 'moderator'
  if (isPromotional(post)) return 'promotional'
  if (isMeme(post)) return 'meme'
  if ((post.score ?? 0) < 2 && (post.num_comments ?? 0) < 2) return 'low_engagement'
  return null
}

export function commentNoiseReason(comment) {
  if (REMOVED_TEXT.has(comment.body?.trim())) return 'removed'
  if (isBotAccount(comment.author)) return 'bot'
  if (comment.stickied || comment.distinguished === 'moderator' || comment.distinguished === 'admin') return 'moderator'
  if ((comment.score ?? 0) < 1) return 'low_score'
  return null
}
