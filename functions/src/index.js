import { randomUUID } from "node:crypto";

import { getApps, initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { defineBoolean, defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";

import { createAdminHandler } from "./admin.js";
import { redeemClaim, validateClaim } from "./core.js";
import { isServiceError, ServiceError } from "./errors.js";
import { createFirestoreRepository } from "./repository.js";
import {
  createRateLimiter,
  requestSubject,
  requireAppCheck,
  requirePromoAdmin,
} from "./security.js";

if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore();
const auth = getAuth();
const appCheck = getAppCheck();
const repository = createFirestoreRepository(db);

const rateLimitPepper = defineSecret("PROMO_RATE_LIMIT_PEPPER");
const allowedOrigins = defineString("PROMO_ALLOWED_ORIGINS", {
  default:
    "https://canaryyellowapplications.com,https://www.canaryyellowapplications.com,http://localhost:5000,http://127.0.0.1:5000",
});
const adminEmails = defineString("PROMO_ADMIN_EMAILS", {
  default: "",
});
const enforceAppCheck = defineBoolean("PROMO_REQUIRE_APP_CHECK", {
  default: false,
});

function originAllowlist() {
  return new Set(
    allowedOrigins
      .value()
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function adminEmailAllowlist() {
  return new Set(
    adminEmails
      .value()
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function setResponseHeaders(request, response) {
  response.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  response.set("Pragma", "no-cache");
  response.set("Expires", "0");
  response.set("X-Content-Type-Options", "nosniff");
  response.set("X-Frame-Options", "DENY");
  response.set("Referrer-Policy", "no-referrer");
  response.set("Vary", "Origin");

  const origin = request.get("origin");
  if (origin && originAllowlist().has(origin)) {
    response.set("Access-Control-Allow-Origin", origin);
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Firebase-AppCheck",
    );
    response.set("Access-Control-Max-Age", "3600");
  }
}

function assertAllowedOrigin(request) {
  const origin = request.get("origin");
  if (origin && !originAllowlist().has(origin)) {
    throw new ServiceError("origin_not_allowed", 403);
  }
}

function pathFor(request) {
  const path = (request.path || request.url || "/").split("?")[0];
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function publicErrorMessage(code) {
  const messages = {
    invalid_token: "We could not find that claim token. Check the code and try again.",
    already_redeemed:
      "This claim token has already been redeemed. For security, its assigned promo code cannot be displayed again.",
    no_inventory:
      "This claim token is valid, but no promo codes are currently available for the selected platform. Please try again later.",
    not_redeemable: "This claim token is not currently redeemable.",
    unsupported_platform: "That platform is not available for this claim token.",
    rate_limited: "Too many attempts. Please wait a while and try again.",
    unauthorized: "Sign in is required.",
    forbidden: "This account is not authorized to manage promo codes.",
    app_check_required: "The request could not be verified. Refresh the page and try again.",
    app_check_failed: "The request could not be verified. Refresh the page and try again.",
    confirmation_required: "Please preview and confirm the import before continuing.",
    acknowledgement_required: "Acknowledge the one-time display warning before continuing.",
    import_changed: "The inventory changed. Preview the import again before continuing.",
    no_valid_rows: "There are no valid rows to import.",
    empty_import: "Enter or choose at least one row to import.",
    import_too_large: "This import is too large. Split it into smaller files and try again.",
    too_many_import_rows: "Imports are limited to 400 rows at a time.",
    invalid_csv: "The CSV file could not be parsed. Check its columns and quoting.",
    missing_token_column: "Claim-token CSV files must contain a token column.",
    missing_code_column: "Store-code CSV files must contain a code column.",
    invalid_import_format: "Choose plain text, CSV, or automatic format detection.",
    invalid_product_name: "Enter a product name of 80 characters or fewer.",
    invalid_promotion_name: "Enter a promotion name of 80 characters or fewer.",
    invalid_product_prefix: "Enter a valid product prefix.",
    invalid_promotion_prefix: "Enter a valid promotion prefix.",
    platform_required: "Choose at least one supported platform.",
    request_too_large: "The request is too large.",
    prefix_locked: "Prefixes cannot be changed after creation.",
    redeemed_token_locked: "Redeemed claim tokens cannot be reset.",
    store_code_locked: "Assigned or expired store codes cannot be changed.",
    store_code_expired: "An expired store code cannot be re-enabled.",
    not_found: "The requested item could not be found.",
  };
  return messages[code] ?? "The request could not be completed.";
}

function sendJson(response, status, payload) {
  response.status(status).json(payload);
}

export const promoApi = onRequest(
  {
    region: "us-west1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 10,
    concurrency: 40,
    cors: false,
    secrets: [rateLimitPepper],
  },
  async (request, response) => {
    const requestId = randomUUID();
    setResponseHeaders(request, response);

    if (request.method === "OPTIONS") {
      try {
        assertAllowedOrigin(request);
        response.status(204).send("");
      } catch {
        response.status(403).send("");
      }
      return;
    }

    try {
      assertAllowedOrigin(request);
      if ((request.rawBody?.length ?? 0) > 600_000) {
        throw new ServiceError("request_too_large", 413);
      }
      const pepper = rateLimitPepper.value() || "local-emulator-only";
      const consumeRateLimit = createRateLimiter(db, pepper);
      const path = pathFor(request);

      if (path.startsWith("/admin/")) {
        const admin = await requirePromoAdmin(request, auth, adminEmailAllowlist());
        if (enforceAppCheck.value()) {
          await requireAppCheck(request, appCheck);
        }
        const result = await createAdminHandler({ db, consumeRateLimit })(
          request,
          admin,
          path,
        );
        sendJson(response, 200, { data: result });
        return;
      }

      if (request.method !== "POST") {
        throw new ServiceError("not_found", 404);
      }

      if (path === "/validate") {
        if (enforceAppCheck.value()) {
          await requireAppCheck(request, appCheck);
        }
        await consumeRateLimit(
          "claim_validation",
          requestSubject(request),
          15,
          5 * 60 * 1000,
        );
        const result = await validateClaim(repository, request.body?.token);
        sendJson(response, 200, { data: result });
        return;
      }

      if (path === "/redeem") {
        if (enforceAppCheck.value()) {
          await requireAppCheck(request, appCheck, { consume: true });
        }
        await consumeRateLimit(
          "claim_redemption",
          requestSubject(request),
          6,
          15 * 60 * 1000,
        );
        if (request.body?.acknowledged !== true) {
          throw new ServiceError("acknowledgement_required", 400);
        }
        const result = await redeemClaim(
          repository,
          request.body?.token,
          request.body?.platform,
        );
        sendJson(response, 200, { data: result });
        return;
      }

      throw new ServiceError("not_found", 404);
    } catch (error) {
      if (isServiceError(error)) {
        if (error.code !== "invalid_token") {
          logger.warn("Promo API request rejected", {
            requestId,
            category: error.code,
            path: pathFor(request),
          });
        }
        sendJson(response, error.status, {
          error: {
            code: error.code,
            message: publicErrorMessage(error.code),
          },
        });
        return;
      }

      logger.error("Promo API request failed", {
        requestId,
        errorName: error?.name ?? "Error",
        path: pathFor(request),
      });
      sendJson(response, 500, {
        error: {
          code: "service_unavailable",
          message: "The redemption service is temporarily unavailable. Please try again later.",
        },
      });
    }
  },
);
