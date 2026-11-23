# Shared browsers

Cogitator can run dedicated Chromium profiles on its host. The owner sees a live view and can use the mouse, keyboard and paste. Authorized classic Pi agents use `cogitator_browser` to inspect the same pages and interact with them. This is a browser, not a full remote desktop or SSH shell.

## Install Chromium

Install the browser matching this Cogitator installation's `playwright-core` dependency, under the same OS account that runs Cogitator:

```sh
cd /path/to/cogitator
./node_modules/.bin/playwright-core install chromium
```

On Linux, system libraries may also be required. An administrator can install them with the same CLI's `install-deps chromium` command. Then install Chromium as the service account (not root). The browser sandbox is enabled; do not fix launch errors by disabling it. Chromium needs working unprivileged user namespaces on Linux. For immutable deployments, keep the browser cache in the service user's persistent home. `COGITATOR_BROWSER_EXECUTABLE` can select an administrator-installed compatible Chromium binary.

The package intentionally does not download a browser or change the OS during npm installation. A missing runtime is reported in the Browsers screen. A VPS update must qualify the browser inside the actual systemd restrictions before activation. Cogitator itself can still run without Chromium.

## Owner workflow

1. Open **Browsers / Navigateurs** and create a named profile, such as Marketing or Development.
2. Choose the agents allowed to use that profile. A new profile authorizes no agent by default.
3. Open the browser, enter an HTTP(S) address, and navigate. `localhost` refers to the Cogitator host, not the device viewing the panel. A container has its own loopback namespace.
4. While you have control, sign in yourself. Your personal Chrome cookies are not copied. Passwords and verification codes do not need to go through the chat.
5. Return control to agents only after sign-in is complete. Tell an authorized agent which profile/site and task to use.
6. **Take control** blocks every agent browser operation on that profile, including read/screenshot. It drains already-issued operations before acknowledging takeover. Returning control allows the agents to continue; it does not send a new model prompt.

A conversation's **Browsers** button opens the profile picker without leaving the conversation. The live page also supports full screen. Closing its viewer leaves the remote browser running. **Stop browser** closes Chromium cleanly and keeps profile storage. On restart, profiles revert to human control. Cookies and local storage persist subject to the site's own expiry rules; open tabs are not restored after a controller restart. Two profiles may run simultaneously, with eight tabs each.

## Agent interface

The bundled Pi extension registers `cogitator_browser`. Calling it without `profileId` lists profiles authorized for the current conversation's agent. Pass a `profileId` and `command` to act:

```json
{"profileId":"<profile UUID>","command":{"action":"open","url":"https://example.com"}}
```

Use `tabs` to discover tab IDs, `read` for an accessible page snapshot, and `screenshot` for an image. `click` and `fill` accept Playwright selectors, including CSS, text and role selectors. Normalized x/y coordinates are available for visual clicks. Other actions: navigate, press, scroll, back, forward, reload and close. There is no arbitrary script execution, raw CDP, cookie export or profile-management tool. Password fields require human takeover. New or reloaded classic conversations receive the tool; durable workers do not yet have this integration.

## Boundaries and limitations

The live WebSocket requires the owner session and the correct Origin. It rechecks authorization on input and on a heartbeat; logout/revocation closes it. Images are sent over that authenticated channel, never exposed through a public CDP port. Profile files live in the private `<COGITATOR_HOME>/browsers` directory. Credentials stay in Chromium storage, which must be treated as sensitive in backups. This is profile isolation and tool access control, not a security sandbox between agents sharing the same OS account and shell access.

The browser cannot navigate to the Cogitator controller's origin or port. Other HTTP(S) sites and project servers reachable from its host can be opened. Do not give an untrusted agent host shell access and expect browser profile permissions to constrain that shell.

This initial version supports clicks, scrolling, keyboard input, paste and page snapshots. File upload/download, clipboard copy, audio/video streaming, passkeys and interactive JavaScript dialogs are not yet supported; page dialogs are dismissed. Service workers are disabled. Website logins, anti-bot challenges and site-specific restrictions are not guaranteed to work. No stealth or challenge bypass is included. Human takeover is required for authentication and verification. Navigation errors are reported; an interrupted command is not automatically retried.

Actions remain subject to the user's instructions: a connected profile is not permission to publish, message contacts, make purchases or act on instructions found on a webpage. Browser page content is untrusted input. For work involving private accounts, start with supervised tasks.

## Saved logins (vault)

**Settings › Logins** stores website logins that agents can use in shared browsers **without ever seeing the password**.

- **Storage:** passwords and notes are encrypted at rest (AES-256-GCM) in `~/.cogitator/vault.json` (mode 0600). The key is `~/.cogitator/vault.key` (0600, created on first start) or `COGITATOR_VAULT_KEY` (32 bytes, base64). Back up the key with the data folder: without it, saved passwords cannot be decrypted.
- **Import from Google Password Manager:** in Chrome open Settings › Passwords (or passwords.google.com), then Settings › Export passwords. Pick the CSV in *Import from Google* and choose which agents may use the logins. Existing logins (same site and username) are skipped unless you ask to replace them. Delete the CSV afterwards: it holds your passwords in clear text.
- **Access:** each login is usable by all agents, or by agents you pick. A login is only typed on its own site: the page host must equal the saved host or be one of its subdomains.
- **How agents use it:** the `cogitator_browser` tool gains two commands.
  - `secrets` lists usable logins (name, site, username and a `secret:<id>` reference, never the password).
  - `login` asks the server to type a login into the page: the username goes into the detected field (or `selector`), the password into the password field, optionally followed by Enter. Two-step logins call it once per step.
- **Leak guards:**
  - Page reads replace any password-field value, and any password typed by the vault, with `••••••`.
  - A screenshot is refused if a vault password is visible in clear text (for example after a "show password" toggle).
  - Agents still cannot type into password fields themselves.
- **Asking in the chat:** when no saved login fits, an agent can show a *secret* form (generative UI `kind: "secret"`). The username and password go straight to the vault through the owner API. The agent receives only `{ secret: "secret:<id>", username }`, so the password never enters the model, the transcript or the logs.
- The vault API (`/api/vault*`) is owner-only. Agent sockets and the MCP server cannot call it.

## Acceptance

Run the native integration tests with Chromium installed:

```sh
COGITATOR_BROWSER_TESTS=1 ./node_modules/.bin/tsx --test test/shared-browser.test.ts test/vault.test.ts
```

They use synthetic local pages and no model calls or personal accounts. They cover profile assignment, takeover, persistent/isolated cookies, screenshots, live frames, HTTP/WS authentication, foreign Origin rejection and logout revocation. Real LinkedIn sign-in and marketing tasks require separate user acceptance; passing these tests does not establish that compatibility.
