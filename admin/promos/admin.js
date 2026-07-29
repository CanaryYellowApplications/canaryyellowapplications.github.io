import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

import { callPromoApi, getPromoFirebaseApp } from "/scripts/promo-api.js";

const byId = (id) => document.getElementById(id);
const authGate = byId("auth-gate");
const adminShell = byId("admin-shell");
const authError = byId("auth-error");
const globalStatus = byId("global-status");

let auth;
let currentUser;
let products = [];
let promotions = [];
let claimImportRequest = null;
let storeImportRequest = null;

const issueLabels = Object.freeze({
  malformed: "Malformed",
  invalid_issuer: "Issuer is not CYA",
  duplicate_in_import: "Duplicate in this import",
  duplicate_existing: "Already imported",
  unknown_product: "Unknown product prefix",
  unknown_promotion: "Unknown promotion prefix",
  invalid_product: "Invalid product",
  invalid_platform: "Invalid platform",
  invalid_expiration_date: "Invalid expiration date",
  unsupported_product_platform: "Platform is not supported by this product",
});

const platformLabels = Object.freeze({ ios: "iOS", macos: "macOS", android: "Android" });

function element(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function setAuthError(message) {
  authError.textContent = message ?? "";
  authError.hidden = !message;
}

function setStatus(message, isError = false) {
  globalStatus.textContent = message ?? "";
  globalStatus.style.color = isError ? "#8c2a13" : "#285b34";
}

async function withBusyButton(button, busyLabel, operation) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  button.setAttribute("aria-busy", "true");
  try {
    return await operation();
  } catch (error) {
    setStatus(error.message, true);
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    button.setAttribute("aria-busy", "false");
  }
}

