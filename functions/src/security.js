import { createHash } from "node:crypto";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { ServiceError } from "./errors.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createRateLimiter(db, pepper) {
  return async function consumeRateLimit(namespace, subject, limit, windowMs) {
    const now = Date.now();
    const id = hash(`${namespace}:${pepper}:${subject}`);
    const reference = db.collection("rateLimits").doc(id);

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const data = snapshot.data();
      const existingWindowEnd = data?.windowEndsAt?.toMillis?.() ?? 0;

      if (!snapshot.exists || existingWindowEnd <= now) {
        transaction.set(reference, {
          namespace,
          count: 1,
          windowEndsAt: Timestamp.fromMillis(now + windowMs),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }

      if ((data.count ?? 0) >= limit) {
        throw new ServiceError("rate_limited", 429);
      }

      transaction.update(reference, {
        count: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  };
}

export function requestSubject(request) {
  const forwarded = request.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.ip || request.socket?.remoteAddress || "unknown";
}

export async function requirePromoAdmin(request, auth, allowedEmails = new Set()) {
  const authorization = request.get("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(authorization);
  if (!match) {
    throw new ServiceError("unauthorized", 401);
  }

  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1], true);
  } catch {
    throw new ServiceError("unauthorized", 401);
  }
  const email = typeof decoded.email === "string" ? decoded.email.toLowerCase() : "";
  const allowedByEmail = decoded.email_verified === true && allowedEmails.has(email);
  if (decoded.promoAdmin !== true && !allowedByEmail) {
    throw new ServiceError("forbidden", 403);
  }
  return decoded;
}

export async function requireAppCheck(request, appCheck, { consume = false } = {}) {
  const token = request.get("x-firebase-appcheck");
  if (!token) {
    throw new ServiceError("app_check_required", 401);
  }
  try {
    const result = await appCheck.verifyToken(token, { consume });
    if (consume && result.alreadyConsumed) {
      throw new Error("App Check token has already been consumed");
    }
  } catch {
    throw new ServiceError("app_check_failed", 401);
  }
}
