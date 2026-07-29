import assert from "node:assert/strict";
import { test } from "node:test";

import {
  previewClaimTokenImport,
  previewStoreCodeImport,
} from "../src/imports.js";

const products = new Set(["SSM"]);
const promotions = new Set(["FREE"]);

test("claim import reports duplicates in one import", async () => {
  const preview = await previewClaimTokenImport({
    content: "CYA-SSM-FREE-7X4M9Q2K\nCYA SSM FREE 7X4M9Q2K",
    productPrefixes: products,
    promotionPrefixes: promotions,
  });
  assert.equal(preview.summary.valid, 0);
  assert.ok(preview.rows.every((row) => row.issues.includes("duplicate_in_import")));
});

test("claim import reports duplicates already in the database", async () => {
  const preview = await previewClaimTokenImport({
    content: "token\nCYA-SSM-FREE-7X4M9Q2K",
    format: "csv",
    existingTokens: new Set(["CYA-SSM-FREE-7X4M9Q2K"]),
    productPrefixes: products,
    promotionPrefixes: promotions,
  });
  assert.deepEqual(preview.rows[0].issues, ["duplicate_existing"]);
});

test("claim import reports unknown product and promotion prefixes", async () => {
  const preview = await previewClaimTokenImport({
    content: "CYA-NEW-GIFT-7X4M9Q2K",
    productPrefixes: products,
    promotionPrefixes: promotions,
  });
  assert.deepEqual(preview.rows[0].issues, ["unknown_product", "unknown_promotion"]);
});

test("store-code import uses a robust CSV parser and detects duplicates", async () => {
  const preview = await previewStoreCodeImport({
    content: 'code,expirationDate\n"APPLE-CODE-123","2030-09-30"\nAPPLE-CODE-123,2030-09-30',
    format: "csv",
    defaultProductPrefix: "SSM",
    defaultPlatform: "ios",
    productPlatforms: new Map([["SSM", ["ios", "android"]]]),
  });
  assert.equal(preview.summary.valid, 0);
  assert.ok(preview.rows.every((row) => row.issues.includes("duplicate_in_import")));
});

test("store-code import reports an existing code without exposing other inventory", async () => {
  const first = await previewStoreCodeImport({
    content: "APPLE-CODE-123",
    defaultProductPrefix: "SSM",
    defaultPlatform: "ios",
    productPlatforms: new Map([["SSM", ["ios"]]]),
  });
  const preview = await previewStoreCodeImport({
    content: "APPLE-CODE-123",
    defaultProductPrefix: "SSM",
    defaultPlatform: "ios",
    productPlatforms: new Map([["SSM", ["ios"]]]),
    existingCodeIds: new Set([first.rows[0].codeId]),
  });
  assert.deepEqual(preview.rows[0].issues, ["duplicate_existing"]);
});
