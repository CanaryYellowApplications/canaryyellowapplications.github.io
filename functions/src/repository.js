import { FieldValue, Timestamp } from "firebase-admin/firestore";

const NEVER_EXPIRES = Timestamp.fromDate(new Date("9999-12-31T23:59:59.999Z"));

function dataFrom(snapshot) {
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

export function createFirestoreRepository(db) {
  return {
    async getClaimToken(token) {
      return dataFrom(await db.collection("claimTokens").doc(token).get());
    },

    async getProduct(prefix) {
      return dataFrom(await db.collection("products").doc(prefix).get());
    },

    async getPromotion(prefix) {
      return dataFrom(await db.collection("promotions").doc(prefix).get());
    },

    async runTransaction(operation) {
      return db.runTransaction(async (firestoreTransaction) => {
        const transaction = {
          async getClaimToken(token) {
            return dataFrom(
              await firestoreTransaction.get(db.collection("claimTokens").doc(token)),
            );
          },

          async getProduct(prefix) {
            return dataFrom(
              await firestoreTransaction.get(db.collection("products").doc(prefix)),
            );
          },

          async getPromotion(prefix) {
            return dataFrom(
              await firestoreTransaction.get(db.collection("promotions").doc(prefix)),
            );
          },

          async findEligibleStoreCode(productPrefix, platform, now) {
            const query = db
              .collection("storeCodes")
              .where("productPrefix", "==", productPrefix)
              .where("platform", "==", platform)
              .where("status", "==", "available")
              .where("expirationDateSort", ">", Timestamp.fromDate(now))
              .orderBy("expirationDateSort", "asc")
              .orderBy("importedAt", "asc")
              .limit(1);
            const snapshot = await firestoreTransaction.get(query);
            return snapshot.empty ? null : dataFrom(snapshot.docs[0]);
          },

          async assignStoreCode(codeId, claimToken) {
            firestoreTransaction.update(db.collection("storeCodes").doc(codeId), {
              status: "assigned",
              assignedClaimToken: claimToken,
              assignedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          },

          async redeemClaimToken(token, storeCodeId, platform) {
            firestoreTransaction.update(db.collection("claimTokens").doc(token), {
              status: "redeemed",
              selectedPlatform: platform,
              assignedStoreCodeId: storeCodeId,
              redeemedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          },

          async createRedemption(token, redemption) {
            firestoreTransaction.create(db.collection("redemptions").doc(token), {
              ...redemption,
              redeemedAt: FieldValue.serverTimestamp(),
            });
            firestoreTransaction.create(db.collection("auditEvents").doc(), {
              type: "redemption_succeeded",
              claimToken: token,
              productPrefix: redemption.productPrefix,
              promotionPrefix: redemption.promotionPrefix,
              platform: redemption.platform,
              assignedStoreCodeId: redemption.assignedStoreCodeId,
              createdAt: FieldValue.serverTimestamp(),
            });
          },
        };

        return operation(transaction);
      });
    },
  };
}

export function expirationSortValue(expirationDate) {
  return expirationDate ? Timestamp.fromDate(expirationDate) : NEVER_EXPIRES;
}
