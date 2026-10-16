import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { BrowserSessions } from "../src/browser-sessions.js";
import { backup } from "../src/backup.js";

const host = "127.0.0.1:4317",
  origin = `http://${host}`;
const client = {
  host,
  origin,
  "x-study-cafe-client": "browser",
  "sec-fetch-site": "same-origin",
};
const bearer = { host, authorization: "Bearer auth-test-only" };
const temp = () => mkdtempSync(join(tmpdir(), "study-browser-auth-"));
const cookieOf = (r: any) => String(r.headers["set-cookie"]).split(";")[0]!;
async function fixture(t: any) {
  const f = await createApp({
    dataDir: temp(),
    token: "auth-test-only",
    autoWorker: false,
    allowedOrigins: [origin, "http://127.0.0.1:5173"],
  });
  t.after(() => f.app.close());
  return f;
}

test("launch grants require the local root credential, are single-use, and never return it", async (t) => {
  const { app, token, store } = await fixture(t);
  assert.equal(
    (await app.inject({ url: "/api/home", headers: { host } })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/browser/launch",
        headers: { host },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/browser/connect",
        headers: client,
        payload: {},
      })
    ).statusCode,
    401,
  );
  const grant = await app.inject({
    method: "POST",
    url: "/api/browser/launch",
    headers: bearer,
  });
  assert.equal(grant.statusCode, 200);
  assert.equal(grant.headers["cache-control"], "no-store");
  const url = new URL(grant.json().url);
  assert.equal(url.search, "");
  assert.equal(url.origin, origin);
  assert.ok(!grant.body.includes(token));
  const code = new URLSearchParams(url.hash.split("?")[1]).get("code")!;
  const request = {
    method: "POST" as const,
    url: "/api/browser/connect",
    headers: client,
    payload: { code },
  };
  const connected = await app.inject(request);
  assert.equal(connected.statusCode, 200);
  const cookie = cookieOf(connected);
  const asset = store.asset(
    Buffer.from("private study attachment"),
    "text/plain",
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/assets/${asset.id}`,
        headers: { ...client, cookie },
      })
    ).body,
    "private study attachment",
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/assets/${asset.id}`,
        headers: { host, cookie },
      })
    ).statusCode,
    403,
  );
  assert.match(
    String(connected.headers["set-cookie"]),
    /Path=\/api; HttpOnly; SameSite=Strict; Max-Age=2592000/,
  );
  assert.ok(!cookie.includes(token));
  assert.equal((await app.inject(request)).statusCode, 401);
  assert.equal(
    (await app.inject({ url: "/api/home", headers: { ...client, cookie } }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/browser/launch",
        headers: { ...client, cookie },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/browser/connect",
        headers: client,
        payload: { code: "wrong" },
      })
    ).statusCode,
    400,
  );
});

test("cookie access rejects missing client headers, cross-site requests, other ports and hostile hosts", async (t) => {
  const { app, browserSessions } = await fixture(t);
  const cookie = browserSessions.connect(host).split(";")[0]!;
  const cases = [
    { host, cookie },
    { ...client, cookie, origin: "https://evil.example" },
    { ...client, cookie, origin: "null" },
    { ...client, cookie, origin: "http://127.0.0.1:5173" },
    { ...client, cookie, "sec-fetch-site": "same-site" },
    { ...client, cookie, "sec-fetch-site": "cross-site" },
    { ...client, cookie, host: "evil.example" },
  ];
  for (const headers of cases) {
    assert.equal(
      (await app.inject({ url: "/api/home", headers })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/browser/connect",
          headers,
          payload: {},
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (
      await app.inject({
        url: "/api/home",
        headers: {
          ...client,
          host: "127.0.0.1:5173",
          origin: "http://127.0.0.1:5173",
          cookie,
        },
      })
    ).statusCode,
    401,
  );
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/api/goals",
    headers: {
      host,
      origin: "https://evil.example",
      "access-control-request-headers": "x-study-cafe-client",
    },
  });
  assert.equal(preflight.statusCode, 403);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  assert.equal(
    (await app.inject({ url: "/api/home", headers: bearer })).statusCode,
    200,
  );
});

