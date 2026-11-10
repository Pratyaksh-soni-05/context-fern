// Bootstrap: `fern ui` opens this page at /ui#code=<one-time-code>. The
// raw daemon token never reaches the browser — only this 30-second,
// single-use code does. Read the fragment once, exchange it for an
// HttpOnly session cookie via POST /session, then strip the fragment
// from the visible URL/history immediately, win or lose — a code is
// consumed on first use either way, so leaving it in the URL would
// only ever show a dead value. See docs/decisions.md.

import { CLI_NAME } from "@context-fern/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ApiError, exchangeCode, listProjects } from "./api/client";
import { UI_COMMAND } from "./constants";

const COOKIE_BLOCKED_MESSAGE =
  "Your browser is blocking the session cookie for 127.0.0.1 — allow cookies for this site, or try a different browser.";

async function bootstrap(): Promise<void> {
  const hash = window.location.hash;
  const match = /^#code=(.+)$/.exec(hash);
  let authError: string | null = null;
  if (match?.[1]) {
    try {
      await exchangeCode(match[1]);
      // A successful exchange only means the daemon issued the cookie —
      // it doesn't guarantee the browser kept it. Some browsers/privacy
      // settings silently drop cookies for an IP-literal host like
      // 127.0.0.1, which looks identical to "nothing happened" from
      // here on out unless checked for directly.
      try {
        await listProjects();
      } catch {
        authError = COOKIE_BLOCKED_MESSAGE;
      }
    } catch (err) {
      // Falls through to render anyway — every data call will 403 and
      // the UI can show its own "not authenticated" state rather than
      // a blank page. Re-running `fern ui` mints a fresh code.
      authError =
        err instanceof ApiError
          ? err.message
          : `Couldn't reach the ${CLI_NAME} daemon. Run \`${UI_COMMAND}\` again.`;
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("#root element missing from index.html");

  createRoot(rootEl).render(
    <StrictMode>
      <App initialAuthError={authError} />
    </StrictMode>,
  );
}

void bootstrap();
