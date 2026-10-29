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
  removeItem(key) { this.#items.delete(key); }
  clear() { this.#items.clear(); }
  toObject() { return Object.fromEntries(this.#items); }
}

// The app key the tests follow. The fake app keeps it in memory and writes it
// back when its page goes away, the way claude.ai persists its state.
const APP_KEY = "LSS-code-selected-repo";
const APP_HOME = "https://claude.ai/new";

const isApp = (url) => /^https:\/\/claude\.ai\//.test(url || "") && !url.endsWith("/robots.txt");
const later = (fn) => setTimeout(fn, 1);

export function createChrome() {
  let jar = [];
  let listener = null;
  let storage = new FakeStorage();
  let storageBroken = false;
  const tabs = new Map();
  const onUpdated = new Set();
  let nextTabId = 1;

  function unload(tab) {
    if (!isApp(tab.url)) return;
    if (tab.appState === null) storage.removeItem(APP_KEY);
    else storage.setItem(APP_KEY, tab.appState);
  }

  function navigate(tab, url) {
    unload(tab);
    Object.assign(tab, { url, status: "loading" });
    later(() => {
      if (!tabs.has(tab.id)) return;
      tab.status = "complete";
      tab.appState = isApp(url) ? storage.getItem(APP_KEY) : undefined;
      for (const fn of onUpdated) fn(tab.id, { status: "complete" }, { ...tab });
    });
  }

  function openTab(url) {
    const tab = { id: nextTabId++, windowId: 1, url, status: "complete" };
    tab.appState = isApp(url) ? storage.getItem(APP_KEY) : undefined;
    tabs.set(tab.id, tab);
    return tab;
  }

  // A claude.ai tab is open, as it usually is when switching.
  openTab(APP_HOME);

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
        return [...tabs.values()].filter((t) => /^https:\/\/claude\.ai\//.test(t.url)).map((t) => ({ ...t }));
      },
      async reload(id) {
        navigate(tabs.get(id), tabs.get(id).url);
      },
      async create({ url }) {
        const tab = openTab("about:blank");
        navigate(tab, url);
        return { ...tab };
      },
      async update(id, { url }) {
        if (url) navigate(tabs.get(id), url);
        return { ...tabs.get(id) };
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab with id " + id);
        return { ...tabs.get(id) };
      },
      async remove(id) {
        unload(tabs.get(id));
        tabs.delete(id);
      },
      onUpdated: { addListener: (fn) => onUpdated.add(fn), removeListener: (fn) => onUpdated.delete(fn) }
    },
    scripting: {
      async executeScript({ target, func, args }) {
        if (!tabs.has(target.tabId)) throw new Error("No tab with id " + target.tabId);
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
    /** Logs the browser into an account, as claude.ai would. */
    login(sessionKey) {
      jar = [{ name: "sessionKey", value: sessionKey, domain: "claude.ai", path: "/", secure: true, httpOnly: true, storeId: "0", hostOnly: true, session: false, expirationDate: 2e9 }];
    },
    sessionKey: () => jar.find((c) => c.name === "sessionKey")?.value ?? null,
    /** claude.ai's localStorage, as the app left it: open app tabs hold it too. */
    setStorage(items) {
      storage = new FakeStorage();
      for (const [k, v] of Object.entries(items)) storage.setItem(k, v);
      for (const tab of tabs.values()) if (isApp(tab.url)) tab.appState = storage.getItem(APP_KEY);
    },
    storage: () => storage.toObject(),
    tabUrls: () => [...tabs.values()].map((t) => t.url),
    /** The repository each open claude.ai app tab shows. */
    shownRepos: () => [...tabs.values()].filter((t) => isApp(t.url)).map((t) => t.appState),
    /** Lets the background tab loads scheduled with later() finish. */
    settle: () => new Promise((r) => setTimeout(r, 10)),
    closeAllTabs: () => tabs.clear(),
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
