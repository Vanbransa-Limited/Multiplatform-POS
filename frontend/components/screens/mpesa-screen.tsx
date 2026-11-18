"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { db } from "@/db/schema";
import { loadFinancialSnapshot } from "@/services/financial-data";
import { timestamp, paymentAttemptLabel } from "@/services/financial-snapshot";
import { quickFinancialPeriod, tradingRange } from "@/services/financial-period";
import { pullTradingHours, cachedTradingHours } from "@/services/trading-hours";
import { PAGE_SIZE, paginate } from "@/services/paginate";

/**
 * Payments viewer.
 *
 * Reads the same snapshot the financial report and the AI answer from, so the
 * three cannot disagree about what was received. That snapshot already limits a
 * member of staff to their own takings and gives an owner the whole
 * organization, and it marries every receipt to the invoice or order reference
 * it paid for - which is the only way a row here is actionable.
 */

type Row = {
  id: string;
  amount: number;
  method?: string;
  reference?: string;
  status?: string;
  received_at?: unknown;
  phone?: string;
  staff_id?: string;
  invoice_no?: string;
  order_reference?: string;
  customer_order_id?: string;
  customer_name?: string;
  verified?: boolean;
  linked?: boolean;
  /** Money received whose sale is still queued on the till that took it. */
  unsynced?: boolean;
  /** Recorded on this device only; no other screen in the business has it. */
  localOnly?: boolean;
  /** The sale is queued on a till that has published the order for watching. */
  held_on_till?: boolean;
  unapplied?: boolean;
  receiptConflict?: boolean;
};

const CELL = { padding: "12px 16px", fontSize: 13 } as const;
const HEAD_CELL = { padding: "12px 16px", fontSize: 11, color: "var(--text-secondary)" } as const;
const CONTROL = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid var(--border-color)",
  borderRadius: 6,
  padding: "8px 12px",
  color: "var(--text-primary)",
  fontFamily: "var(--font-main)",
  fontSize: 13,
} as const;
const PAGER_BUTTON = { ...CONTROL, padding: "6px 12px", fontSize: 12, cursor: "pointer" } as const;

const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;

function formatDate(value: unknown) {
  const millis = timestamp(value);
  if (!Number.isFinite(millis)) return "⚠ No date recorded";
  return new Date(millis).toLocaleString("en-US", {
    month: "numeric", day: "numeric", year: "numeric",
    hour: "numeric", minute: "numeric", hour12: true,
  });
}

/** What this money paid for, in the form somebody can act on. */
function paidFor(row: Row) {
  if (row.receiptConflict) return `${row.invoice_no || row.order_reference || 'Saved sale'} — receipt needs review`;
  if (row.unapplied) return `Received — not applied to ${row.invoice_no || row.order_reference || 'the order'}`;
  // A till's internal key is not an order number. When the sale behind a
  // payment has not reached the server, saying so is more use than printing
  // the key: it names the till holding it rather than looking like a stray.
  if (row.held_on_till && row.order_reference) return `${row.order_reference} · ⚠ still on the till`;
  if (row.unsynced && row.status === "SUCCESS") return "⚠ Sale still on the till — not synced";
  if (row.status === 'SUCCESS' && !row.linked) return 'Received — invoice not matched';
  const named = row.invoice_no || row.order_reference || row.customer_order_id
    || (row.status === "SUCCESS" ? "No matching sale / order" : "-");
  // The money is recorded here and nowhere else, so nobody but this till can
  // see it. Saying so is the difference between "taken" and "banked".
  return row.localOnly ? `${named} · ⚠ on this till only` : named;
}

