import { test } from "node:test";
import assert from "node:assert/strict";
import * as Vault from "../vault.js";

const ITERATIONS = 1_000; // the real count is slow and proves nothing more here

test("a vault opens with its passphrase and gives back the secrets", async () => {
  const secrets = { a: { cookies: [{ name: "sessionKey", value: "sk-1" }] } };
  const { vault } = await Vault.create("correct horse", secrets, ITERATIONS);
  const { secrets: opened } = await Vault.unlock("correct horse", vault);
  assert.deepEqual(opened, secrets);
});

test("the vault never holds the cookie value in clear", async () => {
  const { vault } = await Vault.create("correct horse", { a: { cookies: [{ value: "sk-secret" }] } }, ITERATIONS);
  assert.ok(!JSON.stringify(vault).includes("sk-secret"));
});

test("a wrong passphrase is rejected", async () => {
  const { vault } = await Vault.create("correct horse", {}, ITERATIONS);
  await assert.rejects(Vault.unlock("wrong horse", vault));
});

test("altered ciphertext is rejected", async () => {
  const { key, vault } = await Vault.create("correct horse", { a: 1 }, ITERATIONS);
  const bytes = Uint8Array.from(atob(vault.data), (c) => c.charCodeAt(0));
  bytes[0] ^= 1;
  const tampered = { ...vault, data: btoa(String.fromCharCode(...bytes)) };
  await assert.rejects(Vault.open(key, tampered));
});

test("an exported key survives a round trip and re-seals with a fresh IV", async () => {
  const { key, vault } = await Vault.create("correct horse", { a: 1 }, ITERATIONS);
  const restored = await Vault.importKey(await Vault.exportKey(key));
  const resealed = await Vault.seal(restored, { a: 2 }, vault);
  assert.notEqual(resealed.iv, vault.iv);
  assert.deepEqual(resealed.kdf, vault.kdf);
  assert.deepEqual(await Vault.open(key, resealed), { a: 2 });
});

test("new vaults use the full iteration count by default", async () => {
  const { vault } = await Vault.create("correct horse", {});
  assert.equal(vault.kdf.iterations, Vault.KDF_ITERATIONS);
});
