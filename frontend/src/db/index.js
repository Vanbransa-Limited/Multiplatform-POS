import Dexie from 'dexie';
import { selectedCacheTenant, LEGACY_TENANT_ID, tenantStorage } from '../services/tenant-cache.js';
import { db } from './schema';
import * as SEED from './seed-data';
import { firebaseConfigured } from '../services/firebase';

// Helper to compute SHA-256 hash using native Web Crypto API with custom fallback for non-secure contexts
export async function computeHash(message) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const msgBuffer = new TextEncoder().encode(message);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('SubtleCrypto failed, using local hash fallback:', e);
    }
  }
  
  // Local fallback: FNV-1a hash representation for non-secure HTTP/PWA contexts
  let hash = 2166136261;
  for (let i = 0; i < message.length; i++) {
    hash ^= message.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const hashHex = (hash >>> 0).toString(16).padStart(8, '0');
  return hashHex.repeat(8).slice(0, 64); // Repeat to match SHA-256 length (64 chars)
}


// Immutable append-only audit logging helper
export async function logAuditEvent(tenantId, actorId, action, entityType, entityId, beforeJson = null, afterJson = null) {
  return await db.transaction('rw', db.audit_log, async () => {
    // 1. Get the last log entry to retrieve its hash
    const lastEntry = await db.audit_log.orderBy('created_at').last();
    const prevHash = lastEntry ? lastEntry.hash : '0000000000000000000000000000000000000000000000000000000000000000';
    
    // 2. Prepare content
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify({
      tenantId,
      actorId,
      action,
      entityType,
      entityId,
      beforeJson,
      afterJson,
      timestamp,
      prevHash
    });
    
    // 3. Compute hash of the new record including prev_hash
    // Web Crypto is not an IndexedDB request. Keep this transaction (and an
    // enclosing sale/payment transaction) alive until the digest is ready.
    const hash = await Dexie.waitFor(computeHash(payload));
    
    const newEntry = {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      actor_id: actorId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      before_json: beforeJson,
      after_json: afterJson,
      device_id: 'till-device-01',
      ip: '127.0.0.1',
      created_at: timestamp,
      prev_hash: prevHash,
      hash
    };
    
    await db.audit_log.add(newEntry);
    return newEntry;
  });
}

// Verify audit trail integrity by recalculating hash chain
export async function verifyAuditTrail() {
  const logs = await db.audit_log.orderBy('created_at').toArray();
  let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';
  
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log.prev_hash !== expectedPrevHash) {
      return { valid: false, brokenIndex: i, reason: 'Hash chain broken (prev_hash mismatch)' };
    }
    
    const payload = JSON.stringify({
      tenantId: log.tenant_id,
      actorId: log.actor_id,
      action: log.action,
      entityType: log.entity_type,
      entityId: log.entity_id,
      beforeJson: log.before_json,
      afterJson: log.after_json,
      timestamp: log.created_at,
      prevHash: log.prev_hash
    });
    
    const calculatedHash = await computeHash(payload);
    if (log.hash !== calculatedHash) {
      return { valid: false, brokenIndex: i, reason: `Hash mismatch at record ${log.id}` };
    }
    
    expectedPrevHash = log.hash;
  }
  
  return { valid: true, count: logs.length };
}

// Derive current on-hand stock for a product in a branch (across all locations)
export async function getStockOnHand(productId, branchId, location = null) {
  if (!productId) return 0;
  const targetPid = String(productId);
  const targetBid = branchId ? String(branchId) : null;
  if (firebaseConfigured) {
    const rows = await db.stock_balances.where('productId').equals(targetPid).toArray();
    return rows.filter((row) => (!targetBid || row.branchId === targetBid) && (!location || row.location === location)).reduce((sum, row) => sum + Number(row.qty || 0) - Number(row.reservedQty || 0), 0);
  }

  const movements = await db.stock_movements.where('product_id').equals(targetPid).toArray();
  const filtered = movements.filter(m => {
    let match = String(m.product_id) === targetPid;
    if (targetBid && m.branch_id) {
      match = match && (String(m.branch_id) === targetBid);
    }
    if (location) {
      match = match && m.location === location;
    }
    return match;
  });
    
  return filtered.reduce((acc, mov) => acc + (mov.qty || 0), 0);
}

export async function getStoreStock(productId, branchId) {
  return getStockOnHand(productId, branchId, 'STORE');
}

/** The House always exists and is always what service draws from. */
export async function getHouseStock(productId, branchId) {
  return getStockOnHand(productId, branchId, 'HOUSE');
}