export function MpesaScreen() {
  // This business's own trading hours, not the built-in fallback: the window
  // and the session filter have to be cut on the same clock.
  const [hours, setHours] = useState(() => cachedTradingHours());
  const today = useMemo(() => quickFinancialPeriod("today", new Date(), hours), [hours]);
  const [start, setStart] = useState(today.start);
  const [end, setEnd] = useState(today.end);
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [note, setNote] = useState("Loading payments...");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [session, setSession] = useState("full");
  const [page, setPage] = useState(1);

  const load = useCallback(async (from: string, to: string, session = "full") => {
    if (!from || !to || from > to) {
      setNote("Choose a valid start and end date.");
      return;
    }
    setNote("Loading payments...");
    // Trading days, so a night that crosses midnight stays on one report.
    const { from: fromMs, to: toMs } = tradingRange(from, to, session, hours);
    try {
      const report = await loadFinancialSnapshot(fromMs, toMs, session);
      // This screen is M-Pesa. Every other tender belongs in Financials & AI,
      // which has a Method column and is the one place meant to hold them all;
      // a bank transfer listed here reads as a bug rather than as coverage.
      setRows((report.transactions as Row[]).filter(
        (row) => String(row.method || "").replace(/[^A-Za-z]/g, "").toUpperCase().includes("MPESA"),
      ));
      const excluded = Number((report as { outsideCount?: number }).outsideCount) || 0;
      const total = Number((report as { outsideTotal?: number }).outsideTotal) || 0;
      const heldCount = Number((report as { heldCount?: number }).heldCount) || 0;
      const heldTotal = Number((report as { heldTotal?: number }).heldTotal) || 0;
      // A session narrows silently otherwise: a payment taken this afternoon
      // simply is not there, and the screen looks like a quiet day.
      setNote(report.dataSource
        + (session === "morning" ? ` Morning session only (${pad(hours.dayStartHour)}–${pad(hours.nightStartHour)}).`
          : session === "night" ? ` Night session only (${pad(hours.nightStartHour)}–${pad(hours.dayStartHour)}).`
            : " Full trading day.")
        + " M-Pesa only — every other tender is in Financials & AI."
        + (excluded
          ? ` ⚠ ${excluded} payment(s) worth KES ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })} fall outside this window.`
          : "")
        // The one line that explains why a manager's screen disagrees with this
        // one: money settled here that has not reached the business yet.
        + (heldCount
          ? ` ⚠ ${heldCount} settlement(s) worth KES ${heldTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })} are still on this till and have not reached the business — no manager can see them yet.`
          : ""));
    } catch {
      // Offline or signed out: show what this till itself recorded, narrowed to
      // the same period rather than silently showing everything.
      const local = await db.payments.toArray().catch(() => []);
      const mapped = (local as Row[])
        .filter((row) => {
          const at = timestamp((row as { received_at?: unknown; created_at?: unknown }).received_at
            ?? (row as { created_at?: unknown }).created_at);
          return at >= fromMs && at <= toMs;
        })
        .map((row) => ({ ...row, status: "SUCCESS" }));
      mapped.sort((a, b) => timestamp(b.received_at) - timestamp(a.received_at));
      setRows(mapped);
      setNote("Offline: payments recorded on this till only.");
    }
  }, [hours]);

  useEffect(() => {
    void pullTradingHours().then(setHours).catch(() => {});
  }, []);

  useEffect(() => {
    void load(today.start, today.end);
    void db.users.toArray()
      .then((users) => setNames(new Map((users as { id: string; name?: string }[]).map((u) => [u.id, u.name || u.id]))))
      .catch(() => {});
  }, [load, today.start, today.end]);

  const staffName = useCallback(
    (id?: string) => (id ? names.get(id) || id : "Unattributed"),
    [names],
  );

  // Totals count every payment in the period; only the table is filtered.
  const { successTotal, failedTotal, visible } = useMemo(() => {
    const needle = search.toLowerCase();
    let success = 0;
    let failed = 0;
    const kept: Row[] = [];

    for (const row of rows) {
      const status = row.status || "SUCCESS";
      if (status === "SUCCESS") success += row.amount;
      else if (status === "FAILED") failed += row.amount;

      if (filter !== "ALL" && status !== filter) continue;
      if (needle) {
        const haystack = [row.reference, row.phone, row.invoice_no, row.order_reference,
          row.customer_order_id, row.customer_name, staffName(row.staff_id)]
          .join(" ").toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      kept.push(row);
    }

    return { successTotal: success, failedTotal: failed, visible: kept };
  }, [rows, search, filter, staffName]);

  // paginate clamps, so a filter that shrinks the list cannot strand the user
  // on an empty page; this only resets the scroll position back to the start.
  useEffect(() => setPage(1), [search, filter, rows]);

  const view = paginate(visible, page, PAGE_SIZE);
  const money = (value: number) => `KES ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 20, marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ background: "var(--bg-element)", border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, minWidth: 200 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 8, letterSpacing: "0.5px" }}>TOTAL RECEIVED</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--accent-green)" }} id="mpesa-total-success">{money(successTotal)}</div>
        </div>
        <div style={{ background: "var(--bg-element)", border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, minWidth: 200 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 8, letterSpacing: "0.5px" }}>TOTAL CANCELLED/FAILED</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--accent-rose)" }} id="mpesa-total-failed">{money(failedTotal)}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label htmlFor="pay-start" style={{ fontSize: 13, color: "var(--text-secondary)" }}>From:</label>
        <input id="pay-start" type="date" value={start} onChange={(event) => setStart(event.target.value)} style={CONTROL} />
        <label htmlFor="pay-end" style={{ fontSize: 13, color: "var(--text-secondary)" }}>To:</label>
        <input id="pay-end" type="date" value={end} onChange={(event) => setEnd(event.target.value)} style={CONTROL} />
        <button type="button" onClick={() => void load(start, end, session)} style={{ ...CONTROL, background: "var(--accent)", color: "#000", fontWeight: 700, cursor: "pointer", border: "none" }}>
          Load
        </button>
        {(["today", "yesterday", "week", "month"] as const).map((period) => (
          <button
            key={period}
            type="button"
            onClick={() => {
              const range = quickFinancialPeriod(period, new Date(), hours);
              setStart(range.start);
              setEnd(range.end);
              void load(range.start, range.end, session);
            }}
            style={{ ...PAGER_BUTTON, textTransform: "capitalize" }}
          >
            {period === "week" ? "Past week" : period === "month" ? "Past month" : period}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border-color)" }} />
        {(["full", "morning", "night"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setSession(option);
              void load(start, end, option);
            }}
            style={{
              ...PAGER_BUTTON,
              textTransform: "capitalize",
              background: session === option ? "var(--accent)" : PAGER_BUTTON.background,
              color: session === option ? "#000" : PAGER_BUTTON.color,
              fontWeight: session === option ? 700 : 400,
            }}
          >
            {option === "full" ? "Full day" : option}
          </button>
        ))}
      </div>

      <div style={{ background: "var(--bg-element)", border: "1px solid var(--border-color)", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottom: "1px solid var(--border-color)", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#F59E0B" }}>📱</span> M-Pesa Payments
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}>🔍</span>
              <input
                type="text"
                id="mpesa-search"
                placeholder="Search order, invoice, reference, staff..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                style={{ ...CONTROL, padding: "8px 12px 8px 32px", width: 280 }}
              />
            </div>
            <select
              id="mpesa-status-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              style={CONTROL}
            >
              <option value="ALL">All Statuses</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILED">Failed</option>
              <option value="PENDING">Open prompts</option>
              <option value="UNCONFIRMED">Unconfirmed attempts</option>
              <option value="REVIEW">Receipt review</option>
            </select>
          </div>
        </div>

        <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)" }} role="status">
          {note}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="pos-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
            <thead>
              <tr>
                <th style={HEAD_CELL}>DATE/TIME</th>
                <th style={HEAD_CELL}>REFERENCE</th>
                <th style={HEAD_CELL}>ORDER / INVOICE</th>
                <th style={HEAD_CELL}>STAFF</th>
                <th style={HEAD_CELL}>METHOD</th>
                <th style={HEAD_CELL}>AMOUNT (KES)</th>
                <th style={HEAD_CELL}>STATUS</th>
              </tr>
            </thead>
            <tbody id="mpesa-table-body">
              {view.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
                    No payments in this period.
                  </td>
                </tr>
              ) : (
                view.rows.map((row) => {
                  const status = row.status || "SUCCESS";
                  const isSuccess = status === "SUCCESS";
                  const isPending = status === "PENDING" || status === 'UNCONFIRMED' || status === 'REVIEW';
                  return (
                    <tr key={row.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                      <td style={{ ...CELL, color: "var(--text-muted)" }}>{formatDate(row.received_at)}</td>
                      <td style={{ ...CELL, fontFamily: "monospace", fontWeight: 600 }}>
                        <span style={{ background: "rgba(255,255,255,0.05)", padding: "4px 8px", borderRadius: 4 }}>
                          {row.reference || row.id}
                        </span>
                        {row.verified === false && (
                          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>unverified</div>
                        )}
                      </td>
                      <td style={CELL}>
                        {paidFor(row)}
                        {row.customer_name && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{row.customer_name}</div>
                        )}
                      </td>
                      <td style={CELL}>{staffName(row.staff_id)}</td>
                      <td style={CELL}>{row.method || "-"}</td>
                      <td style={{ ...CELL, fontWeight: 700, color: "#F59E0B" }}>
                        {row.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span style={{ background: isSuccess ? "rgba(16, 185, 129, 0.1)" : isPending ? "rgba(245, 158, 11, 0.1)" : "rgba(244, 63, 94, 0.1)", color: isSuccess ? "var(--accent-green)" : isPending ? "var(--accent-amber)" : "var(--accent-rose)", padding: "4px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800 }}>
                          {paymentAttemptLabel(row)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {view.total > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderTop: "1px solid var(--border-color)", fontSize: 12, color: "var(--text-secondary)" }}>
            <span>{`Showing ${view.from}-${view.to} of ${view.total}`}</span>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                onClick={() => setPage(view.page - 1)}
                disabled={view.page <= 1}
                style={PAGER_BUTTON}
              >
                Prev
              </button>
              <span>{`Page ${view.page} of ${view.pages}`}</span>
              <button
                type="button"
                onClick={() => setPage(view.page + 1)}
                disabled={view.page >= view.pages}
                style={PAGER_BUTTON}
              >
                Next
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
