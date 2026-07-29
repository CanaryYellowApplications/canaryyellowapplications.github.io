import assert from "node:assert/strict";
import { test } from "node:test";

import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

import { redeemClaim } from "../src/core.js";
import { createFirestoreRepository, expirationSortValue } from "../src/repository.js";

const projectId = "demo-cya-promo";
let app;
let database;
let repository;

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error("FIRESTORE_EMULATOR_HOST is required");
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(response.ok, true);
}

async function seed({ claims = 2, codes = 2 } = {}) {
  await clearFirestore();
  const batch = database.batch();
  batch.set(database.collection("products").doc("SSM"), {
    prefix: "SSM",
    name: "ScreenGlow Mobile",
    isActive: true,
    supportedPlatforms: ["ios", "android"],
  });
  batch.set(database.collection("promotions").doc("FREE"), {
    prefix: "FREE",
    name: "Free Copy",
    isActive: true,
  });
  const claimTokens = ["CYA-SSM-FREE-7X4M9Q2K", "CYA-SSM-FREE-P8K3W7RQ"];
  for (const token of claimTokens.slice(0, claims)) {
    batch.set(database.collection("claimTokens").doc(token), {
      token,
      productPrefix: "SSM",
      promotionPrefix: "FREE",
      status: "available",
    });
  }
  for (let index = 1; index <= codes; index += 1) {
    const expirationDate = new Date(`203${index}-01-01T00:00:00Z`);
    batch.set(database.collection("storeCodes").doc(`code-${index}`), {
      code: `APPLE-CODE-${index}23`,
      productPrefix: "SSM",
      platform: "ios",
      status: "available",
      expirationDate: Timestamp.fromDate(expirationDate),
      expirationDateSort: expirationSortValue(expirationDate),
      importedAt: Timestamp.fromMillis(index),
    });
  }
  await batch.commit();
  return claimTokens;
}

test.before(async () => {
  app = initializeApp({ projectId }, "promo-repository-tests");
  database = getFirestore(app);
  repository = createFirestoreRepository(database);
});

test.after(async () => {
  await deleteApp(app);
});

test("Firestore transaction never assigns one code to two simultaneous claims", async () => {
  const [firstToken, secondToken] = await seed({ claims: 2, codes: 1 });
  const results = await Promise.allSettled([
    redeemClaim(repository, firstToken, "ios"),
    redeemClaim(repository, secondToken, "ios"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) => result.status === "rejected" && result.reason.code === "no_inventory",
    ).length,
    1,
  );
  const assignedCodes = await database
    .collection("storeCodes")
    .where("status", "==", "assigned")
    .get();
  assert.equal(assignedCodes.size, 1);
});

test("Firestore transaction produces one assignment for simultaneous requests on one token", async () => {
  const [token] = await seed({ claims: 1, codes: 2 });
  const results = await Promise.allSettled([
    redeemClaim(repository, token, "ios"),
    redeemClaim(repository, token, "ios"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" && result.reason.code === "already_redeemed",
    ).length,
    1,
  );
  const assignedCodes = await database
    .collection("storeCodes")
    .where("status", "==", "assigned")
    .get();
  assert.equal(assignedCodes.size, 1);
});

test("Firestore rolls back code and claim writes when the redemption record cannot be created", async () => {
  const [token] = await seed({ claims: 1, codes: 1 });
  await database.collection("redemptions").doc(token).set({ existing: true });

  await assert.rejects(redeemClaim(repository, token, "ios"));
  const [claim, code] = await Promise.all([
    database.collection("claimTokens").doc(token).get(),
    database.collection("storeCodes").doc("code-1").get(),
  ]);
  assert.equal(claim.data().status, "available");
  assert.equal(code.data().status, "available");
});
