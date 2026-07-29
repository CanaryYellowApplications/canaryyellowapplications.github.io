import { FieldValue, Timestamp } from "firebase-admin/firestore";

import {
  PLATFORMS,
  assertDisplayName,
  codeFingerprint,
  maskStoreCode,
  normalizeClaimToken,
  normalizePlatform,
  normalizePrefix,
  parseExpirationDate,
} from "./core.js";
import { ServiceError } from "./errors.js";
import {
  previewClaimTokenImport,
  previewStoreCodeImport,
} from "./imports.js";
import { expirationSortValue } from "./repository.js";

function serialize(value) {
  if (value?.toDate instanceof Function) {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serialize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, serialize(child)]),
    );
  }
  return value;
}

function documentData(snapshot) {
  return { id: snapshot.id, ...serialize(snapshot.data()) };
}

function booleanValue(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

async function loadConfiguration(db) {
  const [productsSnapshot, promotionsSnapshot] = await Promise.all([
    db.collection("products").get(),
    db.collection("promotions").get(),
  ]);
  const products = productsSnapshot.docs.map(documentData);
  const promotions = promotionsSnapshot.docs.map(documentData);
  return {
    products,
    promotions,
    productPrefixes: new Set(products.map((item) => item.prefix)),
    promotionPrefixes: new Set(promotions.map((item) => item.prefix)),
    productPlatforms: new Map(
      products.map((item) => [item.prefix, item.supportedPlatforms ?? []]),
    ),
  };
}

async function existingDocumentIds(db, collectionName, ids) {
  if (ids.length === 0) {
    return new Set();
  }
  const references = ids.map((id) => db.collection(collectionName).doc(id));
  const snapshots = await db.getAll(...references);
  return new Set(snapshots.filter((snapshot) => snapshot.exists).map((snapshot) => snapshot.id));
}

async function createAuditEvent(db, admin, type, details = {}) {
  await db.collection("auditEvents").add({
    type,
    adminUid: admin.uid,
    adminEmail: admin.email ?? null,
    ...details,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function assertConfirmed(body) {
  if (body?.confirmed !== true) {
    throw new ServiceError("confirmation_required", 400);
  }
}

function effectiveStoreStatus(data, now = new Date()) {
  const expirationDate = data.expirationDate?.toDate?.();
  if (data.status === "available" && expirationDate && expirationDate <= now) {
    return "expired";
  }
  return data.status;
}

async function overview(db) {
  const now = new Date();
  const soon = new Date(now.valueOf() + 30 * 24 * 60 * 60 * 1000);
  const [
    availableClaims,
    redeemedClaims,
    disabledClaims,
    availableCodes,
  ] = await Promise.all([
    db.collection("claimTokens").where("status", "==", "available").count().get(),
    db.collection("claimTokens").where("status", "==", "redeemed").count().get(),
    db.collection("claimTokens").where("status", "==", "disabled").count().get(),
    db.collection("storeCodes").where("status", "==", "available").get(),
  ]);

  const codeCounts = {
    ios: 0,
    macos: 0,
    android: 0,
    expiringSoon: 0,
    expired: 0,
  };
  for (const document of availableCodes.docs) {
    const data = document.data();
    const expirationDate = data.expirationDate?.toDate?.() ?? null;
    if (expirationDate && expirationDate <= now) {
      codeCounts.expired += 1;
      continue;
    }
    if (PLATFORMS.includes(data.platform)) {
      codeCounts[data.platform] += 1;
    }
    if (expirationDate && expirationDate <= soon) {
      codeCounts.expiringSoon += 1;
    }
  }

  const explicitlyExpired = await db
    .collection("storeCodes")
    .where("status", "==", "expired")
    .count()
    .get();

  return {
    availableClaimTokens: availableClaims.data().count,
    redeemedClaimTokens: redeemedClaims.data().count,
    disabledClaimTokens: disabledClaims.data().count,
    availableIosCodes: codeCounts.ios,
    availableMacosCodes: codeCounts.macos,
    availableAndroidCodes: codeCounts.android,
    codesExpiringSoon: codeCounts.expiringSoon,
    expiredCodes: codeCounts.expired + explicitlyExpired.data().count,
  };
}

async function listProducts(db) {
  const snapshot = await db.collection("products").orderBy("name").get();
  return snapshot.docs.map(documentData);
}

async function saveProduct(db, admin, body) {
  const prefix = normalizePrefix(body?.prefix, "product_prefix");
  const originalPrefix = body?.originalPrefix
    ? normalizePrefix(body.originalPrefix, "product_prefix")
    : null;
  if (originalPrefix && originalPrefix !== prefix) {
    throw new ServiceError("prefix_locked", 409);
  }
  const name = assertDisplayName(body?.name, "product_name");
  const supportedPlatforms = [
    ...new Set((body?.supportedPlatforms ?? []).map(normalizePlatform)),
  ];
  if (supportedPlatforms.length === 0) {
    throw new ServiceError("platform_required", 400);
  }

  const reference = db.collection("products").doc(prefix);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    transaction.set(
      reference,
      {
        prefix,
        name,
        supportedPlatforms,
        isActive: booleanValue(body?.isActive),
        createdAt: snapshot.exists
          ? snapshot.data().createdAt
          : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  await createAuditEvent(db, admin, "product_saved", { productPrefix: prefix });
  return { prefix };
}

async function listPromotions(db) {
  const snapshot = await db.collection("promotions").orderBy("name").get();
  return snapshot.docs.map(documentData);
}

async function savePromotion(db, admin, body) {
  const prefix = normalizePrefix(body?.prefix, "promotion_prefix");
  const originalPrefix = body?.originalPrefix
    ? normalizePrefix(body.originalPrefix, "promotion_prefix")
    : null;
  if (originalPrefix && originalPrefix !== prefix) {
    throw new ServiceError("prefix_locked", 409);
  }
  const name = assertDisplayName(body?.name, "promotion_name");
  const reference = db.collection("promotions").doc(prefix);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    transaction.set(
      reference,
      {
        prefix,
        name,
        isActive: booleanValue(body?.isActive),
        createdAt: snapshot.exists
          ? snapshot.data().createdAt
          : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  await createAuditEvent(db, admin, "promotion_saved", {
    promotionPrefix: prefix,
  });
  return { prefix };
}

async function buildClaimPreview(db, body) {
  const configuration = await loadConfiguration(db);
  const preliminary = await previewClaimTokenImport({
    content: body?.content,
    format: body?.format,
    productPrefixes: configuration.productPrefixes,
    promotionPrefixes: configuration.promotionPrefixes,
  });
  const ids = preliminary.rows.map((row) => row.token).filter(Boolean);
  const existingTokens = await existingDocumentIds(db, "claimTokens", ids);
  return previewClaimTokenImport({
    content: body?.content,
    format: body?.format,
    existingTokens,
    productPrefixes: configuration.productPrefixes,
    promotionPrefixes: configuration.promotionPrefixes,
  });
}

async function importClaimTokens(db, admin, body) {
  assertConfirmed(body);
  const preview = await buildClaimPreview(db, body);
  const rows = preview.rows.filter((row) => row.issues.length === 0);
  if (rows.length === 0) {
    throw new ServiceError("no_valid_rows", 409);
  }

  await db.runTransaction(async (transaction) => {
    const references = rows.map((row) => db.collection("claimTokens").doc(row.token));
    const snapshots = await transaction.getAll(...references);
    if (snapshots.some((snapshot) => snapshot.exists)) {
      throw new ServiceError("import_changed", 409);
    }
    for (const row of rows) {
      transaction.create(db.collection("claimTokens").doc(row.token), {
        token: row.token,
        productPrefix: row.productPrefix,
        promotionPrefix: row.promotionPrefix,
        status: "available",
        redeemedAt: null,
        selectedPlatform: null,
        assignedStoreCodeId: null,
        disabledReason: null,
        importedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    transaction.create(db.collection("auditEvents").doc(), {
      type: "claim_tokens_imported",
      adminUid: admin.uid,
      adminEmail: admin.email ?? null,
      importedCount: rows.length,
      rejectedCount: preview.summary.invalid,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    imported: rows.length,
    rejected: preview.summary.invalid,
  };
}

async function listClaimTokens(db, query) {
  const search = typeof query.search === "string" ? query.search.trim() : "";
  let documents;
  if (search) {
    try {
      const token = normalizeClaimToken(search);
      const snapshot = await db.collection("claimTokens").doc(token).get();
      documents = snapshot.exists ? [snapshot] : [];
    } catch {
      documents = [];
    }
  } else {
    const snapshot = await db
      .collection("claimTokens")
      .orderBy("importedAt", "desc")
      .limit(200)
      .get();
    documents = snapshot.docs;
  }

  return documents
    .map(documentData)
    .filter(
      (item) =>
        (!query.productPrefix || item.productPrefix === query.productPrefix) &&
        (!query.promotionPrefix || item.promotionPrefix === query.promotionPrefix) &&
        (!query.status || item.status === query.status),
    );
}

async function setClaimTokenStatus(db, admin, tokenValue, body) {
  const token = normalizeClaimToken(tokenValue);
  const requestedStatus = body?.status;
  if (!["available", "disabled"].includes(requestedStatus)) {
    throw new ServiceError("invalid_status", 400);
  }

  const reference = db.collection("claimTokens").doc(token);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      throw new ServiceError("not_found", 404);
    }
    const currentStatus = snapshot.data().status;
    if (currentStatus === "redeemed") {
      throw new ServiceError("redeemed_token_locked", 409);
    }
    if (!["available", "disabled"].includes(currentStatus)) {
      throw new ServiceError("invalid_status_transition", 409);
    }
    transaction.update(reference, {
      status: requestedStatus,
      disabledReason:
        requestedStatus === "disabled"
          ? String(body?.disabledReason ?? "").trim().slice(0, 200) || "Disabled by administrator"
          : null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(db.collection("auditEvents").doc(), {
      type:
        requestedStatus === "disabled"
          ? "claim_token_disabled"
          : "claim_token_reenabled",
      adminUid: admin.uid,
      adminEmail: admin.email ?? null,
      claimToken: token,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { token, status: requestedStatus };
}

async function buildStorePreview(db, body) {
  const configuration = await loadConfiguration(db);
  const preliminary = await previewStoreCodeImport({
    content: body?.content,
    format: body?.format,
    defaultProductPrefix: body?.productPrefix,
    defaultPlatform: body?.platform,
    defaultExpirationDate: body?.expirationDate,
    productPlatforms: configuration.productPlatforms,
  });
  const ids = preliminary.rows.map((row) => row.codeId).filter(Boolean);
  const existingCodeIds = await existingDocumentIds(db, "storeCodes", ids);
  return previewStoreCodeImport({
    content: body?.content,
    format: body?.format,
    defaultProductPrefix: body?.productPrefix,
    defaultPlatform: body?.platform,
    defaultExpirationDate: body?.expirationDate,
    existingCodeIds,
    productPlatforms: configuration.productPlatforms,
  });
}

function safeStorePreview(preview) {
  return {
    summary: preview.summary,
    rows: preview.rows.map(({ code: _code, expirationDate, ...row }) => ({
      ...row,
      expirationDate: expirationDate?.toISOString?.() ?? null,
    })),
  };
}

async function importStoreCodes(db, admin, body) {
  assertConfirmed(body);
  const preview = await buildStorePreview(db, body);
  const rows = preview.rows.filter((row) => row.issues.length === 0);
  if (rows.length === 0) {
    throw new ServiceError("no_valid_rows", 409);
  }

  await db.runTransaction(async (transaction) => {
    const references = rows.map((row) => db.collection("storeCodes").doc(row.codeId));
    const snapshots = await transaction.getAll(...references);
    if (snapshots.some((snapshot) => snapshot.exists)) {
      throw new ServiceError("import_changed", 409);
    }
    for (const row of rows) {
      transaction.create(db.collection("storeCodes").doc(row.codeId), {
        code: row.code,
        codeFingerprint: row.codeId,
        productPrefix: row.productPrefix,
        platform: row.platform,
        expirationDate: row.expirationDate
          ? Timestamp.fromDate(row.expirationDate)
          : null,
        expirationDateSort: expirationSortValue(row.expirationDate),
        status: row.status,
        assignedClaimToken: null,
        assignedAt: null,
        importedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    transaction.create(db.collection("auditEvents").doc(), {
      type: "store_codes_imported",
      adminUid: admin.uid,
      adminEmail: admin.email ?? null,
      importedCount: rows.length,
      rejectedCount: preview.summary.invalid,
      productPrefixes: [...new Set(rows.map((row) => row.productPrefix))],
      platforms: [...new Set(rows.map((row) => row.platform))],
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    imported: rows.length,
    rejected: preview.summary.invalid,
  };
}

async function listStoreCodes(db, query) {
  const search = typeof query.search === "string" ? query.search.trim() : "";
  let documents;
  if (search) {
    try {
      const codeId = codeFingerprint(search);
      const snapshot = await db.collection("storeCodes").doc(codeId).get();
      documents = snapshot.exists ? [snapshot] : [];
    } catch {
      documents = [];
    }
  } else {
    const snapshot = await db
      .collection("storeCodes")
      .orderBy("importedAt", "desc")
      .limit(200)
      .get();
    documents = snapshot.docs;
  }

  return documents
    .map((document) => {
      const data = document.data();
      return {
        id: document.id,
        maskedCode: maskStoreCode(data.code),
        productPrefix: data.productPrefix,
        platform: data.platform,
        status: effectiveStoreStatus(data),
        expirationDate: serialize(data.expirationDate),
        assignedClaimToken: data.assignedClaimToken ?? null,
        assignedAt: serialize(data.assignedAt),
        importedAt: serialize(data.importedAt),
      };
    })
    .filter(
      (item) =>
        (!query.productPrefix || item.productPrefix === query.productPrefix) &&
        (!query.platform || item.platform === query.platform) &&
        (!query.status || item.status === query.status) &&
        (!query.expiration ||
          (query.expiration === "none" && !item.expirationDate) ||
          (query.expiration === "dated" && item.expirationDate)),
    );
}

async function setStoreCodeStatus(db, admin, codeId, body) {
  if (!/^[a-f0-9]{64}$/.test(codeId)) {
    throw new ServiceError("invalid_store_code_id", 400);
  }
  const requestedStatus = body?.status;
  if (!["available", "disabled"].includes(requestedStatus)) {
    throw new ServiceError("invalid_status", 400);
  }
  const reference = db.collection("storeCodes").doc(codeId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      throw new ServiceError("not_found", 404);
    }
    const data = snapshot.data();
    if (["assigned", "expired"].includes(data.status)) {
      throw new ServiceError("store_code_locked", 409);
    }
    const expirationDate = data.expirationDate?.toDate?.();
    if (
      requestedStatus === "available" &&
      expirationDate &&
      expirationDate <= new Date()
    ) {
      throw new ServiceError("store_code_expired", 409);
    }
    transaction.update(reference, {
      status: requestedStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(db.collection("auditEvents").doc(), {
      type:
        requestedStatus === "disabled"
          ? "store_code_disabled"
          : "store_code_reenabled",
      adminUid: admin.uid,
      adminEmail: admin.email ?? null,
      storeCodeId: codeId,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { id: codeId, status: requestedStatus };
}

async function listRedemptions(db, query) {
  const search = typeof query.search === "string" ? query.search.trim() : "";
  let documents;
  if (search) {
    try {
      const token = normalizeClaimToken(search);
      const snapshot = await db.collection("redemptions").doc(token).get();
      documents = snapshot.exists ? [snapshot] : [];
    } catch {
      documents = [];
    }
  } else {
    const snapshot = await db
      .collection("redemptions")
      .orderBy("redeemedAt", "desc")
      .limit(200)
      .get();
    documents = snapshot.docs;
  }
  return documents
    .map(documentData)
    .filter((item) => !query.platform || item.platform === query.platform);
}

export function createAdminHandler({ db, consumeRateLimit }) {
  return async function handleAdmin(request, admin, path) {
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "/admin/overview") {
      return overview(db);
    }
    if (method === "GET" && path === "/admin/products") {
      return listProducts(db);
    }
    if (method === "POST" && path === "/admin/products") {
      return saveProduct(db, admin, request.body);
    }
    if (method === "GET" && path === "/admin/promotions") {
      return listPromotions(db);
    }
    if (method === "POST" && path === "/admin/promotions") {
      return savePromotion(db, admin, request.body);
    }
    if (method === "POST" && path === "/admin/claim-tokens/preview") {
      await consumeRateLimit("admin_import_preview", admin.uid, 60, 60 * 60 * 1000);
      return buildClaimPreview(db, request.body);
    }
    if (method === "POST" && path === "/admin/claim-tokens/import") {
      await consumeRateLimit("admin_import_commit", admin.uid, 20, 60 * 60 * 1000);
      return importClaimTokens(db, admin, request.body);
    }
    if (method === "POST" && path === "/admin/claim-tokens/search") {
      return listClaimTokens(db, request.body ?? {});
    }
    if (method === "POST" && path === "/admin/claim-tokens/status") {
      return setClaimTokenStatus(db, admin, request.body?.token, request.body);
    }
    if (method === "POST" && path === "/admin/store-codes/preview") {
      await consumeRateLimit("admin_import_preview", admin.uid, 60, 60 * 60 * 1000);
      return safeStorePreview(await buildStorePreview(db, request.body));
    }
    if (method === "POST" && path === "/admin/store-codes/import") {
      await consumeRateLimit("admin_import_commit", admin.uid, 20, 60 * 60 * 1000);
      return importStoreCodes(db, admin, request.body);
    }
    if (method === "POST" && path === "/admin/store-codes/search") {
      return listStoreCodes(db, request.body ?? {});
    }
    if (method === "POST" && path === "/admin/store-codes/status") {
      return setStoreCodeStatus(db, admin, request.body?.id, request.body);
    }
    if (method === "POST" && path === "/admin/redemptions/search") {
      return listRedemptions(db, request.body ?? {});
    }

    throw new ServiceError("not_found", 404);
  };
}
