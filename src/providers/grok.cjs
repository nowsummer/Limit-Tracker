'use strict';
const { t } = require('../i18n.cjs');

/**
 * Consumer SuperGrok's weekly pool is separate from xAI API rate limits.
 * No documented public read API was found for this pool (2026-10-04).
 * Keep the account available as a manual snapshot / official-page shortcut;
 * never convert API keys, message counts, or a successful login into fake quota.
 */
async function fetchGrokUsage({ now = Date.now() } = {}) {
  return {
    id: 'grok', name: 'Grok', status: 'unsupported', plan: null, windows: [],
    updatedAt: new Date(now).toISOString(),
    source: t('grok.source', null, 'ko'), sourceKey: 'grok.source',
    error: t('grok.err.manual', null, 'ko'), errorKey: 'grok.err.manual',
    manualSupported: true,
  };
}

module.exports = { fetchGrokUsage };
