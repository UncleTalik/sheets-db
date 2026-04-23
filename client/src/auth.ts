import { SheetsDBError, type User } from "./types.js";

// Token is held in-memory only. Never written to localStorage/sessionStorage —
// Google ID tokens are short-lived and should be re-requested on reload.
interface AuthState {
  idToken: string | null;
  user: User | null;
}

export interface AuthController {
  signIn(): Promise<User>;
  signOut(): void;
  currentUser(): User | null;
  getIdToken(): string | null;
}

export function createAuth(googleClientId: string): AuthController {
  const state: AuthState = { idToken: null, user: null };

  function parseJwt(jwt: string): { email: string; name?: string } {
    const parts = jwt.split(".");
    if (parts.length !== 3) {
      throw new SheetsDBError("unauthorized", "malformed ID token");
    }
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    try {
      const json = atob(padded);
      return JSON.parse(json);
    } catch (err) {
      throw new SheetsDBError("unauthorized", "could not decode ID token");
    }
  }

  function requireGis(): NonNullable<Window["google"]> {
    if (typeof window === "undefined" || !window.google?.accounts?.id) {
      throw new SheetsDBError(
        "misconfigured",
        "Google Identity Services not loaded. Add <script src=\"https://accounts.google.com/gsi/client\" async defer> to your HTML.",
      );
    }
    return window.google;
  }

  return {
    async signIn(): Promise<User> {
      const gis = requireGis();
      return new Promise<User>((resolve, reject) => {
        try {
          gis.accounts.id.initialize({
            client_id: googleClientId,
            callback: (response) => {
              if (!response?.credential) {
                reject(new SheetsDBError("unauthorized", "no credential returned"));
                return;
              }
              state.idToken = response.credential;
              const claims = parseJwt(response.credential);
              state.user = { email: claims.email, name: claims.name ?? "" };
              resolve(state.user);
            },
          });
          gis.accounts.id.prompt((notification) => {
            if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
              const reason = notification.isNotDisplayed()
                ? notification.getNotDisplayedReason()
                : notification.getSkippedReason();
              reject(
                new SheetsDBError("unauthorized", "sign-in prompt dismissed: " + reason),
              );
            }
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    signOut() {
      state.idToken = null;
      state.user = null;
      if (typeof window !== "undefined" && window.google?.accounts?.id) {
        window.google.accounts.id.disableAutoSelect();
      }
    },

    currentUser() {
      return state.user;
    },

    getIdToken() {
      return state.idToken;
    },
  };
}
