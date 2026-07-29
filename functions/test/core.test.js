import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeClaimToken,
  maskStoreCode,
  parseClaimToken,
  redeemClaim,
  validateClaim,
} from "../src/core.js";
import { ServiceError } from "../src/errors.js";

function clone(value) {
  return structuredClone(value);
}

class MemoryRepository {
  constructor({ products = [], promotions = [], claims = [], codes = [] } = {}) {
    this.products = new Map(products.map((item) => [item.prefix, clone(item)]));
    this.promotions = new Map(promotions.map((item) => [item.prefix, clone(item)]));
    this.claims = new Map(claims.map((item) => [item.token, clone(item)]));
    this.codes = new Map(codes.map((item) => [item.id, clone(item)]));
    this.redemptions = new Map();
    this.queue = Promise.resolve();
    this.failAt = null;
  }

  async getClaimToken(token) {
    return clone(this.claims.get(token) ?? null);
  }

  async getProduct(prefix) {
    return clone(this.products.get(prefix) ?? null);
  }

  async getPromotion(prefix) {
    return clone(this.promotions.get(prefix) ?? null);
  }

  async runTransaction(operation) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;

    const draft = {
      claims: clone(this.claims),
      codes: clone(this.codes),
      redemptions: clone(this.redemptions),
    };
    const transaction = {
      getClaimToken: async (token) => clone(draft.claims.get(token) ?? null),
      getProduct: async (prefix) => clone(this.products.get(prefix) ?? null),
      getPromotion: async (prefix) => clone(this.promotions.get(prefix) ?? null),
      findEligibleStoreCode: async (productPrefix, platform, now) => {
        const matches = [...draft.codes.values()]
          .filter(
            (code) =>
              code.productPrefix === productPrefix &&
              code.platform === platform &&
              code.status === "available" &&
              (!code.expirationDate || code.expirationDate > now),
          )
          .sort((a, b) => {
            const aTime = a.expirationDate?.valueOf() ?? Number.MAX_SAFE_INTEGER;
            const bTime = b.expirationDate?.valueOf() ?? Number.MAX_SAFE_INTEGER;
            return aTime - bTime || a.id.localeCompare(b.id);
          });
        return clone(matches[0] ?? null);
      },
      assignStoreCode: async (id, token, now) => {
        const code = draft.codes.get(id);
        code.status = "assigned";
        code.assignedClaimToken = token;
        code.assignedAt = now;
        if (this.failAt === "assign") {
          throw new Error("simulated transaction failure");
        }
      },
      redeemClaimToken: async (token, codeId, platform, now) => {
        const claim = draft.claims.get(token);
        claim.status = "redeemed";
        claim.assignedStoreCodeId = codeId;
        claim.selectedPlatform = platform;
        claim.redeemedAt = now;
        if (this.failAt === "redeem") {
          throw new Error("simulated transaction failure");
        }
      },
      createRedemption: async (token, redemption) => {
        draft.redemptions.set(token, clone(redemption));
        if (this.failAt === "record") {
          throw new Error("simulated transaction failure");
        }
      },
    };

    try {
      const result = await operation(transaction);
      this.claims = draft.claims;
      this.codes = draft.codes;
      this.redemptions = draft.redemptions;
      return result;
    } finally {
      release();
    }
  }
}

function fixture(overrides = {}) {
  return new MemoryRepository({
    products: [
      {
        prefix: "SSM",
        name: "ScreenGlow Mobile",
        isActive: true,
        supportedPlatforms: ["ios", "android"],
      },
    ],
    promotions: [
      { prefix: "FREE", name: "Free Copy", isActive: true },
    ],
    claims: [
      {
        token: "CYA-SSM-FREE-7X4M9Q2K",
        productPrefix: "SSM",
        promotionPrefix: "FREE",
        status: "available",
      },
      {
        token: "CYA-SSM-FREE-P8K3W7RQ",
        productPrefix: "SSM",
        promotionPrefix: "FREE",
        status: "available",
      },
    ],
    codes: [
      {
        id: "code-1",
        code: "APPLE-CODE-123",
        productPrefix: "SSM",
        platform: "ios",
        status: "available",
        expirationDate: new Date("2030-01-01T00:00:00Z"),
      },
      {
        id: "code-2",
        code: "APPLE-CODE-456",
        productPrefix: "SSM",
        platform: "ios",
        status: "available",
        expirationDate: new Date("2031-01-01T00:00:00Z"),
      },
    ],
    ...overrides,
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, code);
    return true;
  });
}

test("claim-token normalization tolerates case, spaces, and surrounding whitespace", () => {
  assert.equal(
    normalizeClaimToken("  cya ssm free 7x4m9q2k  "),
    "CYA-SSM-FREE-7X4M9Q2K",
  );
});

