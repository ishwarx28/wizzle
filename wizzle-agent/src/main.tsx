function showStartupError(rootElement: HTMLElement) {
  const panel = document.createElement("main");
  const title = document.createElement("h1");
  const description = document.createElement("p");
  const retryButton = document.createElement("button");

  panel.style.cssText =
    "align-items:center;background:#101010;color:#f5f5f5;display:flex;flex-direction:column;font:14px/20px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:100vh;justify-content:center;margin:0;padding:24px;text-align:center;";
  title.style.cssText = "font-size:18px;line-height:24px;margin:0;";
  title.textContent = "Wizzle could not open";
  description.style.cssText = "color:#b8b8b8;margin:8px 0 0;max-width:420px;";
  description.textContent = navigator.userAgent.toLowerCase().includes("windows")
    ? "The desktop interface did not load. Restart Wizzle, or retry after updating the Microsoft Edge WebView2 Runtime."
    : "The desktop interface did not load. Restart Wizzle and try again.";
  retryButton.style.cssText =
    "background:#f5f5f5;border:0;border-radius:999px;color:#111;cursor:pointer;font:600 14px/20px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin-top:20px;padding:8px 16px;";
  retryButton.textContent = "Retry";
  retryButton.type = "button";
  retryButton.addEventListener("click", () => window.location.reload());

  panel.append(title, description, retryButton);
  rootElement.replaceChildren(panel);
}

const rootElement = document.getElementById("root");

if (rootElement) {
  try {
    mountApp(rootElement);
  } catch (error) {
    console.error("Wizzle frontend startup failed", error);
    showStartupError(rootElement);
  }
}
import { mountApp } from "./bootstrap";
