import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { SELLING_ROLES } from "./constants";
import { parseSaleInput } from "./input";
import { executeCreateSale } from "./transaction";
import { withTableRefresh } from "./tab-identity";

export const createSale = onCall(
  { region: FUNCTION_REGION },
  withTableRefresh(async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in before creating a sale.");
    }

    let input;
    try {
      input = parseSaleInput(request.data);
    } catch (error) {
      logger.warn("createSale input refused", {
        reason: error instanceof Error ? error.message : String(error),
        tenantId: request.auth.token.tenant_id,
      });
      throw error;
    }
    if (request.auth.token.tenant_id !== input.tenantId) {
      throw new HttpsError(
        "permission-denied",
        "The authenticated account does not belong to this tenant.",
      );
    }
    // A shared till drains its outbox under whoever is signed in now, which is
    // often not the waiter who rang the order. Any selling colleague may relay
    // it; the sale stays attributed to its seller, whose active record and open
    // shift on this device are still enforced by loadBaseSaleContext.
    if (
      request.auth.token.staff_id !== input.staffId
      && !SELLING_ROLES.has(String(request.auth.token.staff_role))
    ) {
      throw new HttpsError(
        "permission-denied",
        "The authenticated staff claim does not match this sale.",
      );
    }
    if (request.auth.token.staff_id !== input.staffId) {
      logger.info("createSale relayed", {
        tenantId: input.tenantId,
        sellerStaffId: input.staffId,
        relayedByStaffId: request.auth.token.staff_id,
        idempotencyKey: input.idempotencyKey,
      });
    }

    try {
      return await executeCreateSale(input);
    } catch (error) {
      if (error instanceof HttpsError) {
        // A refusal strands the sale on the till, so the reason has to be
        // readable from the server too, not only on that device.
        logger.warn("createSale refused", {
          code: error.code,
          reason: error.message,
          tenantId: input.tenantId,
          branchId: input.branchId,
          idempotencyKey: input.idempotencyKey,
        });
        throw error;
      }
      logger.error("createSale transaction failed", {
        error,
        tenantId: input.tenantId,
        branchId: input.branchId,
        uid: request.auth.uid,
      });
      throw new HttpsError("internal", "The sale could not be created.");
    }
  }),
);
