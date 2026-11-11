'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { thinkingTokens } = require('./aiClient');

test('thinkingTokens: exact when reported, estimated for Claude, 0 without thinking, null without usage', () => {
  assert.equal(thinkingTokens({ usage: { output_tokens: 500, thinking_tokens: 320 } }), 320);   // Gemini / OpenAI
  const text = 'x'.repeat(360);   // ~100 visible tokens
  assert.equal(thinkingTokens({ usage: { output_tokens: 900 }, content: [{ type: 'thinking', thinking: 'summary' }, { type: 'text', text }] }), 800);
  assert.equal(thinkingTokens({ usage: { output_tokens: 900 }, content: [{ type: 'text', text }] }), 0);
  assert.equal(thinkingTokens({ usage: { output_tokens: 50 }, content: [{ type: 'redacted_thinking' }, { type: 'text', text: 'y'.repeat(3600) }] }), 0);
  assert.equal(thinkingTokens(null), null);
});
