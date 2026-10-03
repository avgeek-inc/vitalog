import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiKeyPage } from "./api-key-page";
import { OAuthPage } from "./oauth-page";
import "./styles.css";

const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  document.documentElement.classList.toggle("dark", colorScheme.matches);
  document.documentElement.classList.toggle("light", !colorScheme.matches);
}
applyTheme();
colorScheme.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname === "/oauth/authorize" ? (
      <OAuthPage />
    ) : (
      <ApiKeyPage />
    )}
  </StrictMode>,
);