test("existing bearer tabs migrate; logout revokes copied cookies and preserves records and CLI auth", async (t) => {
  const { app, catalog } = await fixture(t);
  const goal = catalog.goal({ title: "A preserved goal" });
  const connected = await app.inject({
    method: "POST",
    url: "/api/browser/connect",
    headers: { ...client, ...bearer },
    payload: {},
  });
  assert.equal(connected.statusCode, 200);
  const cookie = cookieOf(connected);
  assert.equal(
    (
      await app.inject({
        url: "/api/browser/session",
        headers: { ...client, cookie },
      })
    ).statusCode,
    200,
  );
  const logout = await app.inject({
    method: "POST",
    url: "/api/browser/logout",
    headers: { ...client, cookie },
  });
  assert.equal(logout.statusCode, 200);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
  assert.equal(
    (await app.inject({ url: "/api/home", headers: { ...client, cookie } }))
      .statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: `/api/goals/${goal.id}`, headers: bearer })).json()
      .title,
    "A preserved goal",
  );
});

test("browser sessions survive a server restart but not a root-token change; backups exclude credentials", async () => {
  const dir = temp();
  let f = await createApp({
    dataDir: dir,
    autoWorker: false,
    allowedOrigins: [origin],
  });
  try {
    const cookie = f.browserSessions.connect(host).split(";")[0]!;
    const secret = cookie.split("=")[1]!;
    const saved = readFileSync(join(dir, "browser-sessions.json"), "utf8");
    assert.ok(!saved.includes(secret) && !saved.includes(f.token));
    writeFileSync(
      join(dir, "server-address.json"),
      JSON.stringify({ url: origin }),
    );
    f.catalog.goal({ title: "Saved" });
    const snapshot = backup(f.store);
    assert.deepEqual(readdirSync(join(dir, "backups", snapshot.id)).sort(), [
      "assets",
      "manifest.json",
      "study-cafe.db",
    ]);
    await f.app.close();
    f = await createApp({
      dataDir: dir,
      autoWorker: false,
      allowedOrigins: [origin],
    });
    assert.equal(
      (await f.app.inject({ url: "/api/home", headers: { ...client, cookie } }))
        .statusCode,
      200,
    );
    await f.app.close();
    writeFileSync(join(dir, "session-token"), "rotated-test-root");
    f = await createApp({
      dataDir: dir,
      autoWorker: false,
      allowedOrigins: [origin],
    });
    assert.equal(
      (await f.app.inject({ url: "/api/home", headers: { ...client, cookie } }))
        .statusCode,
      401,
    );
    assert.equal(
      f.catalog.readGoal(f.store.one("SELECT id FROM goals").id).title,
      "Saved",
    );
  } finally {
    await f.app.close();
  }
});

test("grant expiry, port binding, restart invalidation, session expiry and corrupt state fail closed", () => {
  const dir = temp();
  let time = 1_000_000;
  const sessions = new BrowserSessions(dir, "test", () => time);
  const code = sessions.issue(host);
  assert.throws(() => sessions.exchange("127.0.0.1:5173", code), /만료/);
  time += 5 * 60_000;
  assert.throws(() => sessions.exchange(host, code), /만료/);
  const cookie = sessions.connect(host);
  const pending = sessions.issue(host);
  const restarted = new BrowserSessions(dir, "test", () => time);
  assert.equal(restarted.valid(host, cookie), true);
  assert.throws(() => restarted.exchange(host, pending), /만료/);
  time += 30 * 24 * 60 * 60_000;
  assert.equal(restarted.valid(host, cookie), false);
  writeFileSync(join(dir, "browser-sessions.json"), "damaged");
  assert.equal(
    new BrowserSessions(dir, "test", () => time).valid(host, cookie),
    false,
  );
});

test("development launch grants are limited to configured loopback origins and bind to the proxy host", async (t) => {
  const { app } = await fixture(t);
  for (const origin of [
    "https://evil.example",
    "http://127.0.0.1:9999",
    "http://127.0.0.1:5173/path",
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/browser/launch",
          headers: bearer,
          payload: { origin },
        })
      ).statusCode,
      403,
    );
  }
  const dev = "http://127.0.0.1:5173";
  const grant = await app.inject({
    method: "POST",
    url: "/api/browser/launch",
    headers: bearer,
    payload: { origin: dev },
  });
  const code = new URLSearchParams(
    new URL(grant.json().url).hash.split("?")[1],
  ).get("code");
  const wrongPort = await app.inject({
    method: "POST",
    url: "/api/browser/connect",
    headers: client,
    payload: { code },
  });
  assert.equal(wrongPort.statusCode, 401);
  const headers = { ...client, host: "127.0.0.1:5173", origin: dev };
  const connected = await app.inject({
    method: "POST",
    url: "/api/browser/connect",
    headers,
    payload: { code },
  });
  assert.equal(connected.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        url: "/api/home",
        headers: { ...headers, cookie: cookieOf(connected) },
      })
    ).statusCode,
    200,
  );
});
