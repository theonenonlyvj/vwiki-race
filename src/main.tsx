import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/luckiest-guy";
// Body face swapped Fredoka -> Merriweather (owner, 2026-08-15: the rounded
// terminals "seem almost like comic sans, which feels cheap for a wikipedia
// race"). Merriweather over the other candidates on measurable grounds, not
// taste: this UI lives at 0.68-0.86rem (uppercase kickers, small labels, a
// figures column), and Merriweather has the largest x-height of the
// shortlist (56% of em vs Literata's 51%, i.e. ~10% more legible at the
// same px), the lowest stroke contrast - which is what keeps a serif alive
// on the #061014 ground - and real `tnum` support, which the tabular
// figures columns depend on. Both are SIL OFL 1.1. Luckiest Guy (logo,
// Apache-2.0) is deliberately unchanged; the owner likes it.
import "@fontsource/merriweather/400.css";
import "@fontsource/merriweather/500.css";
import "@fontsource/merriweather/600.css";
import App from "./App";
import AppEntry from "./AppEntry";
import { ErrorBoundary } from "./ErrorBoundary";
import { resolveApiOrigin } from "./services/apiOrigin";
import { createErrorReporter } from "./services/errorReporting";
import "./styles.css";

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