// Derive current on-hand stock for a specific batch in a branch
export async function getBatchStockOnHand(productId, batchId, branchId) {
  const movements = await db.stock_movements
    .where('product_id')
    .equals(productId)
    .filter(m => m.branch_id === branchId && m.batch_id === batchId)
    .toArray();
    
  return movements.reduce((acc, mov) => acc + mov.qty, 0);
}

/**
 * Sales that have not reached the server exist nowhere else. Wiping them to
 * re-seed loses real money, so every wipe path has to ask first.
 */
async function hasUnsyncedSales() {
  return (await db.sales
    .filter(s => s.synced_at === undefined || s.synced_at === null)
    .count()) > 0;
}

async function wipeAllTables(reason) {
  // A server acknowledgement is not permission to erase the local ledger or
  // tab identities. Seed migrations must never clear a till with real history.
  if (await db.sales.count() || await db.payments.count() || await db.tabs.count()) {
    console.error(`Refusing to wipe local data (${reason}): order history is present.`);
    return false;
  }
  if (await hasUnsyncedSales()) {
    console.error(`Refusing to wipe local data (${reason}): unsynced sales are still queued.`);
    return false;
  }
  await Promise.all(db.tables.map(table => table.clear()));
  return true;
}

// Seed the DB with mock data if empty
export async function seedDatabase() {
  // New businesses start empty. Never migrate or copy the legacy database.
  if (selectedCacheTenant() !== LEGACY_TENANT_ID) return;
  const dbVer = tenantStorage.getItem('db_seed_ver');
  // v5 clears the demo bar off tills that were seeded with it before the
  // catalogue moved to the server. wipeAllTables refuses while sales are still
  // queued and the marker only advances on a wipe that happened, so a till with
  // an undrained outbox keeps its data and tries again next boot.
  if (dbVer !== 'v5_server_catalogue') {
    console.warn('New DB version required. Wiping old data...');
    // Only advance the marker if the wipe actually happened, otherwise the
    // next boot would skip the migration entirely.
    if (await wipeAllTables('seed version change')) {
      tenantStorage.setItem('db_seed_ver', 'v5_server_catalogue');
    }
  }

  // A till with a backend takes its catalogue, staff and branches from the
  // server. Seeding the demo bar on top of that puts products on the menu that
  // no customer can order and that no sale can be booked against, because the
  // server prices every sale from its own catalogue and has never heard of
  // them. Only the walk-in customer is local, because the till needs somebody
  // to sell to before it has talked to anyone.
  const { firebaseConfigured } = await import('../services/firebase.js');
  if (firebaseConfigured) {
    const walkIn = SEED.customers.find((customer) => customer.id === 'cust-walkin');
    if (walkIn && !(await db.customers.get('cust-walkin'))) await db.customers.put(walkIn);
    return;
  }

  const tenantCount = await db.tenants.count();
  const userCount = await db.users.count();
  const prodCount = await db.products.count();
  const custCount = await db.customers.count();

  if (tenantCount > 0 && userCount > 0 && prodCount > 0 && custCount > 0) {
    console.log('Database fully seeded.');
    return;
  }

  // If partial state, clear all tables
  if (tenantCount > 0) {
    console.warn('Partial database state detected. Wiping and re-seeding...');
    if (!await wipeAllTables('partial seed state')) return;
  }

  console.log('Initializing IndexedDB for POS...');
  await Promise.all([
    db.tenants.clear(),
    db.branches.clear(),
    db.devices.clear(),
    db.users.clear(),
    db.categories.clear(),
    db.products.clear(),
    db.barcodes.clear(),
    db.batches.clear(),
    db.stock_movements.clear(),
    db.suppliers.clear(),
    db.customers.clear(),
    db.audit_log.clear()
  ]);

  
  // Seed tables from the shared opening dataset.
  const tenantId = SEED.TENANT_ID;
  await db.tenants.add(SEED.tenant);
  await db.branches.bulkAdd(SEED.branches);
  await db.devices.add(SEED.device);
  await db.users.bulkAdd(SEED.users);
  await db.categories.bulkAdd(SEED.categories);
  await db.products.bulkAdd(SEED.products);
  await db.barcodes.bulkAdd(SEED.barcodes);
  await db.stock_movements.bulkAdd(SEED.stockMovements);
  await db.suppliers.bulkAdd(SEED.suppliers);
  await db.customers.bulkAdd(SEED.customers);


  // Initial audit trail log
  await logAuditEvent(tenantId, 'user-manager', 'SEED_DB', 'SYSTEM', 'POS_DB', null, JSON.stringify({ seeded: true }));

  console.log('IndexedDB seed complete.');
}
