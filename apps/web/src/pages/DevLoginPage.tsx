import { useQuery } from "@tanstack/react-query";
import type { DevUser } from "@rsb/contracts";
import { useState } from "react";
import { api, ApiRequestError, session } from "../lib/api";
import { DevBanner, Status } from "../components/ui";

export function DevLoginPage() {
  const users = useQuery({ queryKey: ["devUsers"], queryFn: () => api<{ warning: string; items: DevUser[] }>("/dev/auth/users") });
  const [error, setError] = useState<string | null>(null);
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
    <div className="shell center">
      <DevBanner />
      <main className="login">
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
                  <button className="row" onClick={() => void signIn(u.subject)}>
                    <strong>{u.displayName}</strong>
                    <span className="muted">{u.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Status>
      </main>
    </div>
  );
}
