import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  assertFails,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const projectId = "cya-promo-rules-test";
let environment;

test.before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: await readFile(new URL("../../firestore.rules", import.meta.url), "utf8"),
    },
  });
});

test.after(async () => {
  await environment?.cleanup();
});

test("public users cannot read claim tokens or store codes", async () => {
  const database = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(database, "claimTokens", "CYA-SSM-FREE-7X4M9Q2K")));
  await assertFails(getDoc(doc(database, "storeCodes", "code-1")));
});

test("authenticated clients cannot bypass the trusted backend", async () => {
  const database = environment
    .authenticatedContext("admin-1", { promoAdmin: true })
    .firestore();
  await assertFails(
    setDoc(doc(database, "products", "SSM"), {
      prefix: "SSM",
      name: "ScreenGlow Mobile",
    }),
  );
  assert.ok(true);
});