async function adminApi(path, options = {}) {
  if (!currentUser) throw new Error("Sign in is required.");
  const authorization = await currentUser.getIdToken();
  try {
    return await callPromoApi(path, { ...options, authorization });
  } catch (error) {
    if (error.status === 401) {
      const refreshedAuthorization = await currentUser.getIdToken(true);
      return callPromoApi(path, { ...options, authorization: refreshedAuthorization });
    }
    throw error;
  }
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusPill(status) {
  return element("span", { className: `status-pill ${status}`, text: status });
}

function emptyRow(columnCount, message = "No records found.") {
  const row = element("tr");
  const cell = element("td", { className: "empty-row", text: message });
  cell.colSpan = columnCount;
  row.append(cell);
  return row;
}

function makeCell(content, className) {
  const cell = element("td", { className });
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content ?? "—";
  return cell;
}

function makeAction(label, action) {
  const button = element("button", { className: "row-action", text: label });
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

function refillSelect(select, items, firstLabel, labelFor = (item) => `${item.name} (${item.prefix})`) {
  const current = select.value;
  select.replaceChildren();
  const first = element("option", { text: firstLabel });
  first.value = "";
  select.append(first);
  for (const item of items) {
    const option = element("option", { text: labelFor(item) });
    option.value = item.prefix;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function loadConfiguration() {
  [products, promotions] = await Promise.all([
    adminApi("/admin/products", { method: "GET" }),
    adminApi("/admin/promotions", { method: "GET" }),
  ]);
  const productSelects = [
    [byId("claim-product-filter"), "All products"],
    [byId("store-import-product"), "Choose a product"],
    [byId("store-product-filter"), "All products"],
  ];
  for (const [select, label] of productSelects) refillSelect(select, products, label);
  refillSelect(byId("claim-promotion-filter"), promotions, "All promotions");
}

const metricLabels = Object.freeze({
  availableClaimTokens: "Available claim tokens",
  redeemedClaimTokens: "Redeemed claim tokens",
  disabledClaimTokens: "Disabled claim tokens",
  availableIosCodes: "Available iOS codes",
  availableMacosCodes: "Available macOS codes",
  availableAndroidCodes: "Available Android codes",
  codesExpiringSoon: "Codes expiring in 30 days",
  expiredCodes: "Expired codes",
});

async function loadOverview() {
  const metrics = await adminApi("/admin/overview", { method: "GET" });
  const container = byId("overview-metrics");
  container.replaceChildren();
  for (const [key, label] of Object.entries(metricLabels)) {
    const card = element("article", { className: "metric" });
    card.append(
      element("span", { className: "metric-value", text: String(metrics[key] ?? 0) }),
      element("span", { className: "metric-label", text: label }),
    );
    container.append(card);
  }
}

function resetProductForm() {
  byId("product-form").reset();
  byId("product-active-input").checked = true;
  byId("product-original-prefix").value = "";
  byId("product-prefix-input").disabled = false;
  byId("cancel-product-edit").hidden = true;
}

function editProduct(product) {
  byId("product-name-input").value = product.name;
  byId("product-prefix-input").value = product.prefix;
  byId("product-prefix-input").disabled = true;
  byId("product-original-prefix").value = product.prefix;
  byId("product-active-input").checked = product.isActive;
  for (const checkbox of document.querySelectorAll('[name="product-platform"]')) {
    checkbox.checked = product.supportedPlatforms.includes(checkbox.value);
  }
  byId("cancel-product-edit").hidden = false;
  byId("product-name-input").focus();
}

async function loadProducts() {
  products = await adminApi("/admin/products", { method: "GET" });
  const body = byId("products-table");
  body.replaceChildren();
  if (!products.length) body.append(emptyRow(5, "No products configured yet."));
  for (const product of products) {
    const row = element("tr");
    row.append(
      makeCell(product.name),
      makeCell(product.prefix, "mono"),
      makeCell(product.supportedPlatforms.map((value) => platformLabels[value] ?? value).join(", ")),
      makeCell(statusPill(product.isActive ? "active" : "disabled")),
      makeCell(makeAction("Edit", () => editProduct(product))),
    );
    body.append(row);
  }
  await loadConfiguration();
}

function resetPromotionForm() {
  byId("promotion-form").reset();
  byId("promotion-active-input").checked = true;
  byId("promotion-original-prefix").value = "";
  byId("promotion-prefix-input").disabled = false;
  byId("cancel-promotion-edit").hidden = true;
}

function editPromotion(promotion) {
  byId("promotion-name-input").value = promotion.name;
  byId("promotion-prefix-input").value = promotion.prefix;
  byId("promotion-prefix-input").disabled = true;
  byId("promotion-original-prefix").value = promotion.prefix;
  byId("promotion-active-input").checked = promotion.isActive;
  byId("cancel-promotion-edit").hidden = false;
  byId("promotion-name-input").focus();
}

async function loadPromotions() {
  promotions = await adminApi("/admin/promotions", { method: "GET" });
  const body = byId("promotions-table");
  body.replaceChildren();
  if (!promotions.length) body.append(emptyRow(4, "No promotions configured yet."));
  for (const promotion of promotions) {
    const row = element("tr");
    row.append(
      makeCell(promotion.name),
      makeCell(promotion.prefix, "mono"),
      makeCell(statusPill(promotion.isActive ? "active" : "disabled")),
      makeCell(makeAction("Edit", () => editPromotion(promotion))),
    );
    body.append(row);
  }
  await loadConfiguration();
}

function renderClaimPreview(preview) {
  byId("claim-preview").hidden = false;
  byId("claim-preview-summary").textContent = `${preview.summary.valid} valid · ${preview.summary.invalid} rejected · ${preview.summary.total} total`;
  byId("import-claims").disabled = preview.summary.valid === 0;
  const body = byId("claim-preview-table");
  body.replaceChildren();
  for (const item of preview.rows) {
    const result = item.issues.length
      ? item.issues.map((issue) => issueLabels[issue] ?? issue).join("; ")
      : "Ready to import";
    const row = element("tr");
    row.append(makeCell(String(item.row)), makeCell(item.token ?? item.raw, "mono"), makeCell(result));
    body.append(row);
  }
}

async function loadClaims() {
  const claims = await adminApi("/admin/claim-tokens/search", {
    body: {
      search: byId("claim-search").value,
      productPrefix: byId("claim-product-filter").value,
      promotionPrefix: byId("claim-promotion-filter").value,
      status: byId("claim-status-filter").value,
    },
  });
  const body = byId("claims-table");
  body.replaceChildren();
  if (!claims.length) body.append(emptyRow(6));
  for (const claim of claims) {
    const row = element("tr");
    const action = claim.status === "redeemed"
      ? "—"
      : makeAction(claim.status === "disabled" ? "Re-enable" : "Disable", async () => {
          const nextStatus = claim.status === "disabled" ? "available" : "disabled";
          if (nextStatus === "disabled" && !window.confirm(`Disable ${claim.token}?`)) return;
          try {
            await adminApi("/admin/claim-tokens/status", { body: { token: claim.token, status: nextStatus } });
            setStatus(`Claim token ${nextStatus === "disabled" ? "disabled" : "re-enabled"}.`);
            await Promise.all([loadClaims(), loadOverview()]);
          } catch (error) { setStatus(error.message, true); }
        });
    row.append(
      makeCell(claim.token, "mono"),
      makeCell(claim.productPrefix),
      makeCell(claim.promotionPrefix),
      makeCell(statusPill(claim.status)),
      makeCell(platformLabels[claim.selectedPlatform] ?? claim.selectedPlatform ?? "—"),
      makeCell(action),
    );
    body.append(row);
  }
}

function renderStorePreview(preview) {
  byId("store-preview").hidden = false;
  byId("store-preview-summary").textContent = `${preview.summary.valid} valid · ${preview.summary.invalid} rejected · ${preview.summary.total} total`;
  byId("import-store-codes").disabled = preview.summary.valid === 0;
  const body = byId("store-preview-table");
  body.replaceChildren();
  for (const item of preview.rows) {
    const result = item.issues.length
      ? item.issues.map((issue) => issueLabels[issue] ?? issue).join("; ")
      : "Ready to import";
    const row = element("tr");
    row.append(
      makeCell(String(item.row)),
      makeCell(item.maskedCode ?? "Invalid", "mono"),
      makeCell(item.productPrefix),
      makeCell(platformLabels[item.platform] ?? item.platform),
      makeCell(item.expirationDate ? formatDate(item.expirationDate) : "No expiration"),
      makeCell(result),
    );
    body.append(row);
  }
}

async function loadStoreCodes() {
  const codes = await adminApi("/admin/store-codes/search", {
    body: {
      search: byId("store-search").value,
      productPrefix: byId("store-product-filter").value,
      platform: byId("store-platform-filter").value,
      status: byId("store-status-filter").value,
    },
  });
  const body = byId("store-codes-table");
  body.replaceChildren();
  if (!codes.length) body.append(emptyRow(7));
  for (const code of codes) {
    const action = ["assigned", "expired"].includes(code.status)
      ? "—"
      : makeAction(code.status === "disabled" ? "Re-enable" : "Disable", async () => {
          const nextStatus = code.status === "disabled" ? "available" : "disabled";
          if (nextStatus === "disabled" && !window.confirm(`Disable ${code.maskedCode}?`)) return;
          try {
            await adminApi("/admin/store-codes/status", { body: { id: code.id, status: nextStatus } });
            setStatus(`Store code ${nextStatus === "disabled" ? "disabled" : "re-enabled"}.`);
            await Promise.all([loadStoreCodes(), loadOverview()]);
          } catch (error) { setStatus(error.message, true); }
        });
    const row = element("tr");
    row.append(
      makeCell(code.maskedCode, "mono"),
      makeCell(code.productPrefix),
      makeCell(platformLabels[code.platform] ?? code.platform),
      makeCell(code.expirationDate ? formatDate(code.expirationDate) : "No expiration"),
      makeCell(statusPill(code.status)),
      makeCell(code.assignedClaimToken ?? "—", "mono"),
      makeCell(action),
    );
    body.append(row);
  }
}

async function loadRedemptions() {
  const redemptions = await adminApi("/admin/redemptions/search", {
    body: {
      search: byId("redemption-search").value,
      platform: byId("redemption-platform-filter").value,
    },
  });
  const body = byId("redemptions-table");
  body.replaceChildren();
  if (!redemptions.length) body.append(emptyRow(6));
  for (const redemption of redemptions) {
    const row = element("tr");
    row.append(
      makeCell(redemption.claimToken, "mono"),
      makeCell(redemption.productName),
      makeCell(redemption.promotionName),
      makeCell(platformLabels[redemption.platform] ?? redemption.platform),
      makeCell(formatDate(redemption.redeemedAt)),
      makeCell(redemption.assignedStoreCodeId, "mono"),
    );
    body.append(row);
  }
}

async function loadPanel(panel) {
  setStatus("");
  if (panel === "overview") await loadOverview();
  if (panel === "products") await loadProducts();
  if (panel === "promotions") await loadPromotions();
  if (panel === "claim-tokens") { await loadConfiguration(); await loadClaims(); }
  if (panel === "store-codes") { await loadConfiguration(); await loadStoreCodes(); }
  if (panel === "redemptions") await loadRedemptions();
}

for (const button of document.querySelectorAll(".tab-button")) {
  button.addEventListener("click", async () => {
    for (const tab of document.querySelectorAll(".tab-button")) tab.classList.toggle("is-active", tab === button);
    for (const panel of document.querySelectorAll(".admin-panel")) panel.hidden = panel.id !== `panel-${button.dataset.panel}`;
    try { await loadPanel(button.dataset.panel); }
    catch (error) { setStatus(error.message, true); }
  });
}

byId("refresh-overview").addEventListener("click", async (event) => {
  try { await withBusyButton(event.currentTarget, "Refreshing…", loadOverview); setStatus("Overview refreshed."); }
  catch { /* status is set by the helper */ }
});

byId("product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  try {
    await withBusyButton(button, "Saving…", async () => {
      const supportedPlatforms = [...document.querySelectorAll('[name="product-platform"]:checked')].map((input) => input.value);
      await adminApi("/admin/products", { body: {
        name: byId("product-name-input").value,
        prefix: byId("product-prefix-input").value,
        originalPrefix: byId("product-original-prefix").value || null,
        supportedPlatforms,
        isActive: byId("product-active-input").checked,
      } });
      resetProductForm();
      await loadProducts();
      setStatus("Product saved.");
    });
  } catch { /* status is set by the helper */ }
});
byId("cancel-product-edit").addEventListener("click", resetProductForm);

byId("promotion-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  try {
    await withBusyButton(button, "Saving…", async () => {
      await adminApi("/admin/promotions", { body: {
        name: byId("promotion-name-input").value,
        prefix: byId("promotion-prefix-input").value,
        originalPrefix: byId("promotion-original-prefix").value || null,
        isActive: byId("promotion-active-input").checked,
      } });
      resetPromotionForm();
      await loadPromotions();
      setStatus("Promotion saved.");
    });
  } catch { /* status is set by the helper */ }
});
byId("cancel-promotion-edit").addEventListener("click", resetPromotionForm);

