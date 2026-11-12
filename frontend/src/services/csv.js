/**
 * CSV parsing for the catalogue import.
 *
 * Tolerant on purpose: the file comes from whatever the restaurant already
 * keeps its menu in, so columns are matched by a list of aliases rather than
 * one exact spelling, and the caller shows the operator which column it picked
 * before anything is written.
 */

/** Column aliases, lowercased and stripped of anything but letters. */
const FIELD_ALIASES = {
  sku: ['sku', 'code', 'itemcode', 'productcode', 'barcode', 'ref', 'itemno'],
  name: ['name', 'itemname', 'productname', 'product', 'item', 'description', 'menuitem'],
  sellPrice: ['sellprice', 'price', 'unitprice', 'selling', 'sellingprice', 'rate', 'amount', 'menuprice'],
  costPrice: ['costprice', 'cost', 'buyingprice', 'buy', 'purchaseprice'],
  categoryId: ['category', 'categoryid', 'group', 'section', 'menugroup', 'type'],
  uom: ['uom', 'unit', 'units', 'measure', 'unitofmeasure'],
  taxCode: ['taxcode', 'tax', 'vat', 'vatcode', 'taxclass']
};

/**
 * Staff columns. Same tolerance as the product import: the roster arrives as
 * whatever the manager already keeps names in, and "Access Level" is as likely
 * a heading as "Role".
 */
export const STAFF_ALIASES = {
  name: ['name', 'fullname', 'staffname', 'username', 'employee', 'employeename', 'person'],
  email: ['email', 'emailaddress', 'login', 'username', 'mail', 'signin'],
  role: ['role', 'accesslevel', 'level', 'access', 'position', 'job', 'jobtitle'],
  password: ['password', 'pass', 'pin', 'temporarypassword', 'initialpassword'],
  phone: ['phone', 'mobile', 'phonenumber', 'tel', 'msisdn', 'contact']
};

/**
 * Stock columns. A delivery note or a stock take is two columns in practice -
 * what the item is and how many - so the sheet is matched on that and nothing
 * else is required of whoever typed it.
 */
export const STOCK_ALIASES = {
  sku: ['sku', 'code', 'itemcode', 'productcode', 'barcode', 'ref', 'itemno'],
  name: ['name', 'itemname', 'productname', 'product', 'item', 'description'],
  qty: ['qty', 'quantity', 'count', 'counted', 'received', 'delivered', 'stock', 'onhand', 'units', 'pieces']
};

const normalise = (header) => String(header || '').toLowerCase().replace(/[^a-z]/g, '');

/** Each returns the complaint to show, or null when the file is readable. */
const productMapping = (mapping) =>
  (mapping.name || mapping.sku ? null : 'No product name or SKU column found.');
const stockMapping = (mapping) => {
  if (!mapping.sku && !mapping.name) return 'No SKU or item name column found.';
  if (!mapping.qty) return 'No quantity column found.';
  return null;
};
const staffMapping = (mapping) => {
  if (!mapping.name) return 'No name column found.';
  if (!mapping.email) return 'No email column found - it is what each person signs in with.';
  if (!mapping.password) return 'No password column found.';
  return null;
};

/**
 * Turns a header row plus data rows into the shape an import callable accepts.
 * Shared by the CSV and workbook readers so both go through one mapper.
 */
export function rowsFromGrid(headers, grid, aliases = FIELD_ALIASES, usable = productMapping) {
  const mapping = matchColumns(headers, aliases, grid);
  const missing = usable(mapping);
  if (missing) {
    return {
      rows: [],
      mapping,
      headers,
      error: `${missing} Headers read: ${headers.join(', ')}`
    };
  }

  const indexOf = {};
  for (const [field, header] of Object.entries(mapping)) {
    indexOf[field] = headers.indexOf(header);
  }

  const rows = grid.map((cells) => {
    const row = {};
    for (const [field, index] of Object.entries(indexOf)) {
      row[field] = cells[index] ?? '';
    }
    return row;
  });

  return { rows, mapping, headers, error: null };
}

/**
 * Splits one CSV line, honouring quoted fields and doubled quotes inside them.
 * A plain split(',') breaks on "Nyama Choma, 1/2 kg", which is exactly the kind
 * of name a menu contains.
 */
export function splitCsvLine(line, preserveWhitespace = false) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(preserveWhitespace === true ? cell : cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }

  cells.push(preserveWhitespace === true ? cell : cell.trim());
  return cells;
}

/**
 * Maps the file's headers onto our fields. Returns { field: headerName }.
 *
 * Candidates are ranked, not taken in the order the file happens to list them.
 * An export carrying both "description" and "name" put description first, and
 * taking the leftmost match bound every product's name to a column that was
 * blank in all 1,598 rows - so the whole sheet imported as nameless and was
 * rejected. A column with values beats an empty one, and past that the closer
 * alias wins: "name" is a better name column than "description" wherever the
 * two sit.
 */
export function matchColumns(headers, aliasMap = FIELD_ALIASES, grid = null) {
  const mapping = {};
  const used = new Set();

  const isEmpty = (position) => Array.isArray(grid)
    && grid.length > 0
    && grid.every((cells) => String(cells?.[position] ?? '').trim() === '');

  for (const [field, aliases] of Object.entries(aliasMap)) {
    let best = -1;
    let bestScore = null;

    headers.forEach((header, position) => {
      if (used.has(position)) return;
      const rank = aliases.indexOf(normalise(header));
      if (rank === -1) return;

      // Lexicographic: carries data, then how strong the alias is, then order.
      const score = [isEmpty(position) ? 1 : 0, rank, position];
      if (compare(score, bestScore) < 0) {
        bestScore = score;
        best = position;
      }
    });

    if (best !== -1) {
      mapping[field] = headers[best];
      used.add(best);
    }
  }

  return mapping;
}

