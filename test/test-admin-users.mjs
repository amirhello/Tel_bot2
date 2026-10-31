import { assert, t, done } from "./harness.mjs";
import { handleAdmin, renderDashboard, signSecret } from "../src/admin.js";
import { recordUserActivity, getUser, isUserBlocked } from "../src/users.js";

// Mock env with in-memory KV
function createMockAdminEnv(password = "adminpass123") {
  const store = new Map();
  return {
    ADMIN_PASSWORD: password,
    CONFIG: {
      async get(key, type = "text") {
        const val = store.get(key);
        if (val === undefined || val === null) return null;
        if (type === "json") {
          try {
            return typeof val === "string" ? JSON.parse(val) : val;
          } catch {
            return null;
          }
        }
        return typeof val === "string" ? val : JSON.stringify(val);
      },
      async put(key, val) {
        store.set(key, typeof val === "string" ? val : JSON.stringify(val));
      },
      async delete(key) {
        store.delete(key);
      },
    },
  };
}

async function authedHeaders(env) {
  const token = await signSecret(env.ADMIN_PASSWORD);
  return { cookie: `sayyad_admin=${token}`, "content-type": "application/json" };
}

await t("GET /admin/api/users requires admin authentication", async () => {
  const env = createMockAdminEnv();
  const req = new Request("http://localhost/admin/api/users");
  const res = await handleAdmin(req, env, "/admin/api/users");
  assert.equal(res.status, 401);
});

await t("GET /admin/api/users returns list of users with interaction stats", async () => {
  const env = createMockAdminEnv();
  await recordUserActivity(env, { id: 101, first_name: "Ali", username: "alireza" });
  await recordUserActivity(env, { id: 102, first_name: "Sara" });

  const headers = await authedHeaders(env);
  const req = new Request("http://localhost/admin/api/users", { headers });
  const res = await handleAdmin(req, env, "/admin/api/users");
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.count, 2);
  assert.equal(data.users.length, 2);
  assert.ok(data.users.some((u) => u.id === 101 && u.username === "alireza"));
  assert.ok(data.users.some((u) => u.id === 102 && u.name === "Sara"));
});

await t("POST /admin/api/users/block updates user blocked status", async () => {
  const env = createMockAdminEnv();
  await recordUserActivity(env, { id: 101, first_name: "Ali" });

  const headers = await authedHeaders(env);
  const req = new Request("http://localhost/admin/api/users/block", {
    method: "POST",
    headers,
    body: JSON.stringify({ userId: 101, blocked: true }),
  });
  const res = await handleAdmin(req, env, "/admin/api/users/block");
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.user.blocked, true);
  assert.equal(await isUserBlocked(env, 101), true);
});

await t("POST /admin/api/users/mode updates user persona", async () => {
  const env = createMockAdminEnv();
  await recordUserActivity(env, { id: 101, first_name: "Ali" });

  const headers = await authedHeaders(env);
  const req = new Request("http://localhost/admin/api/users/mode", {
    method: "POST",
    headers,
    body: JSON.stringify({ userId: 101, mode: "wolf" }),
  });
  const res = await handleAdmin(req, env, "/admin/api/users/mode");
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.user.mode, "wolf");
  assert.equal(await env.CONFIG.get("user:101:mode"), "wolf");
});

await t("POST /admin/api/users/reset clears user customizations", async () => {
  const env = createMockAdminEnv();
  await recordUserActivity(env, { id: 101, first_name: "Ali" });
  await env.CONFIG.put("user:101:mode", "rude");
  await env.CONFIG.put("user:101:blocked", "1");

  const headers = await authedHeaders(env);
  const req = new Request("http://localhost/admin/api/users/reset", {
    method: "POST",
    headers,
    body: JSON.stringify({ userId: 101 }),
  });
  const res = await handleAdmin(req, env, "/admin/api/users/reset");
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.user.mode, null);
  assert.equal(data.user.blocked, false);
});

await t("renderDashboard renders Users tab and user management pane", () => {
  const html = renderDashboard();
  assert.match(html, /data-pane="users"/, "must have Users tab");
  assert.match(html, /id="pane-users"/, "must have Users pane container");
  assert.match(html, /id="usersearch"/, "must have user search input");
});

done();
