import { callPromoApi } from "/scripts/promo-api.js";

const platformDetails = Object.freeze({
  ios: {
    label: "iOS",
    instructions: "Open the App Store, select your account, then choose Redeem Gift Card or Code.",
  },
  macos: {
    label: "macOS",
    instructions: "Open the App Store on your Mac, select your account, then choose Redeem Gift Card.",
  },
  android: {
    label: "Android",
    instructions: "Open Google Play, select your profile, then choose Payments & subscriptions and Redeem code.",
  },
});

const elements = {
  initialState: document.querySelector("#state-initial"),
  validState: document.querySelector("#state-valid"),
  successState: document.querySelector("#state-success"),
  tokenForm: document.querySelector("#token-form"),
  tokenInput: document.querySelector("#claim-token"),
  tokenError: document.querySelector("#token-error"),
  continueButton: document.querySelector("#continue-button"),
  productName: document.querySelector("#product-name"),
  promotionName: document.querySelector("#promotion-name"),
  platformFieldset: document.querySelector("#platform-fieldset"),
  platformOptions: document.querySelector("#platform-options"),
  useAnotherToken: document.querySelector("#use-another-token"),
  redeemForm: document.querySelector("#redeem-form"),
  acknowledgement: document.querySelector("#one-time-acknowledgement"),
  redeemError: document.querySelector("#redeem-error"),
  revealButton: document.querySelector("#reveal-button"),
  successProduct: document.querySelector("#success-product"),
  successPlatform: document.querySelector("#success-platform"),
  instructions: document.querySelector("#platform-instructions"),
  revealedCode: document.querySelector("#revealed-code"),
  copyButton: document.querySelector("#copy-button"),
  copyStatus: document.querySelector("#copy-status"),
  serviceStatus: document.querySelector("#service-status"),
};

let validatedClaim = null;
let revealedCode = null;
let codeCopied = false;

function setBusy(button, busy, busyLabel, readyLabel) {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : readyLabel;
  button.setAttribute("aria-busy", String(busy));
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function showState(state) {
  elements.initialState.hidden = state !== "initial";
  elements.validState.hidden = state !== "valid";
  elements.successState.hidden = state !== "success";
}

function resetToInitial() {
  validatedClaim = null;
  elements.tokenInput.value = "";
  elements.acknowledgement.checked = false;
  elements.revealButton.disabled = true;
  elements.platformOptions.replaceChildren();
  showError(elements.tokenError, "");
  showError(elements.redeemError, "");
  showState("initial");
  elements.tokenInput.focus();
}

function renderPlatforms(platforms) {
  elements.platformOptions.replaceChildren();
  elements.platformFieldset.hidden = platforms.length === 1;

  for (const [index, platform] of platforms.entries()) {
    const details = platformDetails[platform];
    if (!details) continue;

    const label = document.createElement("label");
    label.className = "platform-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "platform";
    input.value = platform;
    input.checked = platforms.length === 1 || index === 0;
    const text = document.createElement("span");
    text.textContent = details.label;
    label.append(input, text);
    elements.platformOptions.append(label);
  }
}

function selectedPlatform() {
  return elements.redeemForm.elements.platform?.value ?? null;
}

elements.tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(elements.tokenError, "");
  const token = elements.tokenInput.value.trim();
  if (!token) {
    showError(elements.tokenError, "Enter the claim token from your card.");
    elements.tokenInput.focus();
    return;
  }

  setBusy(elements.continueButton, true, "Checking…", "Continue");
  elements.serviceStatus.textContent = "Checking your claim token…";
  try {
    validatedClaim = await callPromoApi("/validate", { body: { token } });
    elements.productName.textContent = validatedClaim.product.name;
    elements.promotionName.textContent = validatedClaim.promotion.name;
    renderPlatforms(validatedClaim.supportedPlatforms);
    elements.acknowledgement.checked = false;
    elements.revealButton.disabled = true;
    showState("valid");
    document.querySelector("#valid-heading").focus?.();
  } catch (error) {
    showError(elements.tokenError, error.message);
    elements.tokenInput.select();
  } finally {
    setBusy(elements.continueButton, false, "Checking…", "Continue");
    elements.serviceStatus.textContent = "";
  }
});

elements.acknowledgement.addEventListener("change", () => {
  elements.revealButton.disabled = !elements.acknowledgement.checked;
});

elements.useAnotherToken.addEventListener("click", resetToInitial);

elements.redeemForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(elements.redeemError, "");
  if (!validatedClaim || !elements.acknowledgement.checked) {
    showError(
      elements.redeemError,
      "Acknowledge the one-time display warning before revealing your code.",
    );
    return;
  }
  const platform = selectedPlatform();
  if (!platform) {
    showError(elements.redeemError, "Choose a platform before continuing.");
    return;
  }

  setBusy(elements.revealButton, true, "Assigning your code…", "Reveal My Promo Code");
  elements.serviceStatus.textContent = "Securely assigning your promo code…";
  try {
    const result = await callPromoApi("/redeem", {
      body: {
        token: validatedClaim.token,
        platform,
        acknowledged: true,
      },
      limitedUseAppCheck: true,
    });
    revealedCode = result.code;
    codeCopied = false;
    elements.revealedCode.textContent = revealedCode;
    elements.successProduct.textContent = result.productName;
    elements.successPlatform.textContent = platformDetails[result.platform].label;
    elements.instructions.textContent = platformDetails[result.platform].instructions;
    elements.copyStatus.textContent = "";
    elements.tokenInput.value = "";
    validatedClaim = null;
    showState("success");
    elements.revealedCode.focus();
  } catch (error) {
    showError(elements.redeemError, error.message);
    if (error.code === "already_redeemed") {
      elements.revealButton.disabled = true;
    }
  } finally {
    setBusy(elements.revealButton, false, "Assigning your code…", "Reveal My Promo Code");
    elements.revealButton.disabled =
      !elements.acknowledgement.checked || !elements.successState.hidden;
    elements.serviceStatus.textContent = "";
  }
});

elements.copyButton.addEventListener("click", async () => {
  if (!revealedCode) return;
  try {
    await navigator.clipboard.writeText(revealedCode);
    codeCopied = true;
    elements.copyStatus.textContent = "Copied";
    elements.copyButton.textContent = "Copied";
    window.setTimeout(() => {
      elements.copyButton.textContent = "Copy Code";
    }, 1800);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(elements.revealedCode);
    selection.removeAllRanges();
    selection.addRange(range);
    elements.copyStatus.textContent = "Select Copy from your browser to copy the highlighted code.";
  }
});

window.addEventListener("beforeunload", (event) => {
  if (revealedCode && !codeCopied) {
    event.preventDefault();
    event.returnValue = "";
  }
});
