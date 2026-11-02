# Setting up The Village Table

The Village Table is a Zoom App. It opens as a panel inside your community call. Parents type their 5-character code, you press one button, and Zoom's own breakout rooms are created and filled for you.

## What you need

- A Zoom account for the host with breakout rooms turned on (Zoom web portal, Settings, In Meeting (Advanced), Breakout room).
- A Zoom Marketplace developer account.
- A small server that stays on and has HTTPS. Do not use serverless hosting (for example plain Vercel functions). The app keeps each meeting's codes in memory only, and serverless functions forget everything between requests. Render, Railway, Fly.io, a DigitalOcean droplet or a Hostinger VPS all work. Node 18 or newer.
- The secret code key. It must be exactly the same in the intake form page and on this server.

## 1. Run the server

```
npm install
cp .env.example .env     # then fill it in
npm start
```

Environment variables:

| Name | What it is |
|---|---|
| `ZOOM_APP_CLIENT_ID`, `ZOOM_APP_CLIENT_SECRET` | From the Marketplace app's credentials page. |
| `CODE_KEY` | Your secret code key (8 or more plain ASCII characters). Same value as `CODE_KEY` near the top of the intake form page. |
| `ZOOM_APP_REDIRECT_URI` | The OAuth redirect URL you register in the Marketplace. Authorization happens inside Zoom, so the URL is registered but never visited. |
| `FORM_URL` | Link to your intake form. Shown to parents who have no code. |
| `ALLOW_CLIENT_ROLE` | Leave at `0`. See "First live test". |

## 2. Create the app in the Zoom Marketplace

Zoom changes the console's wording often, so use this as a checklist of what the app needs and follow Zoom's current screens.

- App type: a Zoom App (in-client app) that runs in meetings.
- Home URL: `https://YOUR-DOMAIN/`
- OAuth redirect URL: the same value as `ZOOM_APP_REDIRECT_URI`.
- Domain allow list: `YOUR-DOMAIN` and `appssdk.zoom.us`. If the allow list is wrong, Zoom shows a blank panel with no error.
- Scope: `zoomapp:inmeeting`.
- Zoom Apps SDK APIs to enable (the app asks for exactly these):
  `getMeetingContext`, `getUserContext`, `getAppContext`, `getMeetingUUID`, `getMeetingParticipants`, `onParticipantChange`, `createBreakoutRooms`, `assignParticipantToBreakoutRoom`, `configureBreakoutRooms`, `openBreakoutRooms`, `closeBreakoutRooms`, `getBreakoutRoomList`, `onBreakoutRoomChange`, `authorize`, `onAuthorized`.
- Turn on in-client OAuth (PKCE) if Zoom lists it as a setting.

## 3. First live test (about 15 minutes)

You need two things Zoom cannot be faked for: a host account and a second signed-in device.

1. Host starts a meeting and opens The Village Table from the Apps menu. You should see the host panel.
2. Check the server log. It prints a line starting `Zoom context fields seen:`. It should include `attendrole`. If it does, you are done with this step.
   If `attendrole` is missing, the server cannot tell who the host is from Zoom's own data. For this one test only, set `ALLOW_CLIENT_ROLE=1`, restart, and tell me what the log line said so I can fix it properly. Set it back to `0` afterwards.
3. On the second device, join signed in, open the app, tap Allow, and enter a code from the intake form.
4. The host panel should show 1 code in. Choose a mode, press Preview, then Open the tables.
5. The second device should be moved to a table. Press Close tables, then Clear all codes.

## 4. Things I could not test without a real Zoom client

These are the likely surprises. Each one is quick to check in the first live test.

1. **Parents outside your Zoom account.** As far as I know, people outside your own account can only add a Zoom App after Zoom has approved it in the Marketplace. Plan for Zoom's review time. Of everything here, this is the most likely thing to affect your schedule.
2. **Zoom version.** Creating tables needs desktop client 5.8.6 or newer, seating a parent needs 5.9.0, and custom table names need 5.12.6. Older clients still work but show default names.
3. **Existing breakout rooms are replaced.** Creating tables deletes any rooms already made in that meeting.
4. **Seating prompt.** The app asks Zoom to move people automatically. Depending on a parent's own Zoom settings they may still see a "join" prompt.
5. **Remembered codes.** The parent's code is saved in the app's storage on their own device, so they type it once and it is filled in on every later call. I could not confirm that Zoom's built-in browser keeps that storage between meetings. If it does not, parents are simply asked again, and nothing breaks. Test it by joining two separate meetings from the same computer.
6. **Server restarts.** If the server restarts mid-call, each parent's open panel sends their saved code again within about 45 seconds. A parent who has closed the panel is not covered, and shows up in the host's "still need a code" list until they reopen it.
7. **Host changes mid-call.** Zoom notes that a role can change after the app was opened. If the host hands over, the new host should reopen the app.

## 5. Adding cities later

Cities are stored as a numbered list in `server/model.js` (and the same list in the intake form page). The list holds up to 32 places in the current code format.

- Add new cities at the end of the list, never in the middle. Moving an existing city breaks every code already handed out.
- Past 32 places, the code needs one more character. That is a new code version. Ask me to extend it and old codes will keep working.

## 6. What the app stores and shows

- Nothing is written to disk or a database on our side. A parent's own code is remembered only on their own device, and they can clear it with "Use a different code."
- Nothing else is written to disk or a database. Each meeting's decoded answers sit in server memory, are deleted when you press Clear all codes, and are dropped automatically after 12 idle hours.
- The host sees counts, names of people who still need a code (names are already visible to the host in Zoom), and table sizes. The host never sees what a code says.
- Tables are named Table 1, Table 2, and so on, so room names reveal nothing. In a "by city" or "by country" mode, everyone at a table shares that trait, so the host can infer it for those tables. That cannot be avoided if you choose that mode.
- Parents never see why they were seated where they were.
