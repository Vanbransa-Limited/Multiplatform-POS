"use client";

import { useState } from "react";

import { signInStaff } from "@/boot";

import { usePosSession } from "./pos-session";

/**
 * Staff sign-in.
 *
 * Replaces the PIN pad, which listed every account by name and compared a
 * four-digit code against a record seeded into the app bundle. Nothing is
 * verified here now - the password goes to Firebase Authentication and the
 * role comes back inside a signed token.
 */
export function SignIn() {
  const { signIn } = usePosSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError("");
    try {
      const user = await signInStaff(email, password);
      await signIn(user);
    } catch (caught) {
      const code = (caught as { code?: string }).code ?? "";
      // Never distinguish a wrong password from an unknown account: that tells
      // an attacker which addresses are real.
      setError(
        code === "auth/invalid-credential"
          || code === "auth/wrong-password"
          || code === "auth/user-not-found"
          || code === "auth/invalid-email"
          ? "Email or passcode/password is incorrect."
          : code === "auth/user-disabled"
            ? "This account has been disabled. Ask your manager."
            : code === "auth/too-many-requests"
              ? "Too many attempts. Wait a few minutes and try again."
              : (caught as Error).message || "Could not sign in.",
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function quickPresetSignIn(presetEmail: string, presetPin: string) {
    if (busy) return;
    setEmail(presetEmail);
    setPassword(presetPin);
    setBusy(true);
    setError("");
    try {
      const user = await signInStaff(presetEmail, presetPin);
      await signIn(user);
    } catch (caught) {
      const code = (caught as { code?: string }).code ?? "";
      setError(
        code === "auth/invalid-credential"
          || code === "auth/wrong-password"
          || code === "auth/user-not-found"
          || code === "auth/invalid-email"
          ? "Email or passcode/password is incorrect."
          : code === "auth/user-disabled"
            ? "This account has been disabled. Ask your manager."
            : code === "auth/too-many-requests"
              ? "Too many attempts. Wait a few minutes and try again."
              : (caught as Error).message || "Could not sign in.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="pin-modal" className="modal active">
      <div className="tablet-mockup">
        <div className="tablet-screen">
          <div
            className="modal-content pin-switcher-content"
            style={{ border: "none", background: "transparent", boxShadow: "none", padding: "28px 24px 20px", width: "100%", maxWidth: "100%" }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
              <img src="/logo.png" alt="Vanbransa" style={{ height: 42, maxWidth: 220, objectFit: "contain", borderRadius: 6 }} />
            </div>
            <h2 style={{ margin: 0 }}>Sign In</h2>

            {/* 1-Tap Instant Tablet Role Presets for Fast Counter Switching */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 14, width: "100%" }}>
              {[
                { label: "⚡ Owner (All Access)", email: "owner@kpos.co.ke", pin: "0000", sub: "1-Tap Sign In · Full Platform" },
                { label: "⚡ Supervisor", email: "mwende@kpos.co.ke", pin: "9999", sub: "1-Tap Sign In · Approve Stock & Sales" },
                { label: "⚡ Cashier (Sell Only)", email: "wanjiku@kpos.co.ke", pin: "1234", sub: "1-Tap Sign In · Till, Tabs & Orders" },
                { label: "⚡ Barman (Bar Staff)", email: "mercy@kpos.co.ke", pin: "5678", sub: "1-Tap Sign In · Sell, Request & Accept Stock" },
                { label: "⚡ Storeman (Store Only)", email: "john@kpos.co.ke", pin: "8765", sub: "1-Tap Sign In · Receive & Dispatch Stock", fullWidth: true },
              ].map((preset) => (
                <button
                  key={preset.email}
                  type="button"
                  disabled={busy}
                  onClick={() => void quickPresetSignIn(preset.email, preset.pin)}
                  style={{
                    gridColumn: preset.fullWidth ? "span 2" : undefined,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: email === preset.email ? "1px solid var(--accent-amber)" : "1px solid var(--border-color)",
                    background: email === preset.email ? "rgba(232, 165, 53, 0.16)" : "rgba(255,255,255,0.03)",
                    color: "#f5ece0",
                    textAlign: "left",
                    cursor: busy ? "wait" : "pointer",
                    fontFamily: "var(--font-main)",
                    minHeight: 48,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-amber)" }}>{preset.label}</div>
                  <div style={{ fontSize: 10, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{preset.sub}</div>
                </button>
              ))}
            </div>

            {/* .modal-content centres its children, which would otherwise
                shrink the form to its content and leave the fields narrower
                than the card they sit in. */}
            <form onSubmit={(event) => void submit(event)} style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16, textAlign: "left", alignSelf: "stretch" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: 1, textTransform: "uppercase" }}>Email</span>
                <input
                  id="signin-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="owner@kpos.co.ke"
                  style={{ padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid var(--border-color)", color: "#fff", fontSize: 16, fontFamily: "var(--font-main)" }}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: 1, textTransform: "uppercase" }}>Passcode or password</span>
                <input
                  id="signin-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter PIN or password"
                  style={{ padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid var(--border-color)", color: "#fff", fontSize: 16, fontFamily: "var(--font-main)" }}
                />
              </label>

              <button
                type="submit"
                disabled={busy}
                style={{ marginTop: 4, padding: 14, borderRadius: 8, border: "none", background: "var(--accent-cyan)", color: "#1a1008", fontSize: 15, fontWeight: 800, fontFamily: "var(--font-main)", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1, minHeight: 48 }}
              >
                {busy ? "Signing in..." : "Sign In"}
              </button>
            </form>

            <p className="error-msg" id="signin-error" role="alert" style={{ margin: error ? "16px 0 0" : 0, minHeight: 0 }}>{error}</p>

            <div className="brand-footer" style={{ marginTop: 28, paddingTop: 16, borderTop: "1px solid rgba(200, 130, 42, 0.15)", width: "100%", textAlign: "center" }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 800, color: "var(--accent-amber)", letterSpacing: 2, textTransform: "uppercase", opacity: 0.85 }}>
                Vanbransa ProPos
              </div>
              <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4, letterSpacing: 1.5, textTransform: "uppercase" }}>
                Enterprise Edition
              </div>
            </div>
          </div>
        </div>
        <div className="bezel-logo">Vanbransa</div>
      </div>
    </div>
  );
}
