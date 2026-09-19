import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminPasswordReset from "./AdminPasswordReset";

const issuedToken = "B".repeat(43);
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

describe("AdminPasswordReset", () => {
  it("issues one reviewed link with bearer authorization and locks duplicate submissions", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => request);
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPasswordReset apiOrigin="https://game.example" token="owner-jwt" />);
    await userEvent.type(screen.getByLabelText("VGames username"), "Casey");
    const form = screen.getByLabelText("VGames username").closest("form") as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://game.example/api/v2/admin/password-resets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer owner-jwt" }),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ username: "casey" });
    expect(screen.getByRole("button", { name: /creating reset link/i })).toBeDisabled();

    resolveRequest(Response.json({
      username: "casey",
      resetToken: issuedToken,
      maxAgeSeconds: 604_800,
    }));
    const link = await screen.findByLabelText("Password reset link");
    expect(link).toHaveValue(`${window.location.origin}/#reset-password=${issuedToken}`);
    expect(link).toHaveAttribute("readonly");
    expect(screen.getByText(/expires in 7 days/i)).toBeVisible();
    expect(screen.getByText(/creating another link.*invalidates this one/i)).toBeVisible();
    expect(window.location.hash).toBe("");
  });

  it("requires a username before issuing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPasswordReset apiOrigin="" token="owner-jwt" />);

    await userEvent.click(screen.getByRole("button", { name: "Create reset link" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/enter a VGames username/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, "account_not_found", "no claimed VGames account"],
    [403, "forbidden", "not authorized"],
    [429, "daily_admin_rate_limited", "too many reset links"],
    [503, "password_recovery_unavailable", "temporarily unavailable"],
  ])("maps a %s %s response", async (status, code, copy) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { code, message: "server detail" },
    }, { status })));
    render(<AdminPasswordReset apiOrigin="" token="owner-jwt" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("VGames username"), "casey");
    await user.click(screen.getByRole("button", { name: "Create reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(new RegExp(copy, "i"));
    expect(screen.queryByLabelText("Password reset link")).toBeNull();
  });

  it("copies the link when allowed and always leaves a manual readonly fallback", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      username: "casey",
      resetToken: issuedToken,
      maxAgeSeconds: 604_800,
    })));
    render(<AdminPasswordReset apiOrigin="" token="owner-jwt" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("VGames username"), "casey");
    await user.click(screen.getByRole("button", { name: "Create reset link" }));
    const link = await screen.findByLabelText("Password reset link");
    // userEvent installs its own clipboard shim during setup. Replace it
    // after setup so this assertion exercises the component's write.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await user.click(screen.getByRole("button", { name: "Copy reset link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/#reset-password=${issuedToken}`,
    ));
    expect(await screen.findByRole("status")).toHaveTextContent(/reset link copied/i);
    expect(link).toBeVisible();
    expect(link).toHaveAttribute("readonly");
  });

  it("keeps the manual link visible when automatic copying is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      username: "casey",
      resetToken: issuedToken,
      maxAgeSeconds: 604_800,
    })));
    render(<AdminPasswordReset apiOrigin="" token="owner-jwt" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("VGames username"), "casey");
    await user.click(screen.getByRole("button", { name: "Create reset link" }));
    const link = await screen.findByLabelText("Password reset link");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    await user.click(screen.getByRole("button", { name: "Copy reset link" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/select the link.*manually/i);
    expect(link).toBeVisible();
  });
});