test("valid claim-token parsing returns all canonical components", () => {
  assert.deepEqual(parseClaimToken("CYA-SSM-FREE-7X4M9Q2K"), {
    token: "CYA-SSM-FREE-7X4M9Q2K",
    issuer: "CYA",
    productPrefix: "SSM",
    promotionPrefix: "FREE",
    suffix: "7X4M9Q2K",
  });
});

test("masked inventory never reveals an entire short store code", () => {
  assert.equal(maskStoreCode("ABCD"), "A••••D");
  assert.equal(maskStoreCode("ABCDEFGH"), "AB••••GH");
});

test("invalid issuer is rejected", () => {
  assert.throws(
    () => parseClaimToken("OTHER-SSM-FREE-7X4M9Q2K"),
    (error) => error.code === "invalid_issuer",
  );
});

test("unknown product prefix is rejected at validation", async () => {
  const repository = fixture();
  repository.claims.get("CYA-SSM-FREE-7X4M9Q2K").productPrefix = "NOPE";
  await expectCode(validateClaim(repository, "CYA-SSM-FREE-7X4M9Q2K"), "not_redeemable");
});

test("unknown promotion prefix is rejected at validation", async () => {
  const repository = fixture();
  repository.claims.get("CYA-SSM-FREE-7X4M9Q2K").promotionPrefix = "NOPE";
  await expectCode(validateClaim(repository, "CYA-SSM-FREE-7X4M9Q2K"), "not_redeemable");
});

test("disabled claim token is rejected", async () => {
  const repository = fixture();
  repository.claims.get("CYA-SSM-FREE-7X4M9Q2K").status = "disabled";
  await expectCode(
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
    "not_redeemable",
  );
});

test("already-redeemed claim token is rejected", async () => {
  const repository = fixture();
  repository.claims.get("CYA-SSM-FREE-7X4M9Q2K").status = "redeemed";
  await expectCode(
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
    "already_redeemed",
  );
});

test("unsupported platform is rejected", async () => {
  const repository = fixture();
  await expectCode(
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "macos"),
    "unsupported_platform",
  );
});

test("expired and disabled store codes are excluded", async () => {
  const repository = fixture({
    codes: [
      {
        id: "expired",
        code: "EXPIRED-CODE-123",
        productPrefix: "SSM",
        platform: "ios",
        status: "available",
        expirationDate: new Date("2020-01-01T00:00:00Z"),
      },
      {
        id: "disabled",
        code: "DISABLED-CODE-123",
        productPrefix: "SSM",
        platform: "ios",
        status: "disabled",
        expirationDate: new Date("2030-01-01T00:00:00Z"),
      },
    ],
  });
  await expectCode(
    redeemClaim(
      repository,
      "CYA-SSM-FREE-7X4M9Q2K",
      "ios",
      new Date("2026-01-01T00:00:00Z"),
    ),
    "no_inventory",
  );
});

test("successful assignment updates both records and returns the code once", async () => {
  const repository = fixture();
  const result = await redeemClaim(
    repository,
    "CYA-SSM-FREE-7X4M9Q2K",
    "ios",
    new Date("2026-01-01T00:00:00Z"),
  );

  assert.equal(result.code, "APPLE-CODE-123");
  assert.equal(repository.claims.get("CYA-SSM-FREE-7X4M9Q2K").status, "redeemed");
  assert.equal(repository.codes.get("code-1").status, "assigned");
  await expectCode(
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
    "already_redeemed",
  );
});

test("two claims cannot receive the same store code", async () => {
  const repository = fixture({ codes: [fixture().codes.get("code-1")] });
  const results = await Promise.allSettled([
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
    redeemClaim(repository, "CYA-SSM-FREE-P8K3W7RQ", "ios"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) => result.status === "rejected" && result.reason.code === "no_inventory",
    ).length,
    1,
  );
});

test("two simultaneous requests for one token produce one assignment", async () => {
  const repository = fixture();
  const results = await Promise.allSettled([
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" && result.reason.code === "already_redeemed",
    ).length,
    1,
  );
});

test("no inventory leaves the claim available", async () => {
  const repository = fixture({ codes: [] });
  await expectCode(
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
    "no_inventory",
  );
  assert.equal(repository.claims.get("CYA-SSM-FREE-7X4M9Q2K").status, "available");
});

test("a failed transaction rolls back every mutation", async () => {
  const repository = fixture();
  repository.failAt = "record";
  await assert.rejects(
    redeemClaim(repository, "CYA-SSM-FREE-7X4M9Q2K", "ios"),
    /simulated transaction failure/,
  );
  assert.equal(repository.claims.get("CYA-SSM-FREE-7X4M9Q2K").status, "available");
  assert.equal(repository.codes.get("code-1").status, "available");
  assert.equal(repository.redemptions.size, 0);
});
