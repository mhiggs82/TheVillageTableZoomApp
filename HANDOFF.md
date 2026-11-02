# Hand-off brief for Claude Code

Paste the section below into Claude Code, opened in this project's folder.

---

You are taking over "The Village Table by GetParentWise", a Zoom App (Node 18+, Express, plain browser JavaScript) that reads a parent's private 5-character code and builds Zoom breakout rooms. Read README.md and SETUP.md first. The code is finished and tested: run `npm install` then `npm test`. All 61 tests must pass (the 5 browser tests need `npx playwright install chromium`).

## Rules that must not be broken

- Privacy: nothing about a parent's answers is ever written to disk, a database or a log. Codes are decoded in server memory only. The host must never see what a code says. Table names stay neutral ("Table 1").
- The code format in `server/codec.js` and `server/model.js` must stay byte-compatible with `test/fixtures/python-vectors.json` and with the intake form. Only append cities, never reorder.
- Never commit secrets or a `.env` file. I will type secrets into Render myself.
- No em dashes in any text I will read or any copy in the app.
- Do not weaken a test to make it pass. If a test fails, tell me why.

## Do these things

1. Create a private GitHub repository from this folder and push it (ask me to sign in if needed).
2. Create a Render free web service from it: build `npm install --omit=dev`, start `npm start`, health check `/healthz`, region Frankfurt. Tell me which environment variables to enter (see `.env.example`), and wait for me to enter them.
3. Add the custom domain `villagetable.getparentwise.com` in Render. Give me the CNAME target. Add the matching CNAME record in Spaceship DNS if you have access; otherwise tell me the exact record.
4. Confirm `https://villagetable.getparentwise.com/healthz` returns `{"ok":true}` and the security headers are present.
5. DONE: the intake form is served at `/code` and codes are made on the server (`POST /api/encode`), so the key never reaches a browser. Update `FORM_URL` guidance in SETUP.md. Add a test.
6. Walk me through creating the Zoom Marketplace app using the checklist in SETUP.md, then through the first live test.

## Stop and ask me before

- Spending money or adding a payment method.
- Changing the code format, the privacy behaviour, or the matching weights.
- Anything in the Zoom Marketplace console (I do those steps, you guide).
