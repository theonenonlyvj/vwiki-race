import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/luckiest-guy";
import "@fontsource/fredoka/400.css";
import "@fontsource/fredoka/500.css";
import "@fontsource/fredoka/600.css";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { resolveApiOrigin } from "./services/apiOrigin";
import { createErrorReporter } from "./services/errorReporting";
import "./styles.css";

const apiOrigin = resolveApiOrigin(import.meta.env.VITE_VWIKI_RACE_API_URL, {
  production: import.meta.env.PROD,
});
const errorReporter = createErrorReporter({ apiOrigin });
errorReporter.installGlobalHandlers(window);

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary reporter={errorReporter}>
      {/* LR-2: reuses the SAME reporter instance as ErrorBoundary above,
          rather than App standing up a second one, so identity retry-ladder
          exhaustion telemetry lands in the same beacon stream. */}
      <App errorReporter={errorReporter} />
    </ErrorBoundary>
  </StrictMode>,
);
