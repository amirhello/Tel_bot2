// User activity tracking and persistent metadata management.
// Works seamlessly with any KV-like store (Cloudflare KV or Node.js FileKV).

export const USER_INDEX_KEY = "users:index";
export const MAX_INDEXED_USERS = 1000;

function formatDisplayName(user) {
  if (!user) return "Unknown";
  const parts = [];
  if (user.first_name) parts.push(user.first_name);
  if (user.last_name) parts.push(user.last_name);
  if (parts.length) return parts.join(" ");
  if (user.username) return user.username;
  return String(user.id || "Unknown");
}

/** Upsert user metadata upon interaction and maintain users:index list. */
export async function recordUserActivity(env, user, chat = {}) {
  if (!env?.CONFIG || !user || typeof user.id !== "number" || user.is_bot) {
    return null;
  }

  const userId = user.id;
  const metaKey = `user:${userId}:meta`;
  const now = Date.now();

  let meta = await env.CONFIG.get(metaKey, "json");
  if (!meta) {
    // New user
    const savedMode = await env.CONFIG.get(`user:${userId}:mode`);
    const isBlocked = (await env.CONFIG.get(`user:${userId}:blocked`)) === "1";

    meta = {
      id: userId,
      name: formatDisplayName(user),
      username: user.username || null,
      firstSeen: now,
      lastSeen: now,
      messageCount: 1,
      blocked: isBlocked,
      mode: savedMode || null,
      chatId: chat.id || null,
      chatType: chat.type || null,
    };

    // Update users:index
    let index = await env.CONFIG.get(USER_INDEX_KEY, "json");
    if (!Array.isArray(index)) index = [];
    if (!index.includes(userId)) {
      index.unshift(userId);
      if (index.length > MAX_INDEXED_USERS) index = index.slice(0, MAX_INDEXED_USERS);
      await env.CONFIG.put(USER_INDEX_KEY, index).catch(() => {});
    }
  } else {
    // Existing user
    meta.messageCount = (meta.messageCount || 0) + 1;
    meta.lastSeen = now;
    meta.name = formatDisplayName(user);
    if (user.username) meta.username = user.username;
    if (chat.id) meta.chatId = chat.id;
    if (chat.type) meta.chatType = chat.type;
  }

  await env.CONFIG.put(metaKey, meta).catch(() => {});
  return meta;
}

/** Get full user metadata object by numeric user ID. */
export async function getUser(env, userId) {
  if (!env?.CONFIG || !userId) return null;
  try {
    const meta = await env.CONFIG.get(`user:${userId}:meta`, "json");
    if (!meta) return null;
    return meta;
  } catch {
    return null;
  }
}

/** Return list of all indexed users sorted by lastSeen desc. */
export async function listUsers(env) {
  if (!env?.CONFIG) return [];
  try {
    const index = await env.CONFIG.get(USER_INDEX_KEY, "json");
    if (!Array.isArray(index) || !index.length) return [];

    const metas = await Promise.all(
      index.map(async (id) => {
        const m = await env.CONFIG.get(`user:${id}:meta`, "json").catch(() => null);
        if (m) return m;
        // Fallback for indexed ID with missing meta
        return { id, name: String(id), firstSeen: 0, lastSeen: 0, messageCount: 0, blocked: false, mode: null };
      })
    );

    return metas
      .filter(Boolean)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  } catch {
    return [];
  }
}

/** Set active persona mode for a specific user ID. */
export async function setUserMode(env, userId, mode) {
  if (!env?.CONFIG || !userId) return null;
  const metaKey = `user:${userId}:meta`;
  const modeKey = `user:${userId}:mode`;

  if (mode) {
    await env.CONFIG.put(modeKey, String(mode)).catch(() => {});
  } else {
    await env.CONFIG.delete(modeKey).catch(() => {});
  }

  let meta = await env.CONFIG.get(metaKey, "json");
  if (meta) {
    meta.mode = mode || null;
    await env.CONFIG.put(metaKey, meta).catch(() => {});
  }
  return meta;
}

/** Set or clear ban status for a user ID. */
export async function setUserBlocked(env, userId, blocked) {
  if (!env?.CONFIG || !userId) return null;
  const metaKey = `user:${userId}:meta`;
  const blockKey = `user:${userId}:blocked`;

  if (blocked) {
    await env.CONFIG.put(blockKey, "1").catch(() => {});
  } else {
    await env.CONFIG.delete(blockKey).catch(() => {});
  }

  let meta = await env.CONFIG.get(metaKey, "json");
  if (meta) {
    meta.blocked = Boolean(blocked);
    await env.CONFIG.put(metaKey, meta).catch(() => {});
  }
  return meta;
}

/** Fast O(1) check if a user is blocked. */
export async function isUserBlocked(env, userId) {
  if (!env?.CONFIG || !userId) return false;
  try {
    const val = await env.CONFIG.get(`user:${userId}:blocked`);
    return val === "1" || val === "true";
  } catch {
    return false;
  }
}

/** Reset user settings (mode to default, unblock). */
export async function resetUserSettings(env, userId) {
  if (!env?.CONFIG || !userId) return null;
  await env.CONFIG.delete(`user:${userId}:mode`).catch(() => {});
  await env.CONFIG.delete(`user:${userId}:blocked`).catch(() => {});

  let meta = await env.CONFIG.get(`user:${userId}:meta`, "json");
  if (meta) {
    meta.mode = null;
    meta.blocked = false;
    await env.CONFIG.put(`user:${userId}:meta`, meta).catch(() => {});
  }
  return meta;
}
