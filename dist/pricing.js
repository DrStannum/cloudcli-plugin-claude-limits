// @ts-check
/**
 * Claude Usage — model pricing table.
 *
 * Ported 1:1 from cloudcli-plugin-claude-usage/src/pricing.ts (TypeScript ->
 * plain JS, same regexes and $/M-token rates, no logic changes).
 *
 * @typedef {{input: number, output: number, cacheCreate: number, cacheRead: number}} TokenCounts
 */

/** $ per million tokens: [input, output, cacheWrite, cacheRead]. */
/** @type {[RegExp, [number, number, number, number]][]} */
// Order matters: first match wins. Cache write = 1.25x input (5m TTL),
// cache read = 0.1x input, per Anthropic pricing.
const PRICES = [
  [/fable|mythos/, [10, 50, 12.5, 1]],
  [/opus-4-[01]\b|3-opus/, [15, 75, 18.75, 1.5]],
  [/opus/, [5, 25, 6.25, 0.5]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku-4/, [1, 5, 1.25, 0.1]],
  [/haiku-3-5|3-5-haiku/, [0.8, 4, 1, 0.08]],
  [/haiku/, [0.25, 1.25, 0.3, 0.03]],
];

const M = 1_000_000;

/**
 * Estimated cost in dollars, or null when the model is not in the price table.
 * @param {string} model @param {TokenCounts} t @returns {number|null}
 */
export function estimateCost(model, t) {
  const found = PRICES.find(([re]) => re.test(model));
  if (!found) return null;
  const [inp, out, cw, cr] = found[1];
  return (t.input * inp + t.output * out + t.cacheCreate * cw + t.cacheRead * cr) / M;
}
