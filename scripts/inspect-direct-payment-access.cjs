'use strict';
// Read-only integration metadata. Never accesses or prints secret values.
const path = require('node:path');
const { resolveFirebaseCli } = require('./lib/toolchain.cjs');
async function main() {
  const cli = resolveFirebaseCli(path.resolve(__dirname, '..'));
  const auth = require(path.resolve(path.dirname(cli.argumentsPrefix[0]), '../auth.js'));
  const account = auth.getGlobalDefaultAccount();
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' };
  const secretsResponse = await fetch('https://secretmanager.googleapis.com/v1/projects/vanbransa-pos/secrets?pageSize=100', { headers, signal: AbortSignal.timeout(20000) });
  if (!secretsResponse.ok) throw new Error(`Cannot inspect secret metadata: HTTP ${secretsResponse.status}`);
  const secrets = await secretsResponse.json();
  const names = (secrets.secrets || []).map(secret => secret.name.split('/').pop()).filter(name => /mpesa|daraja/i.test(name));
  const since = new Date(Date.now() - 4 * 3600000).toISOString();
  const logsResponse = await fetch('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST', headers,
    body: JSON.stringify({ resourceNames: ['projects/vanbransa-pos'],
      filter: `resource.type="cloud_run_revision" AND (resource.labels.service_name="mpesac2bconfirmation" OR resource.labels.service_name="mpesac2bvalidation") AND httpRequest.requestMethod="POST" AND timestamp>="${since}"`,
      pageSize: 50, orderBy: 'timestamp desc' }), signal: AbortSignal.timeout(20000),
  });
  if (!logsResponse.ok) throw new Error(`Cannot inspect C2B delivery logs: HTTP ${logsResponse.status}`);
  const logs = await logsResponse.json();
  console.log(JSON.stringify({ credentialMetadataOnly: true,
    stkCredentialsConfigured: ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_PASSKEY', 'MPESA_SHORTCODE'].every(name => names.includes(name)),
    transactionStatusInitiatorConfigured: names.some(name => /initiator/i.test(name)),
    transactionStatusSecurityCredentialConfigured: names.some(name => /security.?credential/i.test(name)),
    secretMetadataListComplete: !secrets.nextPageToken,
    c2bPostRequestsSince: since,
    c2bRequests: (logs.entries || []).map(row => ({ time: row.timestamp, service: row.resource?.labels?.service_name, status: row.httpRequest?.status })),
    c2bLogListComplete: !logs.nextPageToken }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
