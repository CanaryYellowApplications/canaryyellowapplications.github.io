import { parse as parseCsv } from "csv-parse/sync";

import {
  codeFingerprint,
  maskStoreCode,
  normalizeClaimToken,
  normalizePlatform,
  normalizePrefix,
  normalizeStoreCode,
  parseClaimToken,
  parseExpirationDate,
} from "./core.js";
import { ServiceError } from "./errors.js";

export const MAX_IMPORT_ROWS = 400;
export const MAX_IMPORT_CHARACTERS = 500_000;

function assertImportContent(content) {
  if (typeof content !== "string" || !content.trim()) {
    throw new ServiceError("empty_import", 400);
  }
  if (content.length > MAX_IMPORT_CHARACTERS) {
    throw new ServiceError("import_too_large", 413);
  }
}

function resolveFormat(content, format, expectedHeader) {
  const requested = typeof format === "string" ? format.toLowerCase() : "auto";
  if (requested === "text" || requested === "csv") {
    return requested;
  }
  if (requested !== "auto") {
    throw new ServiceError("invalid_import_format", 400);
  }
  const firstLine = content.trimStart().split(/\r?\n/, 1)[0].toLowerCase();
  return firstLine.split(",").map((part) => part.trim()).includes(expectedHeader)
    ? "csv"
    : "text";
}

function parseRows(content, format, expectedHeader) {
  assertImportContent(content);
  const resolvedFormat = resolveFormat(content, format, expectedHeader);

  let rows;
  if (resolvedFormat === "csv") {
    try {
      rows = parseCsv(content, {
        bom: true,
        columns: (headers) => headers.map((header) => header.trim()),
        relax_column_count: false,
        skip_empty_lines: true,
        trim: true,
      });
    } catch {
      throw new ServiceError("invalid_csv", 400);
    }
    if (rows.length > 0 && !(expectedHeader in rows[0])) {
      throw new ServiceError(`missing_${expectedHeader}_column`, 400);
    }
  } else {
    rows = content
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ [expectedHeader]: line }));
  }

  if (rows.length === 0) {
    throw new ServiceError("empty_import", 400);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ServiceError("too_many_import_rows", 400);
  }
  return rows;
}

function duplicateIndexes(values) {
  const counts = new Map();
  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value),
  );
}

function summarize(rows) {
  return {
    total: rows.length,
    valid: rows.filter((row) => row.issues.length === 0).length,
    invalid: rows.filter((row) => row.issues.length > 0).length,
  };
}

export async function previewClaimTokenImport({
  content,
  format = "auto",
  existingTokens = new Set(),
  productPrefixes = new Set(),
  promotionPrefixes = new Set(),
}) {
  const parsedRows = parseRows(content, format, "token");
  const normalizedValues = parsedRows.map((row) => {
    try {
      return normalizeClaimToken(row.token);
    } catch {
      return null;
    }
  });
  const duplicates = duplicateIndexes(normalizedValues);

  const rows = parsedRows.map((row, index) => {
    const issues = [];
    let parsed = null;
    try {
      parsed = parseClaimToken(row.token);
    } catch (error) {
      issues.push(error.code === "invalid_issuer" ? "invalid_issuer" : "malformed");
    }

    if (parsed) {
      if (duplicates.has(parsed.token)) {
        issues.push("duplicate_in_import");
      }
      if (existingTokens.has(parsed.token)) {
        issues.push("duplicate_existing");
      }
      if (!productPrefixes.has(parsed.productPrefix)) {
        issues.push("unknown_product");
      }
      if (!promotionPrefixes.has(parsed.promotionPrefix)) {
        issues.push("unknown_promotion");
      }
    }

    return {
      row: index + 1,
      raw: row.token ?? "",
      token: parsed?.token ?? null,
      productPrefix: parsed?.productPrefix ?? null,
      promotionPrefix: parsed?.promotionPrefix ?? null,
      issues,
    };
  });

  return { rows, summary: summarize(rows) };
}

export async function previewStoreCodeImport({
  content,
  format = "auto",
  defaultProductPrefix,
  defaultPlatform,
  defaultExpirationDate = null,
  existingCodeIds = new Set(),
  productPlatforms = new Map(),
  now = new Date(),
}) {
  const parsedRows = parseRows(content, format, "code");
  const fingerprints = parsedRows.map((row) => {
    try {
      return codeFingerprint(row.code);
    } catch {
      return null;
    }
  });
  const duplicates = duplicateIndexes(fingerprints);

  const rows = parsedRows.map((row, index) => {
    const issues = [];
    let code = null;
    let codeId = null;
    let productPrefix = null;
    let platform = null;
    let expirationDate = null;

    try {
      code = normalizeStoreCode(row.code);
      codeId = codeFingerprint(code);
    } catch {
      issues.push("malformed");
    }
    try {
      productPrefix = normalizePrefix(row.productPrefix || defaultProductPrefix, "product_prefix");
    } catch {
      issues.push("invalid_product");
    }
    try {
      platform = normalizePlatform(row.platform || defaultPlatform);
    } catch {
      issues.push("invalid_platform");
    }
    try {
      expirationDate = parseExpirationDate(
        row.expirationDate || defaultExpirationDate,
      );
    } catch {
      issues.push("invalid_expiration_date");
    }

    if (codeId && duplicates.has(codeId)) {
      issues.push("duplicate_in_import");
    }
    if (codeId && existingCodeIds.has(codeId)) {
      issues.push("duplicate_existing");
    }
    if (
      productPrefix &&
      platform &&
      !(productPlatforms.get(productPrefix) ?? []).includes(platform)
    ) {
      issues.push("unsupported_product_platform");
    }

    return {
      row: index + 1,
      raw: row.code ?? "",
      code,
      codeId,
      maskedCode: code ? maskStoreCode(code) : null,
      productPrefix,
      platform,
      expirationDate,
      status: expirationDate && expirationDate <= now ? "expired" : "available",
      issues: [...new Set(issues)],
    };
  });

  return { rows, summary: summarize(rows) };
}
