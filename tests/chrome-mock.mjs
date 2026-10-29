/**
 * In-memory stand-in for the chrome.* APIs the service worker uses. Each test
 * builds a fresh one and loads background.js against it.
 */

function area() {
  let data = {};
  return {
    dump: () => data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      data = { ...data, ...structuredClone(items) };
    },
    async remove(key) {
      delete data[key];
    }
  };
}

/** The subset of the Storage interface swapStorage() relies on. */
class FakeStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  key(i) { return [...this.#items.keys()][i] ?? null; }
  getItem(key) { return this.#items.get(key) ?? null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  clear() { this.#items.clear(); }
  toObject() { return Object.fromEntries(this.#items); }
}

export function createChrome() {
  let jar = [];
  let listener = null;
  const reloaded = [];
  const openTabs = new Set();
  let storage = new FakeStorage();
  let storageBroken = false;

  const chrome = {
    storage: { local: area(), session: area() },
    i18n: { getMessage: (key) => key },
    runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
    cookies: {
      async getAll({ domain }) {
        return jar.filter((c) => c.domain.replace(/^\./, "").endsWith(domain)).map((c) => ({ ...c }));
      },
      async remove({ name }) {
        jar = jar.filter((c) => c.name !== name);
      },
      async set(details) {
        jar = jar.filter((c) => c.name !== details.name);
        jar.push({ domain: "claude.ai", path: "/", storeId: "0", hostOnly: true, session: true, ...details });
      }
    },
    tabs: {
      async query() {
        return [{ id: 1, windowId: 1 }];
      },
      async reload(id) {
        reloaded.push(id);
      },
      async create() {
        const id = 100 + openTabs.size;
        openTabs.add(id);
        return { id, status: "loading" };
      },
      async get(id) {
        return { id, status: "complete" };
      },
      async remove(id) {
        openTabs.delete(id);
      },
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: {
      async executeScript({ target, func, args }) {
        if (!openTabs.has(target.tabId)) throw new Error("No tab with id " + target.tabId);
        if (storageBroken) throw new Error("Frame was removed");
        globalThis.localStorage = storage;
        try {
          return [{ result: structuredClone(func(...structuredClone(args))) }];
        } finally {
          delete globalThis.localStorage;
        }
      }
    }
  };

  return {
    chrome,
    reloaded,
    /** Logs the browser into an account, as claude.ai would. */
    login(sessionKey) {
      jar = [{ name: "sessionKey", value: sessionKey, domain: "claude.ai", path: "/", secure: true, httpOnly: true, storeId: "0", hostOnly: true, session: false, expirationDate: 2e9 }];
    },
    sessionKey: () => jar.find((c) => c.name === "sessionKey")?.value ?? null,
    /** claude.ai's localStorage, as the app left it. */
    setStorage(items) {
      storage = new FakeStorage();
      for (const [k, v] of Object.entries(items)) storage.setItem(k, v);
    },
    storage: () => storage.toObject(),
    openTabs: () => openTabs.size,
    breakStorageTab: () => (storageBroken = true),
    /** Simulates a browser restart: memory-only storage is gone. */
    restart() {
      chrome.storage.session = area();
    },
    /** Sends a popup message and resolves with the service worker's answer. */
    send(type, payload = {}) {
      return new Promise((resolve, reject) => {
        listener({ type, ...payload }, {}, (res) => (res.ok ? resolve(res.data) : reject(new Error(res.error))));
      });
    }
  };
}
