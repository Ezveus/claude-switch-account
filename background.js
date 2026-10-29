/**
 * Claude Switch Account — service worker.
 *
 * How it works: claude.ai authentication lives in cookies (sessionKey chief
 * among them). We snapshot every cookie for the domain into a profile;
 * switching means clearing the current jar and restoring the target profile's
 * cookies. claude.ai's localStorage is swapped the same way, so nothing one
 * account leaves there (repositories, organization ids…) shows in the other.
 *
 * Profiles are split in two: labels and colors live in plaintext under
 * STORAGE_KEY, while the cookies live in a vault encrypted with the user's
 * passphrase (see vault.js). The derived key is kept in chrome.storage.session,
 * which is memory-only, so the vault locks again when the browser quits.
 */

import * as Vault from "./vault.js";

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

const COOKIE_DOMAINS = ["claude.ai", "anthropic.com"];
const STORAGE_KEY = "cmc_state";
const VAULT_KEY = "cmc_vault";
const SESSION_KEY = "cmc_key";

// A static file on claude.ai: it shares the app's localStorage without running
// the app, which would otherwise write keys while they are being swapped.
const STORAGE_PAGE = "https://claude.ai/robots.txt";
const STORAGE_PAGE_TIMEOUT_MS = 15_000;

const DEFAULT_STATE = { accounts: [], activeId: null };

const COLORS = [
  "#d97757", "#6a9fb5", "#8a7bbd", "#5fa87c",
  "#c9a227", "#c2687f", "#4f8fc0", "#a2795d"
];

/* ---------------------------------------------------------------- state --- */

async function getState() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(raw[STORAGE_KEY] || {}) };
}

async function setState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

/* ---------------------------------------------------------------- vault --- */

async function getVault() {
  return (await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY] || null;
}

async function getKey() {
  const raw = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  return raw ? Vault.importKey(raw) : null;
}

async function vaultStatus() {
  if (!(await getVault())) return "none";
  return (await getKey()) ? "unlocked" : "locked";
}

/** Runs `mutate` on the decrypted secrets ({ [accountId]: { cookies } }), then
 *  re-encrypts them. */
async function withSecrets(mutate) {
  const vault = await getVault();
  const key = vault && (await getKey());
  if (!key) throw new Error(t("errLocked"));
  const secrets = await Vault.open(key, vault);
  const result = await mutate(secrets);
  await chrome.storage.local.set({ [VAULT_KEY]: await Vault.seal(key, secrets, vault) });
  return result;
}

async function rememberKey(key) {
  await chrome.storage.session.set({ [SESSION_KEY]: await Vault.exportKey(key) });
}

/** Encrypts the profiles for the first time. Profiles saved before the vault
 *  existed carry their cookies in plaintext: they move into the vault. */
async function setupVault(passphrase) {
  if (await getVault()) throw new Error(t("errVaultExists"));
  if (typeof passphrase !== "string" || passphrase.length < Vault.MIN_PASSPHRASE_LENGTH) {
    throw new Error(t("errPassphraseShort", Vault.MIN_PASSPHRASE_LENGTH));
  }

  const state = await getState();
  const secrets = {};
  for (const account of state.accounts) {
    if (account.cookies) secrets[account.id] = { cookies: account.cookies };
  }

  const { key, vault } = await Vault.create(passphrase, secrets);
  // Vault first: if the worker dies in between, the plaintext copy survives.
  await chrome.storage.local.set({ [VAULT_KEY]: vault });
  await rememberKey(key);

  for (const account of state.accounts) delete account.cookies;
  await setState(state);
}

async function unlockVault(passphrase) {
  const vault = await getVault();
  if (!vault) throw new Error(t("errNoVault"));
  let key;
  try {
    ({ key } = await Vault.unlock(passphrase, vault));
  } catch {
    throw new Error(t("errBadPassphrase"));
  }
  await rememberKey(key);
}

async function lockVault() {
  await chrome.storage.session.remove(SESSION_KEY);
}

/** Forgotten passphrase: drops every profile. The live session is untouched. */
async function resetVault() {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.storage.local.remove(VAULT_KEY);
  await setState({ ...DEFAULT_STATE });
}

/* -------------------------------------------------------------- cookies --- */

async function readCookies() {
  const jars = await Promise.all(
    COOKIE_DOMAINS.map((domain) => chrome.cookies.getAll({ domain }))
  );
  const seen = new Set();
  const cookies = [];
  for (const cookie of jars.flat()) {
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}|${cookie.storeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cookies.push(cookie);
  }
  return cookies;
}

