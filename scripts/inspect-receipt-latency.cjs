'use strict';
// Read-only Cloud Run diagnostics, without receipt codes, payer data or credentials.
const path = require('node:path');
const { resolveFirebaseCli } = require('./lib/toolchain.cjs');
async function main() {
  const cli = resolveFirebaseCli(path.resolve(__dirname, '..'));
  const auth = require(path.resolve(path.dirname(cli.argumentsPrefix[0]), '../auth.js'));
  const account = auth.getGlobalDefaultAccount();
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const since = new Date(Date.now() - 8 * 3600000).toISOString();
  const response = await fetch('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceNames: ['projects/vanbransa-pos'],
      filter: `resource.type="cloud_run_revision" AND (resource.labels.service_name="lookupmpesareceipt" OR resource.labels.service_name="settlesale") AND timestamp>="${since}"`,
      orderBy: 'timestamp desc', pageSize: 150 }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Logging HTTP ${response.status}`);
  const data = await response.json();
  const rows = (data.entries || []).map(row => ({ time: row.timestamp, service: row.resource?.labels?.service_name,
    severity: row.severity, status: row.httpRequest?.status, latency: row.httpRequest?.latency,
    diagnostic: (row.textPayload || row.jsonPayload?.message || '').replace(/\b[A-Z0-9]{10}\b/g, '[receipt]').replace(/\b\d{9,15}\b/g, '[number]').slice(0, 700) }));
  console.log(JSON.stringify({ entries: rows, moreAvailable: Boolean(data.nextPageToken) }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
