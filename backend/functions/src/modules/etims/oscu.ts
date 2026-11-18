/**
 * KRA eTIMS OSCU wire format (OSCU Specification v2.0).
 *
 * Pure functions only, so the arithmetic KRA checks to the cent is testable
 * without a network. Amounts follow the spec's own sample: VAT-inclusive, with
 * totAmt equal to the taxable amount and tax extracted from it (7000 at 18%
 * carries 1068). That is how this POS already prices and taxes a line.
 */

export type EtimsEnvironment = 'sandbox' | 'production';

export const OSCU_BASE_URL: Record<EtimsEnvironment, string> = {
  sandbox: 'https://etims-api-sbx.kra.go.ke/etims-api',
  production: 'https://etims-api.kra.go.ke/etims-api',
};

// Not in the OSCU spec: this is the page KRA's own receipts link to.
const VERIFY_URL: Record<EtimsEnvironment, string> = {
  sandbox: 'https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData',
  production: 'https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData',
};

/**
 * This POS's tax codes are not KRA's. Here A is 16%, B 8%, C exempt and
 * E zero-rated; KRA (spec 4.1) has A exempt, B 16%, C 0%, D non-VAT, E 8%.
 */
export const KRA_TAX_TYPE: Record<string, 'A' | 'B' | 'C' | 'D' | 'E'> = { A: 'B', B: 'E', C: 'A', E: 'C' };
const KRA_TAX_RATE = { A: 0, B: 16, C: 0, D: 0, E: 8 } as const;

/** Spec 4.11. Bank transfers have no code of their own. */
const PAYMENT_TYPE: Record<string, string> = {
  cash: '01', credit: '02', card: '05', mpesa: '06', airtel_money: '06', bank_transfer: '07',
};

export type EtrLine = {
  productName: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxCode: string;
  taxMinor: number;
  lineTotalMinor: number;
  itemCd: string;
  itemClsCd: string;
};

export type EtrPayment = { method?: unknown; amountMinor?: unknown; settledAt?: unknown };

const money = (minor: number) => minor / 100;

export function kraTaxType(taxCode: string): 'A' | 'B' | 'C' | 'D' | 'E' {
  const type = KRA_TAX_TYPE[String(taxCode).toUpperCase()];
  if (!type) throw new Error(`Tax code ${taxCode} has no KRA equivalent.`);
  return type;
}

