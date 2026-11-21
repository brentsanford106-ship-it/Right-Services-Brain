import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./styles.css";
import { applyTheme } from "./lib/theme";
import { completeSignIn } from "./lib/entra";
import { session } from "./lib/api";

applyTheme();

// Coming back from Microsoft's sign-in page (/auth?code=...): finish signing in before showing anything.
void completeSignIn()
  .then((t) => t && session.setEntra(t))
  .catch((e: unknown) => session.signOutWith(e instanceof Error ? e.message : "Sign-in failed."))
  .finally(render);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
});

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
