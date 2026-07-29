import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { parseClaimToken } from "./core.js";
import { ServiceError } from "./errors.js";

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PUBLISH_TOKENS = 400;

function base64urlSha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function assertOpaqueValue(value, field, minimum = 24, maximum = 128) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    throw new ServiceError(`invalid_${field}`, 400);
  }
  return normalized;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export async function authorizeDesktop(db, admin, body) {
  const state = assertOpaqueValue(body?.state, "desktop_state");
  const codeChallenge = assertOpaqueValue(
    body?.codeChallenge,
    "desktop_challenge",
    43,
    43,
  );
  const callbackPort = Number(body?.callbackPort);
  if (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) {
    throw new ServiceError("invalid_callback_port", 400);
  }

  const code = randomBytes(32).toString("base64url");
  const codeId = base64urlSha256(code);
  await db.collection("desktopAuthCodes").doc(codeId).create({
    adminUid: admin.uid,
    adminEmail: admin.email ?? null,
    state,
    codeChallenge,
    callbackPort,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + AUTH_CODE_TTL_MS),
    usedAt: null,
  });
  return { code, state, callbackPort, expiresIn: AUTH_CODE_TTL_MS / 1000 };
}

export async function exchangeDesktopCode(db, auth, body) {
  const code = assertOpaqueValue(body?.code, "desktop_code", 43, 43);
  const verifier = assertOpaqueValue(body?.verifier, "desktop_verifier", 43, 128);
  const reference = db.collection("desktopAuthCodes").doc(base64urlSha256(code));

  const authorized = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      throw new ServiceError("desktop_code_invalid", 401);
    }
    const data = snapshot.data();
    if (data.usedAt || data.expiresAt?.toMillis?.() <= Date.now()) {
      throw new ServiceError("desktop_code_expired", 401);
    }
    const actualChallenge = base64urlSha256(verifier);
    if (!safeEqual(actualChallenge, data.codeChallenge)) {
      throw new ServiceError("desktop_code_invalid", 401);
    }
    transaction.update(reference, { usedAt: FieldValue.serverTimestamp() });
    transaction.create(db.collection("auditEvents").doc(), {
      type: "desktop_authorization_exchanged",
      adminUid: data.adminUid,
      adminEmail: data.adminEmail ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { uid: data.adminUid };
  });

  const customToken = await auth.createCustomToken(authorized.uid, {
    promoDesktop: true,
  });
  return { customToken };
}

function parsePublisherTokens(body) {
  if (!Array.isArray(body?.tokens) || body.tokens.length === 0) {
    throw new ServiceError("empty_import", 400);
  }
  if (body.tokens.length > MAX_PUBLISH_TOKENS) {
    throw new ServiceError("too_many_import_rows", 400);
  }
  const seen = new Set();
  return body.tokens.map((record) => {
    const parsed = parseClaimToken(record?.token);
    if (seen.has(parsed.token)) {
      throw new ServiceError("duplicate_in_import", 409);
    }
    seen.add(parsed.token);
    if (
      (record?.productPrefix && record.productPrefix !== parsed.productPrefix) ||
      (record?.promotionPrefix && record.promotionPrefix !== parsed.promotionPrefix)
    ) {
      throw new ServiceError("token_metadata_mismatch", 409);
    }
    return {
      token: parsed.token,
      productPrefix: parsed.productPrefix,
      promotionPrefix: parsed.promotionPrefix,
      generatedAt:
        typeof record?.createdAt === "string" && record.createdAt.length <= 64
          ? record.createdAt
          : null,
    };
  });
}

export async function publishClaimTokenBatch(db, admin, body) {
  const mutationId = assertOpaqueValue(body?.mutationId, "mutation_id", 16, 80);
  const batchId = assertOpaqueValue(body?.batchId, "batch_id", 1, 100);
  const tokens = parsePublisherTokens(body);

  const productPrefixes = [...new Set(tokens.map((item) => item.productPrefix))];
  const promotionPrefixes = [...new Set(tokens.map((item) => item.promotionPrefix))];
  const configurationReferences = [
    ...productPrefixes.map((prefix) => db.collection("products").doc(prefix)),
    ...promotionPrefixes.map((prefix) => db.collection("promotions").doc(prefix)),
  ];
  const configuration = await db.getAll(...configurationReferences);
  if (configuration.some((snapshot) => !snapshot.exists)) {
    throw new ServiceError("unknown_catalog_prefix", 409);
  }

  const mutationReference = db.collection("publisherMutations").doc(mutationId);
  return db.runTransaction(async (transaction) => {
    const mutationSnapshot = await transaction.get(mutationReference);
    if (mutationSnapshot.exists) {
      const existing = mutationSnapshot.data();
      if (existing.adminUid !== admin.uid) {
        throw new ServiceError("mutation_conflict", 409);
      }
      return existing.result;
    }

    const references = tokens.map((item) =>
      db.collection("claimTokens").doc(item.token),
    );
    const snapshots = await transaction.getAll(...references);
    let published = 0;
    let alreadyPresent = 0;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const snapshot = snapshots[index];
      if (snapshot.exists) {
        const existing = snapshot.data();
        if (
          existing.productPrefix !== token.productPrefix ||
          existing.promotionPrefix !== token.promotionPrefix
        ) {
          throw new ServiceError("token_conflict", 409);
        }
        alreadyPresent += 1;
        continue;
      }
      transaction.create(references[index], {
        token: token.token,
        productPrefix: token.productPrefix,
        promotionPrefix: token.promotionPrefix,
        status: "available",
        redeemedAt: null,
        selectedPlatform: null,
        assignedStoreCodeId: null,
        disabledReason: null,
        source: "claim-token-manager",
        sourceBatchId: batchId,
        generatedAt: token.generatedAt,
        importedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      published += 1;
    }

    const result = { published, alreadyPresent, total: tokens.length, batchId };
    transaction.create(mutationReference, {
      mutationId,
      batchId,
      adminUid: admin.uid,
      result,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.create(db.collection("auditEvents").doc(), {
      type: "claim_token_batch_published",
      adminUid: admin.uid,
      adminEmail: admin.email ?? null,
      source: "claim-token-manager",
      batchId,
      publishedCount: published,
      alreadyPresentCount: alreadyPresent,
      createdAt: FieldValue.serverTimestamp(),
    });
    return result;
  });
}