async function readFileInto(fileInput, textarea, formatSelect) {
  const file = fileInput.files?.[0];
  if (!file) return;
  textarea.value = await file.text();
  formatSelect.value = file.name.toLowerCase().endsWith(".csv") ? "csv" : "text";
}

byId("claim-import-file").addEventListener("change", () => readFileInto(byId("claim-import-file"), byId("claim-import-content"), byId("claim-import-format")));
byId("store-import-file").addEventListener("change", () => readFileInto(byId("store-import-file"), byId("store-import-content"), byId("store-import-format")));

byId("preview-claims").addEventListener("click", async (event) => {
  claimImportRequest = { content: byId("claim-import-content").value, format: byId("claim-import-format").value };
  try { await withBusyButton(event.currentTarget, "Checking…", async () => renderClaimPreview(await adminApi("/admin/claim-tokens/preview", { body: claimImportRequest }))); }
  catch { byId("claim-preview").hidden = true; }
});

byId("import-claims").addEventListener("click", async (event) => {
  if (!claimImportRequest) return;
  try {
    await withBusyButton(event.currentTarget, "Importing…", async () => {
      const result = await adminApi("/admin/claim-tokens/import", { body: { ...claimImportRequest, confirmed: true } });
      setStatus(`${result.imported} claim token${result.imported === 1 ? "" : "s"} imported.`);
      byId("claim-import-content").value = "";
      byId("claim-import-file").value = "";
      byId("claim-preview").hidden = true;
      claimImportRequest = null;
      await Promise.all([loadClaims(), loadOverview()]);
    });
  } catch { /* status is set by the helper */ }
});