/** KRA timestamps are Kenyan wall-clock time: yyyyMMddHHmmss. */
export function kraTime(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

/**
 * Spec 4.19: country, product type, packaging unit, quantity unit, sequence.
 * The quantity unit is "U" (pieces); KRA's own sample spells it "XU" in the
 * code, so it is padded the same way.
 */
export function itemCode(isService: boolean, sequence: number): string {
  return `KE${isService ? '3' : '2'}NTXU${String(sequence).padStart(7, '0')}`;
}

/** The tender that paid most of the bill. A receivable cleared later is its settlement, not credit. */
export function paymentType(payments: EtrPayment[]): string {
  const byMethod = new Map<string, number>();
  for (const payment of payments) {
    const method = String(payment.method);
    if (method === 'credit' && payment.settledAt) continue;
    byMethod.set(method, (byMethod.get(method) ?? 0) + (Number(payment.amountMinor) || 0));
  }
  const [top] = [...byMethod].sort((a, b) => b[1] - a[1]);
  return (top && PAYMENT_TYPE[top[0]]) || '07';
}

export function verifyUrl(environment: EtimsEnvironment, tin: string, bhfId: string, rcptSign: string): string {
  return `${VERIFY_URL[environment]}?Data=${encodeURIComponent(`${tin}${bhfId}${rcptSign}`)}`;
}

export type SalesBodyInput = {
  tin: string;
  bhfId: string;
  invcNo: number;
  trdInvcNo: string;
  buyerPin: string | null;
  soldAt: Date;
  confirmedAt: Date;
  staffId: string;
  lines: EtrLine[];
  payments: EtrPayment[];
};

/** The /saveTrnsSalesOsdc request body for one sale invoice. */
export function buildSalesBody(input: SalesBodyInput): Record<string, unknown> {
  const taxable = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const tax = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const itemList = input.lines.map((line, index) => {
    const type = kraTaxType(line.taxCode);
    const supplyMinor = line.unitPriceMinor * line.qty;
    taxable[type] += line.lineTotalMinor;
    tax[type] += line.taxMinor;
    return {
      itemSeq: index + 1,
      itemCd: line.itemCd,
      itemClsCd: line.itemClsCd,
      itemNm: line.productName.slice(0, 200),
      bcd: null,
      pkgUnitCd: 'NT',
      pkg: line.qty,
      qtyUnitCd: 'U',
      qty: line.qty,
      prc: money(line.unitPriceMinor),
      splyAmt: money(supplyMinor),
      dcRt: supplyMinor > 0 ? Math.round((line.discountMinor * 10_000) / supplyMinor) / 100 : 0,
      dcAmt: money(line.discountMinor),
      isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null,
      taxTyCd: type,
      taxblAmt: money(line.lineTotalMinor),
      taxAmt: money(line.taxMinor),
      totAmt: money(line.lineTotalMinor),
    };
  });
  const totalMinor = input.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const taxMinor = input.lines.reduce((sum, line) => sum + line.taxMinor, 0);
  const confirmed = kraTime(input.confirmedAt);
  const operator = input.staffId.slice(0, 20);
  return {
    tin: input.tin,
    bhfId: input.bhfId,
    trdInvcNo: input.trdInvcNo.slice(0, 50),
    invcNo: input.invcNo,
    orgInvcNo: 0,
    custTin: input.buyerPin,
    custNm: null,
    salesTyCd: 'N',
    rcptTyCd: 'S',
    pmtTyCd: paymentType(input.payments),
    salesSttsCd: '02',
    cfmDt: confirmed,
    salesDt: kraTime(input.soldAt).slice(0, 8),
    stockRlsDt: confirmed,
    cnclReqDt: null, cnclDt: null, rfdDt: null, rfdRsnCd: null,
    totItemCnt: itemList.length,
    taxblAmtA: money(taxable.A), taxblAmtB: money(taxable.B), taxblAmtC: money(taxable.C),
    taxblAmtD: money(taxable.D), taxblAmtE: money(taxable.E),
    taxRtA: KRA_TAX_RATE.A, taxRtB: KRA_TAX_RATE.B, taxRtC: KRA_TAX_RATE.C,
    taxRtD: KRA_TAX_RATE.D, taxRtE: KRA_TAX_RATE.E,
    taxAmtA: money(tax.A), taxAmtB: money(tax.B), taxAmtC: money(tax.C),
    taxAmtD: money(tax.D), taxAmtE: money(tax.E),
    totTaxblAmt: money(totalMinor),
    totTaxAmt: money(taxMinor),
    totAmt: money(totalMinor),
    prchrAcptcYn: 'N',
    remark: null,
    regrId: operator, regrNm: operator, modrId: operator, modrNm: operator,
    receipt: {
      custTin: input.buyerPin, custMblNo: null, rcptPbctDt: confirmed,
      trdeNm: null, adrs: null, topMsg: null, btmMsg: null, prchrAcptcYn: 'N',
    },
    itemList,
  };
}

/** The /saveItem request body. An item must be registered before it can be sold. */
export function buildItemBody(input: {
  tin: string; bhfId: string; itemCd: string; itemClsCd: string; isService: boolean;
  name: string; taxCode: string; priceMinor: number; staffId: string;
}): Record<string, unknown> {
  const operator = input.staffId.slice(0, 20);
  return {
    tin: input.tin, bhfId: input.bhfId, itemCd: input.itemCd, itemClsCd: input.itemClsCd,
    itemTyCd: input.isService ? '3' : '2', itemNm: input.name.slice(0, 200), itemStdNm: null,
    orgnNatCd: 'KE', pkgUnitCd: 'NT', qtyUnitCd: 'U', taxTyCd: kraTaxType(input.taxCode),
    btchNo: null, bcd: null, dftPrc: money(input.priceMinor),
    grpPrcL1: null, grpPrcL2: null, grpPrcL3: null, grpPrcL4: null, grpPrcL5: null,
    addInfo: null, sftyQty: null, isrcAplcbYn: 'N', useYn: 'Y',
    regrId: operator, regrNm: operator, modrId: operator, modrNm: operator,
  };
}

export type OscuReply ={ resultCd: string; resultMsg: string; data: Record<string, unknown> | null };

/** Thrown when KRA's answer never arrived, so the same body must be resent. */
export class OscuUnreachable extends Error {}

export async function oscuPost(
  environment: EtimsEnvironment,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<OscuReply> {
  let response: Response;
  try {
    response = await fetch(`${OSCU_BASE_URL[environment]}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OscuUnreachable(error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  let reply: Partial<OscuReply>;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new OscuUnreachable(`KRA answered HTTP ${response.status} without a result.`);
  }
  if (typeof reply.resultCd !== 'string') {
    throw new OscuUnreachable(`KRA answered HTTP ${response.status} without a result code.`);
  }
  return { resultCd: reply.resultCd, resultMsg: String(reply.resultMsg ?? ''), data: reply.data ?? null };
}
