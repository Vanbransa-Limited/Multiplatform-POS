import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
} from "firebase-admin/firestore";

export type InputLine = {
  productId: string;
  qty: number;
  discountMinor: number;
};

export type InputPayment = {
  method: string;
  amountMinor: number;
  reference: string | null;
  unverified?: boolean;
};

export type ParsedSaleInput = {
  tenantId: string;
  branchId: string;
  deviceId: string;
  shiftId: string;
  staffId: string;
  customerId: string;
  idempotencyKey: string;
  tableNumber: string | null;
  tabId?: string;
  orderReference?: string;
  buyerKraPin: string | null;
  /** A manager's single-use approval for the fixed staff discount. */
  discountApprovalId?: string;
  lines: InputLine[];
  payments: InputPayment[];
};

export type PreparedLine = {
  productId: string;
  sku: string;
  productName: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxCode: string;
  taxMinor: number;
  lineTotalMinor: number;
  isService: boolean;
};

export type SaleTotals = {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
};

export type SaleReferences = {
  shift: DocumentReference;
  counter: DocumentReference;
};

export type BaseSaleContext = {
  tenant: DocumentData;
  branch: DocumentData;
  shift: DocumentData;
  staff: DocumentData;
  settings: DocumentData;
  counterValue: number;
  productDocuments: DocumentSnapshot<DocumentData>[];
  refs: SaleReferences;
};

export type UpdatedStockBalance = {
  id: string;
  tenantId: string;
  branchId: string;
  productId: string;
  location: "HOUSE" | "STORE";
  qty: number;
  updatedAt: FirebaseFirestore.Timestamp;
};

export type SaleDependencies = {
  receiptConflicts?: string[];
  receiptClaims?: { ref: DocumentReference; data: DocumentData }[];
  physicalLines: PreparedLine[];
  digitalPayments: InputPayment[];
  balanceRefs: DocumentReference[];
  paymentIntentRefs: DocumentReference[];
  paymentIntentDocuments: DocumentSnapshot<DocumentData>[];
  updatedBalances: UpdatedStockBalance[];
};

export type SaleRecords = {
  sale: DocumentData;
  lines: DocumentData[];
  payments: DocumentData[];
};
