import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  ReCaptchaEnterpriseProvider,
  getLimitedUseToken,
  getToken,
  initializeAppCheck,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app-check.js";

import { promoConfig, promoServiceIsConfigured } from "/scripts/promo-config.js";

let firebaseApp;
let appCheck;

export function getPromoFirebaseApp() {
  if (!promoServiceIsConfigured()) {
    throw new Error("promo_service_not_configured");
  }
  firebaseApp ??= initializeApp(promoConfig.firebase);
  return firebaseApp;
}

async function appCheckHeaders(limitedUse) {
  if (!promoConfig.appCheckSiteKey) {
    return {};
  }
  appCheck ??= initializeAppCheck(getPromoFirebaseApp(), {
    provider: new ReCaptchaEnterpriseProvider(promoConfig.appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
  const tokenResult = limitedUse
    ? await getLimitedUseToken(appCheck)
    : await getToken(appCheck, false);
  return { "X-Firebase-AppCheck": tokenResult.token };
}

export async function callPromoApi(
  path,
  { method = "POST", body, authorization, limitedUseAppCheck = false } = {},
) {
  if (!promoServiceIsConfigured()) {
    const error = new Error("The redemption service has not been configured yet.");
    error.code = "service_not_configured";
    throw error;
  }

  let verificationHeaders;
  try {
    verificationHeaders = await appCheckHeaders(limitedUseAppCheck);
  } catch {
    const error = new Error(
      "The request could not be verified. Refresh the page and try again.",
    );
    error.code = "app_check_failed";
    throw error;
  }

  const headers = {
    Accept: "application/json",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
    ...verificationHeaders,
  };

  let response;
  try {
    response = await fetch(`${promoConfig.apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    const error = new Error(
      "The redemption service is temporarily unavailable. Please try again later.",
    );
    error.code = "network_error";
    throw error;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ?? "The request could not be completed.",
    );
    error.code = payload?.error?.code ?? "request_failed";
    error.status = response.status;
    throw error;
  }
  return payload?.data;
}
