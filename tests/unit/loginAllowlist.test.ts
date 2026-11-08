import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoginEmailAllowed, isVerifiedLoginAllowed } from "@/lib/identity/allowlist";

afterEach(() => vi.unstubAllEnvs());
describe("server login email policy", () => {
  it.each([undefined, "", " ", "*,member@example.test", "member@example.test,", "member@example.test\n"])("fails closed for absent or malformed configuration %j", policy => {
    vi.stubEnv("GOOGLE_LOGIN_ALLOWED_EMAILS", policy);
    expect(isLoginEmailAllowed("member@example.test")).toBe(false);
  });
  it("matches exact addresses with case normalization and no Gmail alias expansion", () => {
    vi.stubEnv("GOOGLE_LOGIN_ALLOWED_EMAILS", " Member.Name@gmail.com ,other@example.test");
    expect(isVerifiedLoginAllowed({ email: "MEMBER.NAME@gmail.com", emailVerified: true })).toBe(true);
    for (const email of ["membername@gmail.com", "member.name+alias@gmail.com", "member.name@googlemail.com", "stranger@gmail.com", " member.name@gmail.com", "member.name@gmail.com.evil.test"]) {
      expect(isVerifiedLoginAllowed({ email, emailVerified: true })).toBe(false);
    }
    expect(isVerifiedLoginAllowed({ email: "member.name@gmail.com", emailVerified: false })).toBe(false);
  });
  it("applies removal without a cached policy", () => {
    vi.stubEnv("GOOGLE_LOGIN_ALLOWED_EMAILS", "member@example.test");
    expect(isLoginEmailAllowed("member@example.test")).toBe(true);
    vi.stubEnv("GOOGLE_LOGIN_ALLOWED_EMAILS", "other@example.test");
    expect(isLoginEmailAllowed("member@example.test")).toBe(false);
  });
});
