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

export function createChrome() {
  let jar = [];
  let listener = null;
  const reloaded = [];

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
