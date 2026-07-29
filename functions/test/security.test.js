import assert from "node:assert/strict";
import { test } from "node:test";

import { requireAppCheck, requirePromoAdmin } from "../src/security.js";

function requestWithToken(token) {
  return {
    get(name) {
      return name.toLowerCase() === "authorization" ? `Bearer ${token}` : null;
    },
  };
}

test("unauthenticated admin access is rejected", async () => {
  const request = { get: () => null };
  await assert.rejects(
    requirePromoAdmin(request, { verifyIdToken: async () => ({}) }),
    (error) => error.code === "unauthorized" && error.status === 401,
  );
});

test("authenticated user without promoAdmin claim is rejected", async () => {
  await assert.rejects(
    requirePromoAdmin(requestWithToken("valid"), {
      verifyIdToken: async () => ({ uid: "user-1" }),
    }),
    (error) => error.code === "forbidden" && error.status === 403,
  );
});

test("verified email on the server-side allowlist is accepted", async () => {
  const admin = await requirePromoAdmin(
    requestWithToken("valid"),
    {
      verifyIdToken: async () => ({
        uid: "admin-2",
        email: "ADMIN@EXAMPLE.COM",
        email_verified: true,
      }),
    },
    new Set(["admin@example.com"]),
  );
  assert.equal(admin.uid, "admin-2");
});

test("authenticated promo admin is accepted", async () => {
  const admin = await requirePromoAdmin(requestWithToken("valid"), {
    verifyIdToken: async () => ({
      uid: "admin-1",
      email: "admin@example.com",
      promoAdmin: true,
    }),
  });
  assert.equal(admin.uid, "admin-1");
});

test("redemption consumes a limited-use App Check token", async () => {
  let receivedOptions;
  await requireAppCheck(
    { get: (name) => (name === "x-firebase-appcheck" ? "app-check-token" : null) },
    {
      verifyToken: async (_token, options) => {
        receivedOptions = options;
        return { alreadyConsumed: false };
      },
    },
    { consume: true },
  );
  assert.deepEqual(receivedOptions, { consume: true });
});

test("a replayed limited-use App Check token is rejected", async () => {
  await assert.rejects(
    requireAppCheck(
      { get: (name) => (name === "x-firebase-appcheck" ? "app-check-token" : null) },
      { verifyToken: async () => ({ alreadyConsumed: true }) },
      { consume: true },
    ),
    (error) => error.code === "app_check_failed",
  );
});
