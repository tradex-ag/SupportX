import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeErrorBody, requestJson, HttpError } from "../../packages/connectors/http.ts";

function fakeFetch(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(body, { status, headers })) as typeof fetch;
}

describe("provider error details", () => {
  it("names the Graph error code and request id when the message is empty", async () => {
    const body = JSON.stringify({ error: { code: "UnknownError", message: "", innerError: { date: "2026-11-12T21:25:00", "request-id": "abc-123", "client-request-id": "abc-123" } } });
    await assert.rejects(
      requestJson("https://graph.microsoft.com/v1.0/users/x/mailFolders/inbox", { method: "GET", timeoutMs: 1000, fetchImpl: fakeFetch(500, body) }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 500);
        assert.equal(error.retryable, true);
        assert.match(error.message, /Serverfehler beim Anbieter \(HTTP 500\)/);
        assert.match(error.message, /UnknownError/);
        assert.match(error.message, /Anfrage-ID abc-123/);
        return true;
      },
    );
  });

  it("keeps code and message together", () => {
    const body = JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } });
    assert.equal(describeErrorBody(body), "ErrorAccessDenied: Access is denied. Check credentials and try again.");
  });

  it("falls back to the request-id header for a non-JSON body", () => {
    const detail = describeErrorBody("<html><body>Internal Server Error</body></html>", new Headers({ "request-id": "r-9" }));
    assert.equal(detail, "Internal Server Error · Anfrage-ID r-9");
  });

  it("still lists field errors (Kaufland style)", () => {
    const body = JSON.stringify({ message: "Validation Failed", errors: [{ property: "limit", message: "must be ≤ 30" }] });
    assert.equal(describeErrorBody(body), "Validation Failed: limit: must be ≤ 30");
  });
});
