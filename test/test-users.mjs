import { assert, t, done } from "./harness.mjs";
import {
  recordUserActivity,
  getUser,
  listUsers,
  setUserMode,
  setUserBlocked,
  resetUserSettings,
  isUserBlocked,
} from "../src/users.js";

// Mock in-memory KV
function createMockEnv() {
  const store = new Map();
  return {
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

await t("recordUserActivity creates user meta and adds ID to index", async () => {
  const env = createMockEnv();
  const user = { id: 1001, first_name: "Ali", last_name: "Reza", username: "alireza" };
  const meta = await recordUserActivity(env, user, { id: 1001, type: "private" });

  assert.equal(meta.id, 1001);
  assert.equal(meta.name, "Ali Reza");
  assert.equal(meta.username, "alireza");
  assert.equal(meta.messageCount, 1);
  assert.equal(meta.blocked, false);

  const fetched = await getUser(env, 1001);
  assert.equal(fetched.id, 1001);
  assert.equal(fetched.messageCount, 1);

  const index = await env.CONFIG.get("users:index", "json");
  assert.deepEqual(index, [1001]);
});

await t("subsequent activity increments messageCount and updates lastSeen", async () => {
  const env = createMockEnv();
  const user = { id: 1001, first_name: "Ali" };
  await recordUserActivity(env, user);
  await new Promise((r) => setTimeout(r, 10));
  const meta2 = await recordUserActivity(env, user);

  assert.equal(meta2.messageCount, 2);
  assert.ok(meta2.lastSeen >= meta2.firstSeen);
});

await t("listUsers returns all recorded users sorted by lastSeen desc", async () => {
  const env = createMockEnv();
  await recordUserActivity(env, { id: 101, first_name: "User1" });
  await new Promise((r) => setTimeout(r, 10));
  await recordUserActivity(env, { id: 102, first_name: "User2" });

  const list = await listUsers(env);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 102, "newest active user should be first");
  assert.equal(list[1].id, 101);
});

await t("setUserMode updates mode in metadata and quick lookup key", async () => {
  const env = createMockEnv();
  await recordUserActivity(env, { id: 1001, first_name: "Ali" });
  await setUserMode(env, 1001, "wolf");

  const modeVal = await env.CONFIG.get("user:1001:mode");
  assert.equal(modeVal, "wolf");

  const meta = await getUser(env, 1001);
  assert.equal(meta.mode, "wolf");
});

await t("setUserBlocked and isUserBlocked manage ban status", async () => {
  const env = createMockEnv();
  await recordUserActivity(env, { id: 1001, first_name: "Ali" });

  assert.equal(await isUserBlocked(env, 1001), false);

  await setUserBlocked(env, 1001, true);
  assert.equal(await isUserBlocked(env, 1001), true);

  const meta = await getUser(env, 1001);
  assert.equal(meta.blocked, true);

  await setUserBlocked(env, 1001, false);
  assert.equal(await isUserBlocked(env, 1001), false);
});

await t("resetUserSettings restores defaults and unbans", async () => {
  const env = createMockEnv();
  await recordUserActivity(env, { id: 1001, first_name: "Ali" });
  await setUserMode(env, 1001, "rude");
  await setUserBlocked(env, 1001, true);

  await resetUserSettings(env, 1001);

  assert.equal(await isUserBlocked(env, 1001), false);
  const meta = await getUser(env, 1001);
  assert.equal(meta.mode, null);
  assert.equal(meta.blocked, false);
});

done();