byId("search-claims").addEventListener("click", async (event) => {
  try { await withBusyButton(event.currentTarget, "Searching…", loadClaims); }
  catch { /* status is set by the helper */ }
});

byId("store-import-product").addEventListener("change", () => {
  const product = products.find((item) => item.prefix === byId("store-import-product").value);
  for (const option of byId("store-import-platform").options) {
    option.disabled = option.value && product && !product.supportedPlatforms.includes(option.value);
  }
  if (byId("store-import-platform").selectedOptions[0]?.disabled) byId("store-import-platform").value = "";
});

byId("preview-store-codes").addEventListener("click", async (event) => {
  storeImportRequest = {
    content: byId("store-import-content").value,
    format: byId("store-import-format").value,
    productPrefix: byId("store-import-product").value,
    platform: byId("store-import-platform").value,
    expirationDate: byId("store-import-expiration").value || null,
  };
  try { await withBusyButton(event.currentTarget, "Checking…", async () => renderStorePreview(await adminApi("/admin/store-codes/preview", { body: storeImportRequest }))); }
  catch { byId("store-preview").hidden = true; }
});

byId("import-store-codes").addEventListener("click", async (event) => {
  if (!storeImportRequest) return;
  try {
    await withBusyButton(event.currentTarget, "Importing…", async () => {
      const result = await adminApi("/admin/store-codes/import", { body: { ...storeImportRequest, confirmed: true } });
      setStatus(`${result.imported} store code${result.imported === 1 ? "" : "s"} imported.`);
      byId("store-import-content").value = "";
      byId("store-import-file").value = "";
      byId("store-preview").hidden = true;
      storeImportRequest = null;
      await Promise.all([loadStoreCodes(), loadOverview()]);
    });
  } catch { /* status is set by the helper */ }
});

