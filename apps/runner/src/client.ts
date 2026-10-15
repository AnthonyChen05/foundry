import { FoundryClient } from "@foundry/sdk-ts";

/** Login (ADR-014 credentials) → Bearer/WS token for the executor session. */
export async function login(serverUrl: string, username: string, password: string): Promise<{ token: string }> {
  const client = new FoundryClient({ baseUrl: serverUrl });
  const res = await client.login(username, password);
  return { token: res.sessionToken };
}