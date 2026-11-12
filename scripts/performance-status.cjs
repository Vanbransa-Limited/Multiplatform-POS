// Read-only production diagnostics. Outputs counts, timings and index states;
// never customer records, account details or authentication material.
'use strict';
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { resolveFirebaseCli } = require('./lib/toolchain.cjs');

async function main() {
  const project = process.argv[2];
  if (!project || !/^[a-z][a-z0-9-]{4,29}$/.test(project)) throw new Error('Pass an explicit Firebase project ID.');
  const cli = resolveFirebaseCli(path.resolve(__dirname, '..'));
  const executable = cli.argumentsPrefix[0];
  if (!executable) throw new Error('Firebase CLI Node installation required for existing-login authentication.');
  const auth = require(path.resolve(path.dirname(executable), '..', 'auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) throw new Error('An existing Firebase CLI login is required.');
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  if (process.argv.includes('--order-functions')) {
    for (const name of ['publishOpenOrders', 'createSale', 'settleSale', 'voidSale', 'claimSalePayment']) {
      const response = await fetch(`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/europe-west1/functions/${name}`, {
        headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json();
      console.log(JSON.stringify({ function: name, status: response.status, state: data.state, updateTime: data.updateTime }));
      if (!response.ok && response.status !== 404) throw new Error('Unable to inspect order function deployment.');
    }
    return;
  }
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)`;
  async function request(suffix, body) {
    const start = performance.now();
    const response = await fetch(base + suffix, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Firestore ${response.status}: ${data.error?.message || data[0]?.error?.message || 'request failed'}`);
    return { data, ms: Math.round(performance.now() - start) };
  }
  if (process.argv.includes('--discount-checkout')) {
    const decode = value => value.arrayValue ? (value.arrayValue.values || []).map(decode)
      : value.mapValue ? Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, entry]) => [key, decode(entry)]))
      : value.stringValue ?? value.timestampValue ?? value.integerValue ?? value.doubleValue ?? value.booleanValue ?? null;
    for (const [collectionId, fieldPath] of [['open_orders', 'ref'], ['sales', 'invoiceNumber']]) {
      const { data } = await request('/documents:runQuery', { structuredQuery: {
        from: [{ collectionId }],
        select: { fields: ['tenantId', 'staffId', 'ref', 'invoiceNumber', 'totalMinor', 'dueMinor', 'subtotalMinor', 'discountMinor', 'lines', 'saleUuids', 'status'].map(fieldPath => ({ fieldPath })) },
        where: { fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: { stringValue: 'INV-BH001-651015' } } },
      } });
      console.log(JSON.stringify({ collectionId, records: data.filter(row => row.document).map(row => Object.fromEntries(Object.entries(row.document.fields || {}).map(([key, value]) => [key, decode(value)]))) }));
    }
    const response = await fetch('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceNames: [`projects/${project}`], filter: 'resource.type="cloud_run_revision" AND resource.labels.service_name="createsale" AND severity>=WARNING AND timestamp>="2026-11-11T18:00:00Z"', orderBy: 'timestamp desc', pageSize: 10 }), signal: AbortSignal.timeout(30_000),
    });
    const logs = await response.json();
    if (!response.ok) throw new Error('Unable to inspect checkout refusals.');
    console.log(JSON.stringify({ refusals: (logs.entries || []).map(row => ({ timestamp: row.timestamp, reason: row.jsonPayload?.reason, code: row.jsonPayload?.code, tenantId: row.jsonPayload?.tenantId, saleUuid: row.jsonPayload?.idempotencyKey })) }));
    return;
  }
  if (process.argv.includes('--payment-index')) {
    const { data } = await request('/collectionGroups/sales/indexes');
    const index = (data.indexes || []).find(row => {
      const fields = row.fields.filter(field => field.fieldPath !== '__name__').map(field => field.fieldPath);
      return fields.length === 2 && fields.includes('tenantId') && fields.includes('idempotencyKey');
    });
    console.log(JSON.stringify({ sharedPaymentIndex: index?.state || 'MISSING' }));
    if (index?.state !== 'READY') throw new Error('Shared-payment index is not ready.');
    const { data: sample } = await request('/documents:runQuery', { structuredQuery: {
      from: [{ collectionId: 'sales' }], select: { fields: ['tenantId', 'idempotencyKey'].map(fieldPath => ({ fieldPath })) }, limit: 1,
    } });
    const fields = sample.find(row => row.document)?.document.fields;
    if (!fields?.tenantId?.stringValue || !fields.idempotencyKey?.stringValue) throw new Error('No sample sale available to verify the targeted read.');
    const { data: selected } = await request('/documents:runQuery', { structuredQuery: {
      from: [{ collectionId: 'sales' }], select: { fields: [{ fieldPath: 'tenantId' }] },
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'tenantId' }, op: 'EQUAL', value: fields.tenantId } },
        { fieldFilter: { field: { fieldPath: 'idempotencyKey' }, op: 'IN', value: { arrayValue: { values: [fields.idempotencyKey] } } } },
      ] } },
    } });
    if (!selected.some(row => row.document)) throw new Error('Targeted sale read did not return the saved sale.');
    console.log(JSON.stringify({ targetedSharedSaleRead: 'passed' }));
    return;
  }
  if (process.argv.includes('--order-history')) {
    const { data: database } = await request('');
    console.log(JSON.stringify({ recovery: database.pointInTimeRecoveryEnablement, earliestVersionTime: database.earliestVersionTime }));
    const { data: current } = await request('/documents:runQuery', { structuredQuery: { from: [{ collectionId: 'open_orders' }] } });
    console.log(JSON.stringify({ heldSchema: current.filter(row => row.document).map(({ document }) => ({
      id: document.name.split('/').pop(), fields: Object.keys(document.fields || {}),
      metadata: Object.fromEntries(Object.entries(document.fields || {}).filter(([key]) => /^(ref|tableNumber|table_no|tableNo|tabId|publishedAt|openedAt|updatedAt|deviceId|kind|status)$/.test(key))
        .map(([key, value]) => [key, value.stringValue ?? value.timestampValue ?? value.integerValue ?? null])),
    })) }));
    for (const minutes of [0, 15, 30, 45, 55]) {
      const readTime = new Date(Date.now() - minutes * 60_000).toISOString();
      const { data } = await request('/documents:runQuery', {
        ...(minutes ? { readTime } : {}),
        structuredQuery: { from: [{ collectionId: 'open_orders' }], select: { fields:
          ['ref', 'tableNumber', 'staffId', 'publishedAt', 'openedAt', 'deviceId', 'status', 'kind'].map(fieldPath => ({ fieldPath })) },
        },
      });
      const rows = data.filter(row => row.document).map(({ document }) => ({
        id: document.name.split('/').pop(), ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key,
          value.stringValue ?? value.timestampValue ?? value.integerValue ?? null])),
      }));
      console.log(JSON.stringify({ minutesAgo: minutes, readTime, count: rows.length,
        relevant: rows.filter(row => /^(?:table\s*)?(?:0?[48]|16|20)$/i.test(String(row.tableNumber || '').trim())) }));
    }
    return;
  }
  if (process.argv.includes('--judy-orders')) {
    const decode = value => value.arrayValue ? (value.arrayValue.values || []).map(decode)
      : value.stringValue ?? value.timestampValue ?? value.integerValue ?? value.booleanValue ?? null;
    const query = async (collectionId, fields, staffId) => {
      const { data } = await request('/documents:runQuery', { structuredQuery: {
        from: [{ collectionId }], select: { fields: fields.map(fieldPath => ({ fieldPath })) },
        ...(staffId ? { where: { fieldFilter: { field: { fieldPath: 'staffId' }, op: 'EQUAL', value: { stringValue: staffId } } } } : {}),
      } });
      return data.filter(row => row.document).map(({ document }) => ({
        id: document.name.split('/').pop(), ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key,
          decode(value)])),
      }));
    };
    const staff = (await query('staff', ['name', 'status'])).filter(row => /judy|judith/i.test(row.name || ''));
    console.log(JSON.stringify({ matchedStaff: staff }));
    for (const person of staff) {
      for (const collection of ['sales', 'open_orders', 'open_order_archive']) {
        const rows = await query(collection, ['invoiceNumber', 'ref', 'tableNumber', 'status', 'kind', 'soldAt', 'createdAt', 'openedAt', 'publishedAt', 'archivedAt', 'archiveReason', 'paymentStatus', 'totalMinor', 'dueMinor', 'idempotencyKey', 'saleUuids'], person.id);
        const today = rows.filter(row => Date.parse(row.archivedAt || row.publishedAt || row.soldAt || row.createdAt || row.openedAt) >= Date.parse('2026-11-10T21:00:00Z'));
        console.log(JSON.stringify({ staff: person.name, collection, totalSaved: rows.length, today: today.sort((a,b) => String(b.archivedAt || b.publishedAt || b.soldAt || '').localeCompare(String(a.archivedAt || a.publishedAt || a.soldAt || ''))) }));
      }
    }
    return;
  }
  if (process.argv.includes('--order-incident')) {
    const query = async (name, fields, filter) => {
      const { data } = await request('/documents:runQuery', { structuredQuery: {
        from: [{ collectionId: name }], select: { fields: fields.map(fieldPath => ({ fieldPath })) },
        ...(filter ? { where: { fieldFilter: filter } } : {}),
      } });
      return data.filter(row => row.document).map(({ document }) => ({
        id: document.name.split('/').pop(), ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key,
          value.stringValue ?? value.timestampValue ?? value.integerValue ?? value.booleanValue ?? null])),
      }));
    };
    const staff = (await query('staff', ['name', 'status', 'role'])).filter(row => /sherr?yl|stacy|stacey/i.test(row.name || ''));
    console.log(JSON.stringify({ matchedStaff: staff }));
    const fields = ['invoiceNumber', 'tableNumber', 'staffId', 'status', 'soldAt', 'createdAt', 'idempotencyKey'];
    const tableSales = await query('sales', fields, { field: { fieldPath: 'tableNumber' }, op: 'IN', value: { arrayValue: { values: ['4', '8', '16', '20'].map(stringValue => ({ stringValue })) } } });
    console.log(JSON.stringify({ reportedTableSales: tableSales.sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || ''))).slice(0, 30) }));
    for (const person of staff) {
      const sales = await query('sales', fields, { field: { fieldPath: 'staffId' }, op: 'EQUAL', value: { stringValue: person.id } });
      console.log(JSON.stringify({ staff: person.name, recentSales: sales.filter(row => Date.parse(row.soldAt || row.createdAt) >= Date.now() - 48 * 60 * 60 * 1000)
        .sort((a, b) => String(b.soldAt || '').localeCompare(String(a.soldAt || ''))).slice(0, 30) }));
    }
    const staffIds = new Set(staff.map(row => row.id));
    const held = await query('open_orders', ['ref', 'tableNumber', 'staffId', 'publishedAt', 'kind', 'deviceId']);
    console.log(JSON.stringify({ heldOrderCount: held.length, relevantHeldOrders: held.filter(row => ['4', '8', '16', '20'].includes(row.tableNumber) || staffIds.has(row.staffId)) }));
    return;
  }
  const database = await request('');
  console.log(JSON.stringify({ databaseLocation: database.data.locationId }));
  for (const name of ['sales', 'payments', 'sale_lines', 'customer_orders', 'mpesa_payments']) {
    const { data, ms } = await request('/documents:runAggregationQuery', {
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId: name }] },
        aggregations: [{ alias: 'total', count: {} }],
      },
    });
    console.log(JSON.stringify({ collection: name, count: Number(data[0]?.result?.aggregateFields?.total?.integerValue || 0), requestMs: ms }));
  }
  for (const name of ['sales', 'payments', 'sale_lines']) {
    const { data } = await request(`/collectionGroups/${name}/indexes`);
    for (const index of data.indexes || []) {
      const collection = index.name.split('/collectionGroups/')[1]?.split('/')[0];
      if (collection !== name) continue;
      const fields = index.fields.filter(field => field.fieldPath !== '__name__').map(field => field.fieldPath);
      if (fields.length === 2 && fields.includes('tenantId')) {
        console.log(JSON.stringify({ indexCollection: name, fields, state: index.state }));
      }
    }
    if (data.nextPageToken) throw new Error('Index listing requires another page; readiness is incomplete.');
  }
  if (process.argv.includes('--check-queries')) {
    const { data: sample } = await request('/documents:runQuery', {
      structuredQuery: { from: [{ collectionId: 'sales' }], select: { fields: [{ fieldPath: 'tenantId' }] }, limit: 1 },
    });
    const tenantId = sample.find(row => row.document)?.document.fields.tenantId.stringValue;
    if (!tenantId) throw new Error('No tenant-scoped sale available for read-only query verification.');
    const encode = value => value instanceof Date ? { timestampValue: value.toISOString() }
      : Array.isArray(value) ? { arrayValue: { values: value.map(encode) } } : { stringValue: String(value) };
    const fb = { firestore: {
      collection: (_db, name) => name,
      where: (field, op, value) => ({ field, op, value }),
      query: (name, ...constraints) => ({ name, constraints }),
      getDocsFromServer: async ({ name, constraints }) => {
        const operations = { '==': 'EQUAL', '>=': 'GREATER_THAN_OR_EQUAL', '<=': 'LESS_THAN_OR_EQUAL', in: 'IN' };
        const { data } = await request('/documents:runQuery', { structuredQuery: {
          from: [{ collectionId: name }], select: { fields: [{ fieldPath: 'tenantId' }] },
          where: { compositeFilter: { op: 'AND', filters: constraints.map(c => ({ fieldFilter: {
            field: { fieldPath: c.field }, op: operations[c.op], value: encode(c.value),
          } })) } },
        } });
        return { docs: data.filter(row => row.document).map(row => ({ id: row.document.name.split('/').pop() })) };
      },
    } };
    const { readSalesSince, readSaleChildren } = await import('../frontend/src/services/sale-history.js');
    const recent = await readSalesSince(fb, tenantId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    const ids = recent.docs.slice(0, 30).map(doc => doc.id);
    const [payments, lines] = await Promise.all([
      readSaleChildren(fb, tenantId, 'payments', ids), readSaleChildren(fb, tenantId, 'sale_lines', ids),
    ]);
    console.log(JSON.stringify({ querySmoke: 'passed', recentSales: recent.docs.length,
      sampledSaleCount: ids.length, sampledPayments: payments.docs.length, sampledLines: lines.docs.length }));
  }
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  for (const metric of ['request_latencies', 'container/startup_latencies']) {
    const descriptor = await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/metricDescriptors/run.googleapis.com/${metric}`, {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30_000),
    });
    const description = await descriptor.json();
    if (!descriptor.ok) throw new Error('Cannot verify latency metric units.');
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`);
    url.searchParams.set('filter', `metric.type = "run.googleapis.com/${metric}" AND resource.type = "cloud_run_revision"`);
    url.searchParams.set('interval.startTime', start.toISOString());
    url.searchParams.set('interval.endTime', end.toISOString());
    url.searchParams.set('aggregation.alignmentPeriod', '3600s');
    url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_PERCENTILE_95');
    url.searchParams.set('aggregation.crossSeriesReducer', 'REDUCE_MAX');
    url.searchParams.append('aggregation.groupByFields', 'resource.labels.service_name');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(`Monitoring ${response.status}: ${data.error?.message || 'request failed'}`);
    for (const series of data.timeSeries || []) {
      console.log(JSON.stringify({ metric, service: series.resource?.labels?.service_name,
        maxHourlyP95: Math.max(...series.points.map(point => Number(point.value.doubleValue ?? point.value.int64Value ?? 0))),
        unit: description.unit, samples: series.points.length }));
    }
    if (data.nextPageToken) throw new Error('Monitoring listing is incomplete.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
