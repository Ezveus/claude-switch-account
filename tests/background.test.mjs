import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createChrome } from "./chrome-mock.mjs";

let b;
let loads = 0;

// background.js registers its listener at import time, so each test imports a
// fresh copy against a fresh mock.
beforeEach(async () => {
  b = createChrome();
  globalThis.chrome = b.chrome;
  let n = 0;
  globalThis.fetch = async () => ({ ok: true, text: async () => `{"email_address":"user${++n}@example.com"}` });
  await import(`../background.js?load=${loads++}`);
});

const PASS = "correct horse battery";

test("the popup starts on the setup form", async () => {
  assert.equal((await b.send("getState")).vault, "none");
});

test("saving a session needs the vault", async () => {
  b.login("sk-pro");
  await assert.rejects(b.send("addCurrent"), /errLocked/);
});

test("short passphrases are refused", async () => {
  await assert.rejects(b.send("setupVault", { passphrase: "short" }), /errPassphraseShort/);
});

test("no cookie value reaches chrome.storage.local in clear", async () => {
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  await b.send("addCurrent");
  assert.ok(!JSON.stringify(b.chrome.storage.local.dump()).includes("sk-pro"));
});

test("switching restores each account's own session", async () => {
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  const afterPro = await b.send("addCurrent");
  await b.send("freshSession");
  b.login("sk-perso");
  const afterPerso = await b.send("addCurrent");

  const pro = afterPro.state.accounts[0].id;
  const perso = afterPerso.state.accounts.find((a) => a.id !== pro).id;

  await b.send("switchTo", { id: pro });
  assert.equal(b.sessionKey(), "sk-pro");
  await b.send("switchTo", { id: perso });
  assert.equal(b.sessionKey(), "sk-perso");
});

test("a restart locks the vault and the passphrase unlocks it", async () => {
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  const { state } = await b.send("addCurrent");
  b.restart();

  assert.equal((await b.send("getState")).vault, "locked");
  await assert.rejects(b.send("switchTo", { id: state.accounts[0].id }), /errLocked/);
  await assert.rejects(b.send("unlock", { passphrase: "wrong horse battery" }), /errBadPassphrase/);
  assert.equal((await b.send("unlock", { passphrase: PASS })).vault, "unlocked");
});

test("a profile without a saved session cannot log the browser out", async () => {
  // Listed in the profiles, but with nothing in the vault to restore.
  await b.chrome.storage.local.set({ cmc_state: { accounts: [{ id: "ghost", label: "Ghost" }], activeId: null } });
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  await assert.rejects(b.send("switchTo", { id: "ghost" }), /errNotFound/);
  assert.equal(b.sessionKey(), "sk-pro");
});

test("plaintext profiles from before the fork move into the vault", async () => {
  await b.chrome.storage.local.set({
    cmc_state: {
      accounts: [{ id: "old", label: "Old", cookies: [{ name: "sessionKey", value: "sk-old", domain: "claude.ai", path: "/", secure: true, hostOnly: true, session: true, storeId: "0" }] }],
      activeId: null
    }
  });
  const view = await b.send("setupVault", { passphrase: PASS });

  assert.ok(!JSON.stringify(b.chrome.storage.local.dump()).includes("sk-old"));
  assert.ok(!("cookies" in view.state.accounts[0]));
  await b.send("switchTo", { id: "old" });
  assert.equal(b.sessionKey(), "sk-old");
});

test("the popup never receives cookies", async () => {
  await b.chrome.storage.local.set({ cmc_state: { accounts: [{ id: "old", cookies: [{ value: "sk-old" }] }], activeId: null } });
  assert.ok(!JSON.stringify(await b.send("getState")).includes("sk-old"));
});

test("reset drops the profiles but keeps the live session", async () => {
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  await b.send("addCurrent");
  const view = await b.send("resetVault");
  assert.equal(view.vault, "none");
  assert.deepEqual(view.state.accounts, []);
  assert.equal(b.sessionKey(), "sk-pro");
});

