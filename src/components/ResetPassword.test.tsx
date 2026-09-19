import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResetPassword from "./ResetPassword";

const resetToken = "A".repeat(43);

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("ResetPassword", () => {
  it("captures the fragment once, clears it in Strict Mode, and locks duplicate submissions", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => request);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/#reset-password=${resetToken}`);

    render(
      <StrictMode>
        <ResetPassword apiOrigin="https://game.example" onDone={vi.fn()} />
      </StrictMode>,
    );

    await waitFor(() => expect(window.location.hash).toBe(""));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "better-password");
    await user.type(screen.getByLabelText("Confirm new password"), "better-password");
    const form = screen.getByLabelText("New password").closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://game.example/api/v2/identity/password-reset",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      token: resetToken,
      password: "better-password",
    });
    expect(screen.getByRole("button", { name: /resetting password/i })).toBeDisabled();

    resolveRequest(Response.json({ ok: true }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /password reset.*log in with your new password/i,
    );
  });

  it("validates password length and confirmation before sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/#reset-password=${resetToken}`);
    render(<ResetPassword apiOrigin="" onDone={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "other");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/between 6 and 128 characters/i);

    await user.clear(screen.getByLabelText("New password"));
    await user.type(screen.getByLabelText("New password"), "long-enough");
    await user.clear(screen.getByLabelText("Confirm new password"));
    await user.type(screen.getByLabelText("Confirm new password"), "does-not-match");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/passwords do not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_or_expired_reset", "invalid, expired, or already used"],
    ["invalid_password", "between 6 and 128 characters"],
    ["password_reset_rate_limited", "too many reset attempts"],
    ["password_recovery_unavailable", "temporarily unavailable"],
  ])("shows a useful %s response", async (code, copy) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { code, message: "server detail" },
    }, { status: code === "password_recovery_unavailable" ? 503 : 400 })));
    window.history.replaceState(null, "", `/#reset-password=${resetToken}`);
    render(<ResetPassword apiOrigin="" onDone={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "better-password");
    await user.type(screen.getByLabelText("Confirm new password"), "better-password");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(new RegExp(copy, "i"));
  });

  it("handles a malformed link and returns to the game without making a request", async () => {
    const onDone = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/#reset-password=not-a-token");
    render(<ResetPassword apiOrigin="" onDone={onDone} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/invalid or incomplete/i);
    expect(screen.queryByLabelText("New password")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to game" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(window.location.hash).toBe(""));
  });

  it("shows a connectivity failure and lets the user retry", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/#reset-password=${resetToken}`);
    render(<ResetPassword apiOrigin="" onDone={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "better-password");
    await user.type(screen.getByLabelText("Confirm new password"), "better-password");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/i);

    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/password reset/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
