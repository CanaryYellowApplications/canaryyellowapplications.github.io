// Firebase Web configuration contains public identifiers, not secrets.
export const promoConfig = Object.freeze({
  apiBaseUrl: "https://us-west1-cya-promo-redemption.cloudfunctions.net/promoApi",
  firebase: Object.freeze({
    apiKey: "AIzaSyBFuPeugrv9ViFgBpPq5lnyk99j7hniMDI",
    authDomain: "cya-promo-redemption.firebaseapp.com",
    projectId: "cya-promo-redemption",
    appId: "1:1077139467790:web:33c3e1016fa2a49360965f",
  }),
  appCheckSiteKey: "",
});

export function promoServiceIsConfigured() {
  return !Object.values(promoConfig.firebase).some((value) =>
    String(value).includes("REPLACE_"),
  );
}
