# Late M-Pesa confirmation recovery

A saved bill paid by STK prompt is settled by the till, not by the M-Pesa
callback: the callback marks the attempt `paid` and creates its verified
intent, and the till then calls `settleSale` with that attempt as proof. A
customer who entered the PIN after the till stopped waiting (90 seconds plus one
Safaricom query) used to leave a confirmed payment on a bill that still showed
unpaid.

## How it works

- Orders (`settleByStk`) and Till (`runMpesaAttempt`) remember each saved-bill
  prompt in `localStorage` under `pos_stk_recovery_v2:[tenantId, staffId]`, *before*
  the prompt is sent. Both ids come from the signed-in user built from the ID
  token's claims; with no signed-in user nothing is remembered. Records under the
  unreleased `pos_stk_recovery:` key, which used a build-wide tenant id, are never
  read. The attempt id is computed with the same formula the server uses
  (`deterministicId('mpesa-attempt', tenantId:idempotencyKey)`) and replaced by the
  id the server returns — whenever it returns one that is not a definitive
  failure, including an `ambiguous` reply.
- The Orders board checks due records when it opens and on its 60-second refresh:
  one read of `mpesa_payments/{attemptId}` per record, first 3 minutes after the
  prompt, then every minute until it is 10 minutes old and every 5 minutes after
  that. Nothing is read when nothing is remembered.
  **Check with M-Pesa** asks Safaricom (`queryMpesaStatus`) for one payment.
- A `paid` attempt is settled through the existing `settleSale` attempt path with
  request id `${attemptId}-${saleUuid}`. The original checkout, a recovery and a
  retry on any device therefore address the same settlement document; the server
  replays it instead of recording a second payment.
- `failed`, `cancelled` and `expired` prompts are forgotten (nothing was taken).
  `pending` and `verification_pending` keep waiting. `ambiguous`, a receipt
  conflict, or anything unresolved after 24 hours stays on the board as
  **Needs review** until staff check or dismiss it. A settlement the server
  refuses stays listed with its message and is retried; the bill is never marked
  paid locally without a server settlement.

The server's existing guards are unchanged: the attempt must be `paid` (callback
and STK Query), its verified intent must match, the bill must be one the prompt
was raised for, a bill cannot be settled twice by one attempt, and the total
cannot exceed what was paid.

## Crash windows

| Moment the till stops | Result |
| --- | --- |
| Before the record is written | No prompt was sent; nothing to recover. |
| After the record, before the prompt reaches the server | The attempt never exists. The record is dropped after 3 minutes. |
| After the server sends the prompt, before the till reads the response | Recovered: the record already holds the server's attempt id. |
| After confirmation, during settlement of one or more bills | Recovered: the record is cleared only after every bill settles, and replays return the original payment. |
| After `settleSale` succeeded, before the till mirrored it | Recovered: the replay returns the same payment id and the local mirror is idempotent. |

Not covered — fall back to typing the M-Pesa code, which the server already accepts
against the paid attempt:

- Site data cleared, a private window, or `localStorage` unavailable.
- A different device or a different signed-in cashier. Records are per cashier,
  and Firestore rules let only that cashier or an owner/manager read the attempt.
- `crypto.subtle` unavailable (non-HTTPS origin) or the signed-in tenant claim
  unreadable: the record is written only once the server returns the attempt id,
  so a till that stops while the prompt is in flight is not recovered.

The precomputed id hashes the signed-in claim's tenant (`activeTenantId`), the
same value the server hashes, not the till's cached tenant record.
