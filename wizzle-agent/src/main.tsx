import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import logoSrc from "./assets/brand/wizzle-logo.png";
import darkLogoSrc from "./assets/brand/wizzle-logo-dark.png";
import "./styles.css";

function applyPlatformClass() {
  const isMac = navigator.userAgent.toLowerCase().includes("mac");
  document.documentElement.dataset.platform = isMac ? "macos" : "default";
}

function applyFavicon() {
  const existingLink = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  const link = existingLink ?? document.createElement("link");
  const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");

  const syncFavicon = () => {
    link.href = darkModeQuery.matches ? darkLogoSrc : logoSrc;
  };

  link.rel = "icon";
  link.type = "image/png";

  if (!existingLink) {
    document.head.appendChild(link);
  }

  syncFavicon();
  darkModeQuery.addEventListener("change", syncFavicon);
}

applyPlatformClass();
applyFavicon();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