function cookieUrl(cookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`;
}

async function clearCookies() {
  const cookies = await readCookies();
  await Promise.all(
    cookies.map((cookie) =>
      chrome.cookies
        .remove({
          url: cookieUrl(cookie),
          name: cookie.name,
          storeId: cookie.storeId,
          ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
        })
        .catch(() => {})
    )
  );
}

async function writeCookies(cookies) {
  for (const cookie of cookies) {
    const details = {
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      storeId: cookie.storeId
    };

    // A hostOnly cookie must not carry a domain field, otherwise Chrome turns
    // it into a domain cookie and anchors it to the wrong scope.
    if (!cookie.hostOnly) details.domain = cookie.domain;

    // SameSite=None requires secure:true, or chrome.cookies.set rejects it.
    if (cookie.sameSite && cookie.sameSite !== "unspecified") {
      details.sameSite = cookie.sameSite;
      if (cookie.sameSite === "no_restriction") details.secure = true;
    }

    if (!cookie.session && cookie.expirationDate) {
      details.expirationDate = cookie.expirationDate;
    }
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;

    try {
      await chrome.cookies.set(details);
    } catch (err) {
      console.warn("[CSA] skipped cookie:", cookie.name, err);
    }
  }
}

/* --------------------------------------------------------- localStorage --- */

/** Runs in the claude.ai page. Returns the current localStorage and, when
 *  `next` is an object, replaces it with `next`. */
function swapStorage(next) {
  const previous = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    previous[key] = localStorage.getItem(key);
  }
  if (next) {
    localStorage.clear();
    for (const [key, value] of Object.entries(next)) localStorage.setItem(key, value);
  }
  return previous;
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        done();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(t("errStorageTab")));
    }, STORAGE_PAGE_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    // The page may have finished loading before the listener was in place.
    chrome.tabs.get(tabId).then((tab) => tab.status === "complete" && onUpdated(tabId, tab), () => {});
  });
}

/** Swaps claude.ai's localStorage through a background tab on STORAGE_PAGE,
 *  then closes it. `next` null only reads. */
async function swapClaudeStorage(next) {
  const tab = await chrome.tabs.create({ url: STORAGE_PAGE, active: false });
  try {
    await waitForLoad(tab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: swapStorage,
      args: [next]
    });
    return result;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/* -------------------------------------------------------------- identity --- */

/** Queries the claude.ai API with the current cookies to label the profile. */
async function probeIdentity() {
  const endpoints = [
    "https://claude.ai/api/auth/current_account",
    "https://claude.ai/api/bootstrap",
    "https://claude.ai/api/organizations"
  ];

  const found = { email: null, name: null, org: null };

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) continue;
      const text = await res.text();

      found.email ||= text.match(/"email_address"\s*:\s*"([^"]+)"/)?.[1] || null;
      found.name ||= text.match(/"full_name"\s*:\s*"([^"]+)"/)?.[1]
        || text.match(/"display_name"\s*:\s*"([^"]+)"/)?.[1] || null;
      // The organization name lives under "name" in /api/organizations.
      found.org ||= text.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || null;

      if (found.email && found.name) break;
    } catch {
      /* endpoint unavailable, try the next one */
    }
  }

  // Last resort: the e-mail local part doubles as a readable name.
  if (!found.name && found.email) found.name = found.email.split("@")[0];
  return found;
}

async function isLoggedIn() {
  const cookies = await readCookies();
  return cookies.some((c) => c.name === "sessionKey" && c.value);
}

/* -------------------------------------------------------------- actions --- */

async function snapshotInto(account, secrets) {
  secrets[account.id] = {
    ...secrets[account.id],
    cookies: await readCookies(),
    localStorage: await swapClaudeStorage(null)
  };
  account.savedAt = Date.now();
}

/** Saves the currently active session as a new profile. */
async function addCurrentAccount(label) {
  if (!(await isLoggedIn())) throw new Error(t("errNoSession"));

  const state = await getState();
  const identity = await probeIdentity();

  const account = {
    id: crypto.randomUUID(),
    label:
      label
      || identity.name
      || identity.email
      || t("defaultAccountName", state.accounts.length + 1),
    name: identity.name,
    email: identity.email,
    org: identity.org,
    color: COLORS[state.accounts.length % COLORS.length]
  };

  // Same e-mail already saved -> overwrite instead of duplicating.
  const existing = account.email
    ? state.accounts.find((a) => a.email && a.email === account.email)
    : null;

  if (existing) {
    Object.assign(existing, {
      name: identity.name || existing.name,
      org: identity.org || existing.org
    });
  } else {
    state.accounts.push(account);
  }

  const saved = existing || account;
  await withSecrets((secrets) => snapshotInto(saved, secrets));
  state.activeId = saved.id;
  await setState(state);
}

/** Switches to a profile, re-saving the current session first. */
async function switchTo(id) {
  const state = await getState();
  const target = state.accounts.find((a) => a.id === id);
  if (!target) throw new Error(t("errNotFound"));

  await withSecrets(async (secrets) => {
    // Checked before clearing anything, or the switch would just log out.
    if (!secrets[id]?.cookies) throw new Error(t("errNotFound"));

    // sessionKey rotates, so re-snapshot the active account before leaving it.
    const current = state.accounts.find((a) => a.id === state.activeId);
    const leaving = current && current.id !== id ? current : null;
    if (leaving && (await isLoggedIn())) {
      secrets[leaving.id] = { ...secrets[leaving.id], cookies: await readCookies() };
      leaving.savedAt = Date.now();
    }

    // Before the cookies: if the storage tab fails, nothing has changed yet.
    // Profiles saved before this swap existed start from an empty storage.
    const previous = await swapClaudeStorage(secrets[id].localStorage || {});
    if (leaving) secrets[leaving.id] = { ...secrets[leaving.id], localStorage: previous };

    await clearCookies();
    await writeCookies(secrets[id].cookies);
  });

  state.activeId = id;
  await setState(state);
  await reloadClaudeTabs();
}

/** Clears the session without touching saved profiles (to add an account). */
async function startFreshSession() {
  const state = await getState();
  const current = state.accounts.find((a) => a.id === state.activeId);
  if (current) {
    await withSecrets(async (secrets) => {
      if (await isLoggedIn()) {
        secrets[current.id] = { ...secrets[current.id], cookies: await readCookies() };
        current.savedAt = Date.now();
      }
      secrets[current.id] = { ...secrets[current.id], localStorage: await swapClaudeStorage({}) };
    });
  } else {
    // An unsaved session: its storage belongs to nobody, so it just goes.
    await swapClaudeStorage({});
  }

  await clearCookies();
  state.activeId = null;
  await setState(state);
  await reloadClaudeTabs();
}

async function refreshActive() {
  const state = await getState();
  const current = state.accounts.find((a) => a.id === state.activeId);
  if (!current) throw new Error(t("errNoActive"));
  if (!(await isLoggedIn())) throw new Error(t("errNothingToSave"));

  await withSecrets((secrets) => snapshotInto(current, secrets));
  const identity = await probeIdentity();
  if (identity.email) current.email = identity.email;
  if (identity.name) current.name = identity.name;
  if (identity.org) current.org = identity.org;
  await setState(state);
}

async function renameAccount(id, label) {
  const state = await getState();
  const account = state.accounts.find((a) => a.id === id);
  if (account) account.label = label;
  await setState(state);
}

async function removeAccount(id) {
  await withSecrets((secrets) => delete secrets[id]);
  const state = await getState();
  state.accounts = state.accounts.filter((a) => a.id !== id);
  if (state.activeId === id) state.activeId = null;
  await setState(state);
}

async function reloadClaudeTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://claude.ai/*", "https://*.claude.ai/*"] });
  await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id).catch(() => {})));
}

async function openClaude() {
  const [tab] = await chrome.tabs.query({ url: ["https://claude.ai/*"] });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: "https://claude.ai/new" });
  }
}

/* ---------------------------------------------------------------- router --- */

/** What the popup renders. Never carries cookies, even legacy plaintext ones. */
async function view() {
  const state = await getState();
  return {
    state: { ...state, accounts: state.accounts.map(({ cookies, ...account }) => account) },
    loggedIn: await isLoggedIn(),
    vault: await vaultStatus()
  };
}

// Every handler answers with a fresh view, so the popup always knows the vault state.
const HANDLERS = {
  getState: async () => {},
  setupVault: ({ passphrase }) => setupVault(passphrase),
  unlock: ({ passphrase }) => unlockVault(passphrase),
  lock: () => lockVault(),
  resetVault: () => resetVault(),
  addCurrent: ({ label }) => addCurrentAccount(label),
  switchTo: ({ id }) => switchTo(id),
  freshSession: () => startFreshSession(),
  refreshActive: () => refreshActive(),
  rename: ({ id, label }) => renameAccount(id, label),
  remove: ({ id }) => removeAccount(id),
  openClaude: () => openClaude()
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: t("errUnknownAction", msg?.type) });
    return false;
  }
  handler(msg)
    .then(view)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // async response
});
