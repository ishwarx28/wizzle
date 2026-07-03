import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import logoSrc from "./assets/brand/wizzle-logo.png";
import darkLogoSrc from "./assets/brand/wizzle-logo-dark.png";
import "./styles.css";
import {
  getStoredThemePreference,
  getThemeChangeEventName,
  initializeThemePreference,
  resolveEffectiveTheme,
} from "./utils/theme";

function applyPlatformClass() {
  const isMac = navigator.userAgent.toLowerCase().includes("mac");
  document.documentElement.dataset.platform = isMac ? "macos" : "default";
}

function applyFavicon() {
  const existingLink = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  const link = existingLink ?? document.createElement("link");

  const syncFavicon = () => {
    const effectiveTheme = resolveEffectiveTheme(getStoredThemePreference());
    link.href = effectiveTheme === "dark" ? darkLogoSrc : logoSrc;
  };

  link.rel = "icon";
  link.type = "image/png";

  if (!existingLink) {
    document.head.appendChild(link);
  }

  syncFavicon();
  window.addEventListener(getThemeChangeEventName(), syncFavicon);
}

applyPlatformClass();
initializeThemePreference();
applyFavicon();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
