import { createApp } from './app.js';

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`Missing environment variable ${name}. See .env.example and SETUP.md.`); process.exit(1); }
  return v;
};

const app = createApp({
  clientId: need('ZOOM_APP_CLIENT_ID'),
  clientSecret: need('ZOOM_APP_CLIENT_SECRET'),
  codeKey: need('CODE_KEY'),
  redirectUri: process.env.ZOOM_APP_REDIRECT_URI || '',
  formUrl: process.env.FORM_URL || '',
  allowClientRole: process.env.ALLOW_CLIENT_ROLE === '1',
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`The Village Table is listening on port ${port}`));
