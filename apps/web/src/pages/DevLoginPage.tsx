import { useQuery } from "@tanstack/react-query";
import type { DevUser } from "@rsb/contracts";
import { useState, useSyncExternalStore } from "react";
import { api, ApiRequestError, session } from "../lib/api";
import { entraConfig, startSignIn } from "../lib/entra";
import { DevBanner, Status } from "../components/ui";
import { Icon } from "../components/icons";
import { BRAND } from "../brand";

/**
 * Sign-in page. "Sign in" (shown once the VITE_ENTRA_* settings exist) goes to Microsoft's real sign-in.
 * "Development sign-in" picks a made-up test person; the server switches it off outside development.
 */
export function DevLoginPage() {
  const real = entraConfig() !== null;
  const notice = useSyncExternalStore(session.subscribe, () => session.notice);
  const users = useQuery({ queryKey: ["devUsers"], queryFn: () => api<{ warning: string; items: DevUser[] }>("/dev/auth/users") });
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const goReal = async () => {
    setError(null);
    setLeaving(true);
    try {
      await startSignIn();
    } catch (e) {
      setLeaving(false);
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    }
  };
  const signIn = async (subject: string) => {
    setError(null);
    try {
      const r = await api<{ accessToken: string }>("/dev/auth/token", { method: "POST", body: { subject } });
      session.set(r.accessToken, subject);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Sign-in failed.");
    }
  };
  return (
    <div className="signin">
      <DevBanner />
      <main className="signin-main">
        <div className="signin-card">
          <div className="brandbox"><img src={BRAND.logo} alt={BRAND.name} className="logo-full" /></div>
          {notice && <p className="error" role="alert">{notice}</p>}
          {real && (
            <section className="signin-real">
              <h1>Sign in</h1>
              <p className="muted">Use the email address your company owner added. Microsoft will send you a code.</p>
              <button className="primary big" disabled={leaving} onClick={() => void goReal()}>{leaving ? "Opening Microsoft…" : "Sign in"}</button>
            </section>
          )}
          <h1>Development sign-in</h1>
          <p className="muted">
            Pick a fictional user. In production this screen is replaced by Microsoft Entra External ID sign-in.
          </p>
          {error && <p className="error" role="alert">{error}</p>}
          <Status query={users}>
            {(d) => (
              <ul className="list">
                {d.items.map((u) => (
                  <li key={u.subject}>
                    <button className="row person-row" onClick={() => void signIn(u.subject)}>
                      <span className="initials" aria-hidden>{u.displayName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
                      <span className="person-text">
                        <strong>{u.displayName}</strong>
                        <span className="muted">{u.description}</span>
                      </span>
                      <Icon name="chevronRight" className="chev" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Status>
        </div>
        <p className="signin-tagline">{BRAND.tagline}</p>
      </main>
    </div>
  );
}
