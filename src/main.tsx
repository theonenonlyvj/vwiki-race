import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/luckiest-guy";
import "@fontsource-variable/manrope";
import App from "./App";
import AppEntry from "./AppEntry";
import { ErrorBoundary } from "./ErrorBoundary";
import { resolveApiOrigin } from "./services/apiOrigin";
import { createErrorReporter } from "./services/errorReporting";
import "./styles.css";
import "./atlas.css";

const ResetPassword = lazy(() => import("./components/ResetPassword"));

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
      <AppEntry recoveryScreen={
        <Suspense fallback={<p role="status">Opening password reset…</p>}>
          <ResetPassword apiOrigin={window.location.origin} onDone={() => window.location.assign("/")} />
        </Suspense>
      }>
        <App errorReporter={errorReporter} />
      </AppEntry>
    </ErrorBoundary>
  </StrictMode>,
);
