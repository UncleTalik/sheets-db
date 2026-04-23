import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth.js";
import { SheetsDBError } from "../src/types.js";

// Minimal JWT for a user@example.com — unsigned (we only decode the payload).
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.fake-signature`;
}

type InitConfig = {
  client_id: string;
  callback: (response: { credential: string }) => void;
};

type PromptListener = (notification: {
  isNotDisplayed: () => boolean;
  isSkippedMoment: () => boolean;
  getNotDisplayedReason: () => string;
  getSkippedReason: () => string;
}) => void;

describe("auth (GIS wrapper)", () => {
  let storageSetItemSpy: ReturnType<typeof vi.spyOn<Storage, "setItem">>;
  let initializeMock: ReturnType<typeof vi.fn>;
  let promptMock: ReturnType<typeof vi.fn>;
  let disableAutoSelectMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // localStorage and sessionStorage both inherit setItem from Storage.prototype,
    // so spying there catches both.
    storageSetItemSpy = vi.spyOn(Storage.prototype, "setItem");
    initializeMock = vi.fn();
    promptMock = vi.fn();
    disableAutoSelectMock = vi.fn();
    (window as unknown as { google: unknown }).google = {
      accounts: {
        id: {
          initialize: initializeMock,
          prompt: promptMock,
          disableAutoSelect: disableAutoSelectMock,
        },
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { google?: unknown }).google;
    vi.restoreAllMocks();
  });

  it("signIn resolves with the user from the JWT payload", async () => {
    const jwt = makeJwt({ email: "user@example.com", name: "Test User" });
    initializeMock.mockImplementation((config: InitConfig) => {
      setTimeout(() => config.callback({ credential: jwt }), 0);
    });

    const auth = createAuth("client-id.apps.googleusercontent.com");
    const user = await auth.signIn();

    expect(user).toEqual({ email: "user@example.com", name: "Test User" });
    expect(auth.currentUser()).toEqual(user);
    expect(auth.getIdToken()).toBe(jwt);
  });

  it("never writes the token to localStorage or sessionStorage", async () => {
    const jwt = makeJwt({ email: "user@example.com", name: "Test User" });
    initializeMock.mockImplementation((config: InitConfig) => {
      setTimeout(() => config.callback({ credential: jwt }), 0);
    });

    const auth = createAuth("client-id");
    await auth.signIn();

    // If any setItem call ever contained the token, fail loudly.
    for (const call of storageSetItemSpy.mock.calls) {
      expect(String(call[1])).not.toContain(jwt);
    }
  });

  it("signOut clears user + token and calls disableAutoSelect", async () => {
    const jwt = makeJwt({ email: "user@example.com", name: "Test User" });
    initializeMock.mockImplementation((config: InitConfig) => {
      setTimeout(() => config.callback({ credential: jwt }), 0);
    });

    const auth = createAuth("client-id");
    await auth.signIn();
    auth.signOut();

    expect(auth.currentUser()).toBeNull();
    expect(auth.getIdToken()).toBeNull();
    expect(disableAutoSelectMock).toHaveBeenCalled();
  });

  it("throws misconfigured if GIS is not loaded", async () => {
    delete (window as unknown as { google?: unknown }).google;
    const auth = createAuth("client-id");
    await expect(auth.signIn()).rejects.toBeInstanceOf(SheetsDBError);
    await expect(auth.signIn()).rejects.toMatchObject({ code: "misconfigured" });
  });

  it("rejects if GIS prompt is skipped or not displayed", async () => {
    initializeMock.mockImplementation(() => void 0);
    promptMock.mockImplementation((listener: PromptListener) => {
      listener({
        isNotDisplayed: () => true,
        isSkippedMoment: () => false,
        getNotDisplayedReason: () => "opt_out_or_no_session",
        getSkippedReason: () => "",
      });
    });

    const auth = createAuth("client-id");
    await expect(auth.signIn()).rejects.toMatchObject({ code: "unauthorized" });
  });
});