byId("search-store-codes").addEventListener("click", async (event) => {
  try { await withBusyButton(event.currentTarget, "Searching…", loadStoreCodes); }
  catch { /* status is set by the helper */ }
});
byId("search-redemptions").addEventListener("click", async (event) => {
  try { await withBusyButton(event.currentTarget, "Searching…", loadRedemptions); }
  catch { /* status is set by the helper */ }
});

byId("sign-in-button").addEventListener("click", async (event) => {
  setAuthError("");
  try {
    if (!auth) auth = getAuth(getPromoFirebaseApp());
    await withBusyButton(event.currentTarget, "Signing in…", () => signInWithPopup(auth, new GoogleAuthProvider()));
  } catch (error) {
    setAuthError(error.code === "service_not_configured" ? error.message : "Sign-in could not be completed.");
  }
});

byId("sign-out-button").addEventListener("click", () => signOut(auth));

try {
  auth = getAuth(getPromoFirebaseApp());
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    authGate.hidden = Boolean(user);
    adminShell.hidden = !user;
    setAuthError("");
    if (!user) return;
    byId("admin-email").textContent = user.email ?? "Authorized administrator";
    try {
      await Promise.all([loadConfiguration(), loadOverview()]);
    } catch (error) {
      if (error.status === 403) {
        await signOut(auth);
        setAuthError("This Google account is not authorized to manage promo codes.");
      } else {
        setStatus(error.message, true);
      }
    }
  });
} catch (error) {
  setAuthError(error.message);
}
