import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  authorizeDesktop,
  exchangeDesktopCode,
  publishClaimTokenBatch,
} from "../src/desktop.js";

function reference(collectionName, id) {
  return { collectionName, id };
}

function collectionFactory(createdDocuments = []) {
  return (collectionName) => ({
    doc: (id = `auto-${createdDocuments.length}`) => reference(collectionName, id),
  });
}

test("desktop authorization records only a short-lived PKCE challenge", async () => {
  let created;
  const db = {
    collection: (collectionName) => ({
      doc: (id) => ({
        create: async (data) => {
          created = { collectionName, id, data };
        },
      }),
    }),
  };
  const result = await authorizeDesktop(
    db,
    { uid: "admin-1", email: "admin@example.com" },
    { state: "s".repeat(32), codeChallenge: "c".repeat(43), callbackPort: 49152 },
  );
  assert.equal(result.state, "s".repeat(32));
  assert.equal(result.callbackPort, 49152);
  assert.equal(result.code.length, 43);
  assert.equal(created.collectionName, "desktopAuthCodes");
  assert.equal(created.data.codeChallenge, "c".repeat(43));
  assert.equal("code" in created.data, false);
});

test("desktop exchange consumes the code and returns a Firebase custom token", async () => {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const writes = [];
  const db = {
    collection: collectionFactory(writes),
    runTransaction: async (operation) =>
      operation({
        get: async () => ({
          exists: true,
          data: () => ({
            adminUid: "admin-1",
            adminEmail: "admin@example.com",
            codeChallenge: challenge,
            expiresAt: { toMillis: () => Date.now() + 60_000 },
            usedAt: null,
          }),
        }),
        update: (ref, data) => writes.push({ kind: "update", ref, data }),
        create: (ref, data) => writes.push({ kind: "create", ref, data }),
      }),
  };
  const auth = {
    createCustomToken: async (uid, claims) => {
      assert.equal(uid, "admin-1");
      assert.deepEqual(claims, { promoDesktop: true });
      return "firebase-custom-token";
    },
  };
  const result = await exchangeDesktopCode(db, auth, {
    code: "a".repeat(43),
    verifier,
  });
  assert.deepEqual(result, { customToken: "firebase-custom-token" });
  assert.equal(writes.some((write) => write.kind === "update"), true);
});

test("publisher canonicalizes local mixed-case tokens and creates an idempotency record", async () => {
  const writes = [];
  const db = {
    collection: collectionFactory(writes),
    getAll: async (...refs) => refs.map(() => ({ exists: true })),
    runTransaction: async (operation) =>
      operation({
        get: async () => ({ exists: false }),
        getAll: async (...refs) => refs.map(() => ({ exists: false })),
        create: (ref, data) => writes.push({ ref, data }),
      }),
  };
  const result = await publishClaimTokenBatch(
    db,
    { uid: "admin-1", email: "admin@example.com" },
    {
      mutationId: "mutation-1234567890",
      batchId: "batch-1",
      tokens: [
        {
          token: "CYA-SGM-L728-a2bc3d4e",
          productPrefix: "SGM",
          promotionPrefix: "L728",
        },
      ],
    },
  );
  assert.deepEqual(result, {
    published: 1,
    alreadyPresent: 0,
    total: 1,
    batchId: "batch-1",
  });
  const claimWrite = writes.find(
    (write) => write.ref.collectionName === "claimTokens",
  );
  assert.equal(claimWrite.ref.id, "CYA-SGM-L728-A2BC3D4E");
  assert.equal(claimWrite.data.source, "claim-token-manager");
  assert.equal(
    writes.some((write) => write.ref.collectionName === "publisherMutations"),
    true,
  );
});

test("publisher rejects token metadata that does not match the token", async () => {
  await assert.rejects(
    () =>
      publishClaimTokenBatch(
        {},
        { uid: "admin-1" },
        {
          mutationId: "mutation-1234567890",
          batchId: "batch-1",
          tokens: [
            {
              token: "CYA-SGM-L728-A2BC3D4E",
              productPrefix: "OTHER",
              promotionPrefix: "L728",
            },
          ],
        },
      ),
    (error) => error.code === "token_metadata_mismatch",
  );
});
