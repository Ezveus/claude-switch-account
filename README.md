# Claude Switch Account

Browser extension (Manifest V3) to keep **several claude.ai accounts** side by side and switch between them **in one click** — no logging out and back in every time.

[![build](https://github.com/Ezveus/claude-switch-account/actions/workflows/build.yml/badge.svg)](https://github.com/Ezveus/claude-switch-account/actions/workflows/build.yml)

[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/coffee.png)](https://www.buymeacoffee.com/smeagolworms4)
[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/paypal.png)](https://www.paypal.com/donate/?business=SURRPGEXF4YVU&no_recurring=0&item_name=Hello%2C+I%27m+SmeagolWorms4.+For+my+open+source+projects.%0AThanks+you+very+mutch+%21%21%21&currency_code=EUR)

**English** · [Français](README.fr.md)

<p align="center">
  <img src="docs/screenshot.png" alt="The extension popup listing three saved accounts, with the active one highlighted" width="380">
</p>

---

## About this fork

This fork exists to run code that has been read, and nothing else. It differs from upstream in that:

- it is **never published to a store**: the Chrome Web Store and AMO publishing jobs are removed, so no automatic update can bring in unreviewed code;
- it is installed with **Load unpacked** from a commit you have reviewed (see [Install](#install));
- its name ends with "(fork)", so it cannot be mistaken for the store version;
- saved sessions are **encrypted with a passphrase** (see [Security](#security--limitations)).

To take upstream changes, review them before merging:

```bash
git fetch upstream
git log --oneline main..upstream/main
git diff main...upstream/main
git merge upstream/main
```

Then reload the extension from `chrome://extensions` (or `vivaldi://extensions`).

## How it works

claude.ai authentication lives in cookies (`sessionKey` chief among them). The extension:

1. **snapshots** every `claude.ai` / `anthropic.com` cookie into a profile;
2. fetches the account **name and e-mail** from the claude.ai API to label it automatically;
3. on switching: re-saves the current session (the `sessionKey` rotates), clears the jar, restores the target profile's cookies, then reloads any open claude.ai tab.

Everything stays **local**: profile labels in `chrome.storage.local`, cookies in an encrypted vault next to them. No server, no telemetry, no passwords — only the cookies your browser already holds.

## Install

### From a release

1. Download the `.zip` from [Releases](https://github.com/Ezveus/claude-switch-account/releases) and unzip it.
2. Open `chrome://extensions` (or `vivaldi://extensions`, `brave://extensions`, `edge://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → pick the unzipped folder.

### From source

```bash
git clone https://github.com/Ezveus/claude-switch-account.git
cd claude-switch-account
```

Then load the folder directly with **Load unpacked**. There is no build step: plain JS, zero dependencies.

## Usage

| Action | Effect |
| --- | --- |
| **＋ Save current session** | Adds the logged-in account to the list (name + e-mail detected automatically) |
| **Click an account** | Switches to it and reloads claude.ai tabs |
| **⇥ New login** | Clears the session without deleting profiles — to add another account |
| **↻ Refresh active account** | Re-saves the active account's cookies (handy after re-authenticating) |
| **✎ / 🗑** | Rename / delete a profile |

### Adding a second account

1. Log into account A on claude.ai → **＋ Save current session**.
2. **⇥ New login** → log into account B.
3. **＋ Save current session**.
4. Both accounts now sit in the list; one click switches between them.

## Languages

UI translated through `chrome.i18n`, auto-selected from the browser language:

🇬🇧 English (default) · 🇫🇷 Français · 🇩🇪 Deutsch · 🇪🇸 Español · 🇮🇹 Italiano · 🇵🇹 Português

Adding a language = copy `_locales/en/messages.json` to `_locales/<code>/messages.json`. CI enforces that every locale carries exactly the same keys.

## Development

```
manifest.json          # MV3, cookies/storage/tabs permissions
background.js          # service worker: cookie snapshot / clear / restore
vault.js               # passphrase encryption of the saved cookies
tests/                 # node --test suites, with an in-memory chrome.* mock
popup.html/.css/.js    # account list UI
_locales/<lang>/       # translations
icons/                 # generated icons
tools/build.sh         # produces dist/claude-switch-account-<version>.zip
tools/make-icons.py    # regenerates the icons (needs Pillow)
```

```bash
bash tools/build.sh          # package
python3 tools/make-icons.py  # regenerate icons
```

### CI

`.github/workflows/build.yml` runs on every push, PR and tag:

- validates the manifest and **translation key parity** across all locales;
- checks JS syntax (`node --check`);
- runs the tests (`node --test tests/*.test.mjs`);
- builds the zip and uploads it as a downloadable **artifact**;
- on a `v*` tag: aligns `manifest.version` with the tag, creates the **GitHub release** with the zip attached.

Cutting a release:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

## Security & limitations

- Saved cookies are encrypted with AES-GCM-256, under a key derived from your passphrase with PBKDF2-SHA256 (600,000 iterations). The key lives in `chrome.storage.session`, which is memory-only: the vault locks again when the browser quits, and **🔒 Lock** locks it at once. The passphrase cannot be recovered; forgetting it means deleting the saved sessions.
- This protects the saved sessions at rest (disk, backups). It does not protect against malware running while the vault is unlocked, and the active session still sits in the browser's own cookie jar.
- Profiles saved by an earlier, unencrypted version move into the vault when you choose a passphrase. Chrome may keep the old plaintext copy on disk until it compacts its storage; to be safe, sign out of those sessions on claude.ai after migrating and save them again.
- Only one account is active **per browser profile** at a time: this is switching, not simultaneous isolation (for that, use Chrome profiles or Firefox containers).
- Unofficial extension, unaffiliated with Anthropic.
- Tested on Chrome / Brave / Edge. Firefox needs a manifest variant (`background.scripts`).

## Support

If this saves you time, coffee is appreciated:

[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/coffee.png)](https://www.buymeacoffee.com/smeagolworms4)
[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/paypal.png)](https://www.paypal.com/donate/?business=SURRPGEXF4YVU&no_recurring=0&item_name=Hello%2C+I%27m+SmeagolWorms4.+For+my+open+source+projects.%0AThanks+you+very+mutch+%21%21%21&currency_code=EUR)

## License

MIT
