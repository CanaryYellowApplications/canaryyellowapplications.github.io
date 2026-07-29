import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

import { callPromoApi, getPromoFirebaseApp } from "/scripts/promo-api.js";

const status = document.getElementById("connect-status");
const error = document.getElementById("connect-error");
const authorizeButton = document.getElementById("authorize-button");
const cancelButton = document.getElementById("cancel-button");
const query = new URLSearchParams(window.location.search);
const request = Object.freeze({
  state: query.get("state") ?? "",
  codeChallenge: query.get("challenge") ?? "",
  callbackPort: Number(query.get("port")),
});

let currentUser = null;

function requestIsValid() {
  return (
    /^[A-Za-z0-9_-]{24,128}$/.test(request.state) &&
    /^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge) &&
    Number.isInteger(request.callbackPort) &&
    request.callbackPort >= 1024 &&
    request.callbackPort <= 65535
  );
}

function callbackUrl(parameters) {
  const callback = new URL(`http://127.0.0.1:${request.callbackPort}/callback`);
  for (const [key, value] of Object.entries(parameters)) {
    callback.searchParams.set(key, value);
  }
  return callback.toString();
}

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
  status.textContent = "";
}

async function authorize() {
  authorizeButton.disabled = true;
  cancelButton.disabled = true;
  showError("");
  try {
    if (!currentUser) {
      status.textContent = "Waiting for Google sign-in…";
      const credential = await signInWithPopup(
        getAuth(getPromoFirebaseApp()),
        new GoogleAuthProvider(),
      );
      currentUser = credential.user;
    }
    status.textContent = "Authorizing Claim Token Manager…";
    const authorization = await currentUser.getIdToken();
    const result = await callPromoApi("/admin/desktop/authorize", {
      authorization,
      body: request,
    });
    status.textContent = "Authorization complete. Returning to Claim Token Manager…";
    window.location.assign(
      callbackUrl({ code: result.code, state: result.state }),
    );
  } catch (caught) {
    showError(caught?.message ?? "Claim Token Manager could not be authorized.");
    authorizeButton.disabled = false;
    cancelButton.disabled = false;
  }
}

if (!requestIsValid()) {
  showError("This connection request is invalid or has expired. Return to Claim Token Manager and try again.");
  authorizeButton.disabled = true;
  cancelButton.disabled = true;
} else {
  const auth = getAuth(getPromoFirebaseApp());
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    authorizeButton.textContent = user ? "Authorize Claim Token Manager" : "Sign in and authorize";
  });
}

authorizeButton.addEventListener("click", authorize);
cancelButton.addEventListener("click", () => {
  window.location.assign(callbackUrl({ error: "access_denied", state: request.state }));
});
