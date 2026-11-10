import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentNoiseReason, isBotAccount, postNoiseReason } from '../plugin/server/filters.js'

const post = (extra) => ({ title: 'A tent question', selftext: 'Which one?', author: 'someone', score: 10, num_comments: 5, domain: 'self.camping', ...extra })

test('bot accounts', () => {
  for (const name of ['AutoModerator', 'RemindMeBot', 'sneakpeekbot', 'auto_bot', 'bot-123', 'PriceCheckBot2']) assert.equal(isBotAccount(name), true, name)
  for (const name of ['Talbot', 'abbot', 'robotics_fan', 'someone', '', undefined]) assert.equal(isBotAccount(name), false, String(name))
})

test('post noise reasons', () => {
  assert.equal(postNoiseReason(post()), null)
  assert.equal(postNoiseReason(post({ removed_by_category: 'moderator' })), 'removed')
  assert.equal(postNoiseReason(post({ selftext: '[deleted]' })), 'removed')
  assert.equal(postNoiseReason(post({ author: 'AutoModerator', stickied: true })), 'bot')
  assert.equal(postNoiseReason(post({ stickied: true })), 'moderator')
  assert.equal(postNoiseReason(post({ distinguished: 'moderator' })), 'moderator')
  assert.equal(postNoiseReason(post({ title: 'Save 25% off with code TENT' })), 'promotional')
  assert.equal(postNoiseReason(post({ link_flair_text: 'Sponsored' })), 'promotional')
  assert.equal(postNoiseReason(post({ domain: 'amzn.to' })), 'promotional')
  assert.equal(postNoiseReason(post({ link_flair_text: 'Meme' })), 'meme')
  assert.equal(postNoiseReason(post({ link_flair_text: 'Shitpost' })), 'meme')
  assert.equal(postNoiseReason(post({ domain: 'imgflip.com' })), 'meme')
  assert.equal(postNoiseReason(post({ score: 1, num_comments: 1 })), 'low_engagement')
  assert.equal(postNoiseReason(post({ score: 1, num_comments: 2 })), null)
  assert.equal(postNoiseReason(post({ link_flair_text: 'Gear Question' })), null)
})

test('comment noise reasons', () => {
  const comment = (extra) => ({ body: 'Good tent', author: 'someone', score: 5, ...extra })
  assert.equal(commentNoiseReason(comment()), null)
  assert.equal(commentNoiseReason(comment({ author: '[deleted]' })), null)
  assert.equal(commentNoiseReason(comment({ body: '[removed]' })), 'removed')
  assert.equal(commentNoiseReason(comment({ author: 'RemindMeBot' })), 'bot')
  assert.equal(commentNoiseReason(comment({ stickied: true })), 'moderator')
  assert.equal(commentNoiseReason(comment({ score: 0 })), 'low_score')
})