/** Lexicographic compare of two equal-length numeric tuples. */
function compare(a, b) {
  if (b === null) return -1;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Parses a CSV into rows the importProducts callable accepts.
 *
 * Returns the column mapping alongside the rows so the operator can confirm
 * that "Rate" really was read as the selling price before committing.
 */
export function parseProductCsv(content) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

  if (lines.length < 2) {
    return { rows: [], mapping: {}, headers: [], error: 'The file needs a header row and at least one product.' };
  }

  return rowsFromGrid(splitCsvLine(lines[0]), lines.slice(1).map(splitCsvLine));
}

const skuKey = (value) => String(value ?? '').trim().toUpperCase();

/**
 * Gives every row a SKU that is unique across the whole file.
 *
 * Products are stored under a key derived from their SKU, so any column that
 * repeats - a category, a supplier, a blank cell - silently collapses hundreds
 * of different products onto one record. That looks like a successful import
 * of a few dozen items.
 *
 * A repeated code carrying a different product name is treated as a code that
 * simply is not unique, and the row is kept under a suffixed one. A repeated
 * code carrying the same name is a genuine duplicate line and is dropped.
 */
export function ensureUniqueSkus(rows) {
  const seen = new Map();
  let generated = 0;
  let duplicates = 0;
  const result = [];

  for (const row of rows) {
    const name = String(row.name ?? '').trim();
    const base = skuKey(row.sku) || skuKey(name);

    // No code and no name: leave it for the server to reject and report.
    if (!base) {
      result.push(row);
      continue;
    }

    const signature = name.toLowerCase();
    if (!seen.has(base)) {
      seen.set(base, signature);
      result.push({ ...row, sku: String(row.sku ?? '').trim() || name });
      continue;
    }

    if (seen.get(base) === signature) {
      duplicates += 1;
      continue;
    }

    let suffix = 2;
    while (seen.has(`${base}-${suffix}`)) suffix += 1;
    const unique = `${base}-${suffix}`;
    seen.set(unique, signature);
    generated += 1;
    result.push({ ...row, sku: unique });
  }

  return { rows: result, generated, duplicates };
}

/**
 * Reads an import file, CSV or xlsx, into the same shape.
 *
 * The workbook reader is imported only when a workbook is actually chosen, so
 * a till that never imports one never downloads it.
 */
export async function parseImportFile(file, aliases = FIELD_ALIASES, usable = productMapping) {
  const isWorkbook = /\.xlsx$/i.test(file.name)
    || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  if (!isWorkbook) {
    const lines = String(await file.text() || '')
      .split(/\r?\n/)
      .filter((line) => aliases === STAFF_ALIASES || line.trim() !== '');
    if (lines.length < 2) {
      return { rows: [], mapping: {}, headers: [], error: 'The file needs a header row and at least one row under it.' };
    }
    return rowsFromGrid(splitCsvLine(lines[0]), lines.slice(1).map((line) => splitCsvLine(line, aliases === STAFF_ALIASES)), aliases, usable);
  }

  try {
    const { readWorkbook } = await import('./xlsx.js');
    const { headers, rows } = await readWorkbook(await file.arrayBuffer());
    if (headers.length === 0) {
      return { rows: [], mapping: {}, headers: [], error: 'That workbook is empty.' };
    }
    return rowsFromGrid(headers, rows, aliases, usable);
  } catch (err) {
    return { rows: [], mapping: {}, headers: [], error: err.message || 'Could not read that workbook.' };
  }
}

/**
 * Templates. Each is a header row this parser recognises plus worked examples,
 * so the sheet explains its own columns and nobody has to guess a spelling.
 */

/** Full catalogue: names, prices, categories. Menu Admin. */
export const PRODUCT_TEMPLATE_CSV = [
  'SKU,Name,Category,UOM,Sell Price,Cost Price,Tax Code',
  'BEER-TUSK-500,Tusker Lager 500ml,Beers & Ciders,BOTTLE,300,220,A',
  'FOOD-CHAP-01,Chapati,Food & Meals,PIECE,30,18,A'
].join('\r\n');

/** Names only, for getting a menu on the till before prices are decided. */
export const PRODUCT_NAMES_TEMPLATE_CSV = [
  'SKU,Name,Category',
  'BEER-TUSK-500,Tusker Lager 500ml,Beers & Ciders',
  'FOOD-CHAP-01,Chapati,Food & Meals'
].join('\r\n');

/** A delivery or a count: what the item is and how many. SKU is optional. */
export const STOCK_TEMPLATE_CSV = [
  'SKU,Name,Quantity',
  'BEER-TUSK-500,Tusker Lager 500ml,48',
  ',Chapati,120'
].join('\r\n');

/** Hands the operator a file to fill in. */
export function downloadCsvTemplate(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const parseProductFile = (file) => parseImportFile(file);
export const parseStaffFile = (file) => parseImportFile(file, STAFF_ALIASES, staffMapping);
export const parseStockFile = (file) => parseImportFile(file, STOCK_ALIASES, stockMapping);
