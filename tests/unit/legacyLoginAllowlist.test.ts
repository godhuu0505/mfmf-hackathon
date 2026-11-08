import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), client: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.client }));
import { createClient } from "@/lib/supabase/server";

beforeEach(() => {
  vi.stubEnv("GCP_AUTH_ENABLED", "false"); vi.stubEnv("NEXT_PUBLIC_GCP_AUTH_ENABLED", "false");
  vi.stubEnv("GOOGLE_LOGIN_ALLOWED_EMAILS", "member@example.test");
  mocks.getUser.mockReset(); mocks.client.mockImplementation(() => ({ auth: { getUser: mocks.getUser } }));
});
afterEach(() => vi.unstubAllEnvs());
describe("legacy server actions apply login policy after provider verification", () => {
  it("preserves a verified allowed identity", async () => {
    const user = { id: "fictional-user", email: "member@example.test", email_confirmed_at: "2026-01-01" };
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    const client = await createClient();
    expect((await client.auth.getUser()).data.user).toBe(user);
    expect(mocks.getUser).toHaveBeenCalledOnce();
  });
  it.each([
    { email: "outsider@example.test", email_confirmed_at: "2026-01-01" },
    { email: "member@example.test", email_confirmed_at: null },
  ])("withholds an unlisted or unverified identity from server actions: %j", async attributes => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "fictional-user", ...attributes } }, error: null });
    const client = await createClient();
    const result = await client.auth.getUser();
    expect(result.data.user).toBeNull(); expect(result.error).not.toBeNull();
  });
  it("rechecks the policy on an existing server client", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "fictional-user", email: "member@example.test", email_confirmed_at: "2026-01-01" } }, error: null });
    const client = await createClient();
    vi.stubEnv("GOOGLE_LOGIN_ALLOWED_EMAILS", "other@example.test");
    expect((await client.auth.getUser()).data.user).toBeNull();
  });
});
