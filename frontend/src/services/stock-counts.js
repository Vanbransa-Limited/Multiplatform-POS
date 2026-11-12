/** Save the blind count and its expected balance in one IndexedDB transaction. */
export async function saveStockCount({ db, takeId, branchId, staffId, entries }) {
  const counted = entries.filter(entry => entry.value !== '');
  if (!counted.length) throw new Error('Enter at least one count, including zero for an empty item.');
  if (counted.some(entry => !Number.isSafeInteger(Number(entry.value)) || Number(entry.value) < 0 || Number(entry.value) > 100000000)) {
    throw new Error('Counts must be whole numbers between 0 and 100,000,000.');
  }
  return db.transaction('rw', [db.stock_takes, db.stock_take_lines, db.stock_balances], async () => {
    const take = await db.stock_takes.get(takeId);
    if (!take || take.status !== 'DRAFT' || take.branch_id !== branchId) throw new Error('This count is closed or belongs to another branch.');
    const saved = [];
    for (const entry of counted) {
      const balances = await db.stock_balances.where('productId').equals(entry.productId).toArray();
      const expected = balances.filter(balance => balance.branchId === branchId && balance.location === (take.location || 'HOUSE'))
        .reduce((sum, balance) => sum + Number(balance.qty || 0), 0);
      const qty = Number(entry.value);
      const line = { id: `${takeId}_${entry.productId}`, stock_take_id: takeId, product_id: entry.productId,
        counted_qty: qty, expected_qty: expected, variance_qty: qty - expected, variance_value: 0, counted_by: staffId };
      await db.stock_take_lines.where('stock_take_id').equals(takeId).filter(row => row.product_id === entry.productId).delete();
      await db.stock_take_lines.put(line);
      saved.push(line);
    }
    await db.stock_takes.update(takeId, { saved_at: new Date().toISOString() });
    return saved;
  });
}
