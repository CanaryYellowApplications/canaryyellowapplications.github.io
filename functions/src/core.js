import { createHash } from "node:crypto";

import { ServiceError } from "./errors.js";

export const PLATFORMS = Object.freeze(["ios", "macos", "android"]);

export const PLATFORM_LABELS = Object.freeze({
  ios: "iOS",
  macos: "macOS",
  android: "Android",
});

const CLAIM_TOKEN_PATTERN =
  /^(?<issuer>[A-Z0-9]+)-(?<productPrefix>[A-Z][A-Z0-9]{1,11})-(?<promotionPrefix>[A-Z][A-Z0-9]{1,11})-(?<suffix>[A-Z0-9]{6,32})$/;
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,11}$/;
const STORE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,126}[A-Za-z0-9]$/;

export function normalizeClaimToken(value) {
  if (typeof value !== "string") {
    throw new ServiceError("invalid_token", 400);
  }

  const trimmed = value.trim().toUpperCase();
  if (!trimmed || /[^A-Z0-9\s-]/.test(trimmed)) {
    throw new ServiceError("invalid_token", 400);
  }

  const canonical = trimmed.split(/[\s-]+/).filter(Boolean).join("-");
  if (!CLAIM_TOKEN_PATTERN.test(canonical)) {
    throw new ServiceError("invalid_token", 400);
  }
  return canonical;
}

export function parseClaimToken(value) {
  const token = normalizeClaimToken(value);
  const match = CLAIM_TOKEN_PATTERN.exec(token);
  const parts = match?.groups;

  if (!parts || parts.issuer !== "CYA") {
    throw new ServiceError("invalid_issuer", 400);
  }

  return {
    token,
    issuer: parts.issuer,
    productPrefix: parts.productPrefix,
    promotionPrefix: parts.promotionPrefix,
    suffix: parts.suffix,
  };
}

export function normalizePrefix(value, field = "prefix") {
  const prefix = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new ServiceError(`invalid_${field}`, 400);
  }
  return prefix;
}

export function normalizePlatform(value) {
  const platform = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PLATFORMS.includes(platform)) {
    throw new ServiceError("unsupported_platform", 400);
  }
  return platform;
}

export function normalizeStoreCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!STORE_CODE_PATTERN.test(code)) {
    throw new ServiceError("invalid_store_code", 400);
  }
  return code;
}

export function codeFingerprint(value) {
  const normalized = normalizeStoreCode(value).toUpperCase();
  return createHash("sha256").update(normalized).digest("hex");
}

export function tokenFingerprint(value) {
  const normalized = normalizeClaimToken(value);
  return createHash("sha256").update(normalized).digest("hex");
}

export function maskStoreCode(value) {
  const code = normalizeStoreCode(value);
  if (code.length <= 6) {
    return `${code.slice(0, 1)}••••${code.slice(-1)}`;
  }
  if (code.length <= 10) {
    return `${code.slice(0, 2)}••••${code.slice(-2)}`;
  }
  return `${code.slice(0, 4)}••••${code.slice(-4)}`;
}

export function parseExpirationDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value;
  }
  if (typeof value !== "string") {
    throw new ServiceError("invalid_expiration_date", 400);
  }

  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const parsed = dateOnly
    ? new Date(`${trimmed}T23:59:59.999Z`)
    : new Date(trimmed);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ServiceError("invalid_expiration_date", 400);
  }
  return parsed;
}

export function assertDisplayName(value, field = "name") {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 80) {
    throw new ServiceError(`invalid_${field}`, 400);
  }
  return name;
}

function claimStateError(claim) {
  if (claim.status === "redeemed") {
    return new ServiceError("already_redeemed", 409);
  }
  if (claim.status !== "available") {
    return new ServiceError("not_redeemable", 409);
  }
  return null;
}

export async function validateClaim(repository, submittedToken) {
  let token;
  try {
    token = normalizeClaimToken(submittedToken);
  } catch {
    throw new ServiceError("invalid_token", 404);
  }

  const claim = await repository.getClaimToken(token);
  if (!claim) {
    throw new ServiceError("invalid_token", 404);
  }

  const stateError = claimStateError(claim);
  if (stateError) {
    throw stateError;
  }

  const [product, promotion] = await Promise.all([
    repository.getProduct(claim.productPrefix),
    repository.getPromotion(claim.promotionPrefix),
  ]);

  if (!product?.isActive || !promotion?.isActive) {
    throw new ServiceError("not_redeemable", 409);
  }

  const supportedPlatforms = (product.supportedPlatforms ?? []).filter((platform) =>
    PLATFORMS.includes(platform),
  );
  if (supportedPlatforms.length === 0) {
    throw new ServiceError("not_redeemable", 409);
  }

  return {
    token,
    product: {
      name: product.name,
      prefix: product.prefix,
    },
    promotion: {
      name: promotion.name,
      prefix: promotion.prefix,
    },
    supportedPlatforms,
  };
}

export async function redeemClaim(repository, submittedToken, submittedPlatform, now = new Date()) {
  let token;
  try {
    token = normalizeClaimToken(submittedToken);
  } catch {
    throw new ServiceError("invalid_token", 404);
  }
  const platform = normalizePlatform(submittedPlatform);

  return repository.runTransaction(async (transaction) => {
    const claim = await transaction.getClaimToken(token);
    if (!claim) {
      throw new ServiceError("invalid_token", 404);
    }

    const stateError = claimStateError(claim);
    if (stateError) {
      throw stateError;
    }

    const product = await transaction.getProduct(claim.productPrefix);
    const promotion = await transaction.getPromotion(claim.promotionPrefix);
    if (!product?.isActive || !promotion?.isActive) {
      throw new ServiceError("not_redeemable", 409);
    }

    if (!(product.supportedPlatforms ?? []).includes(platform)) {
      throw new ServiceError("unsupported_platform", 400);
    }

    const storeCode = await transaction.findEligibleStoreCode(
      claim.productPrefix,
      platform,
      now,
    );
    if (!storeCode) {
      throw new ServiceError("no_inventory", 409);
    }

    await transaction.assignStoreCode(storeCode.id, token, now);
    await transaction.redeemClaimToken(token, storeCode.id, platform, now);
    await transaction.createRedemption(token, {
      claimToken: token,
      productPrefix: product.prefix,
      productName: product.name,
      promotionPrefix: promotion.prefix,
      promotionName: promotion.name,
      platform,
      redeemedAt: now,
      assignedStoreCodeId: storeCode.id,
      assignedStoreCodeMasked: maskStoreCode(storeCode.code),
    });

    return {
      code: storeCode.code,
      platform,
      productName: product.name,
      promotionName: promotion.name,
    };
  });
}
