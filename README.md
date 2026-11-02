# The Village Table by GetParentWise

A Zoom App that reads each parent's private 5-character code and builds breakout rooms in the background.

- **Parents** open the app panel in the meeting and type their code once. It is remembered on their own device and filled in on later calls. Nothing about the code is shown back to them.
- **The host** chooses how tables form (smart match, random shuffle, or by country, city, child's age, season of life, or family description), how many people sit at each table, and when tables close. Then one button creates and opens Zoom's breakout rooms.
- **Leftovers** join the table they are most like, so a table can have one extra seat.
- **Privacy:** the code is decoded on the server, kept in memory only, and discarded when the host clears it. The host never sees what a code says.

See `SETUP.md` to get it running.

## Layout

```
server/model.js      cities, bands and options (order is part of the code format)
server/codec.js      encode and decode the 5-character code
server/matcher.js    closeness scoring and table building
server/context.js    verifies who Zoom says is calling
server/store.js      memory-only meeting store
server/app.js        the web server and its rules
public/              the panels parents and hosts see inside Zoom
test/                61 automated tests
```

## Tests

```
npm install
npx playwright install chromium   # only needed for the browser tests
npm test
```

The tests include: cross-checking every code against the original Python encoder, an exact-best-answer benchmark for the matcher, security checks on who may do what, and full simulated meetings in a real browser with a stand-in for Zoom's SDK.
