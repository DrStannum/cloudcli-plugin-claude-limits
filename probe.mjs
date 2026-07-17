#!/usr/bin/env node
/**
 * Standalone endpoint probe. Run this in your own terminal to confirm the
 * usage endpoint + response shape before/after enabling the plugin:
 *
 *   node ~/.claude-code-ui/plugins/cloudcli-claude-limits/probe.mjs
 *
 * It reads the same local OAuth token the plugin uses, calls the endpoint,
 * and prints the HTTP status + raw JSON. If the field names differ from what
 * the plugin expects (five_hour / seven_day / used_percentage / resets_at),
 * paste the output back and the normalizer in dist/server.js can be adjusted.
 *
 * Override the endpoint:  CLAUDE_LIMITS_ENDPOINT=... node probe.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT =
  process.env.CLAUDE_LIMITS_ENDPOINT || 'https://api.anthropic.com/api/oauth/usage';
const CREDS =
  process.env.CLAUDE_LIMITS_CREDS ||
  path.join(os.homedir(), '.claude', '.credentials.json');

function token() {
  const j = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  const o = j.claudeAiOauth || j.oauth || j;
  return { access: o.accessToken || o.access_token, sub: o.subscriptionType, scopes: o.scopes };
}

const { access, sub, scopes } = token();
if (!access) {
  console.error('No access token in', CREDS);
  process.exit(1);
}
console.log('creds:', CREDS);
console.log('subscriptionType:', sub, '| scopes:', scopes);
console.log('GET', ENDPOINT, '\n');

const res = await fetch(ENDPOINT, {
  headers: {
    Authorization: `Bearer ${access}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'cloudcli-claude-limits/1.0',
    Accept: 'application/json',
  },
});

console.log('HTTP', res.status, res.statusText);
const text = await res.text();
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