test("removing an account drops its secret", async () => {
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  const { state } = await b.send("addCurrent");
  await b.send("remove", { id: state.accounts[0].id });
  await assert.rejects(b.send("switchTo", { id: state.accounts[0].id }), /errNotFound/);
});

/* ---------------------------------------------------------- localStorage --- */

async function twoAccounts() {
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  b.setStorage({ "LSS-code-selected-repo": "moduloTech/modulorails" });
  const pro = (await b.send("addCurrent")).state.accounts[0].id;
  await b.send("freshSession");
  b.login("sk-perso");
  b.setStorage({ theme: "dark" });
  const perso = (await b.send("addCurrent")).state.accounts.find((a) => a.id !== pro).id;
  return { pro, perso };
}

test("each account gets its own localStorage back", async () => {
  const { pro, perso } = await twoAccounts();

  await b.send("switchTo", { id: pro });
  assert.deepEqual(b.storage(), { "LSS-code-selected-repo": "moduloTech/modulorails" });
  await b.send("switchTo", { id: perso });
  assert.deepEqual(b.storage(), { theme: "dark" });
});

test("the open claude.ai tab shows the account switched to", async () => {
  const { pro, perso } = await twoAccounts();

  await b.send("switchTo", { id: pro });
  await b.settle();
  assert.deepEqual(b.shownRepos(), ["moduloTech/modulorails"]);
  await b.send("switchTo", { id: perso });
  await b.settle();
  assert.deepEqual(b.shownRepos(), [null]);
});

test("what an account writes before leaving is kept for its return", async () => {
  const { pro, perso } = await twoAccounts();
  await b.send("switchTo", { id: pro });
  b.setStorage({ "LSS-code-selected-repo": "moduloTech/other" });
  await b.send("switchTo", { id: perso });
  await b.send("switchTo", { id: pro });
  assert.deepEqual(b.storage(), { "LSS-code-selected-repo": "moduloTech/other" });
});

test("a new login starts from an empty localStorage", async () => {
  await b.send("setupVault", { passphrase: PASS });
  b.login("sk-pro");
  b.setStorage({ "LSS-code-selected-repo": "moduloTech/modulorails" });
  await b.send("addCurrent");
  await b.send("freshSession");
  assert.deepEqual(b.storage(), {});
});

test("the saved localStorage is encrypted too", async () => {
  await twoAccounts();
  assert.ok(!JSON.stringify(b.chrome.storage.local.dump()).includes("modulorails"));
});

test("a failing storage tab leaves both session and storage alone", async () => {
  const { pro } = await twoAccounts();
  b.breakStorageTab();
  await assert.rejects(b.send("switchTo", { id: pro }));
  assert.equal(b.sessionKey(), "sk-perso");
  assert.deepEqual(b.storage(), { theme: "dark" });
});

test("claude.ai tabs go back where they were, even when the swap fails", async () => {
  const { pro, perso } = await twoAccounts();
  await b.send("switchTo", { id: pro });
  assert.deepEqual(b.tabUrls(), ["https://claude.ai/new"]);
  b.breakStorageTab();
  await assert.rejects(b.send("switchTo", { id: perso }));
  assert.deepEqual(b.tabUrls(), ["https://claude.ai/new"]);
});

test("a storage tab opened for reading is closed again", async () => {
  const { pro } = await twoAccounts();
  await b.send("switchTo", { id: pro });
  b.breakStorageTab();
  await assert.rejects(b.send("refreshActive"));
  assert.deepEqual(b.tabUrls(), ["https://claude.ai/new"]);
});

test("the swap works with no claude.ai tab open", async () => {
  const { pro, perso } = await twoAccounts();
  b.closeAllTabs();
  await b.send("switchTo", { id: pro });
  assert.deepEqual(b.storage(), { "LSS-code-selected-repo": "moduloTech/modulorails" });
  await b.send("switchTo", { id: perso });
  assert.deepEqual(b.storage(), { theme: "dark" });
  assert.deepEqual(b.tabUrls(), []);
});
