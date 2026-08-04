// One-time local setup: mints a Google OAuth refresh token for read-only Sheets access,
// scoped to whichever Google account you run this as (needs at least Viewer access to the
// spreadsheet). Must be run on your own machine -- it opens a browser consent screen,
// which can't happen inside an unattended CI job or a headless agent session.
//
// Usage: npm run auth
import { exec } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env.local first.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh_token even if you've authorized this app before
  scope: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

function openInBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best-effort; the printed URL below is the real fallback
}

console.log('\nOpen this URL, sign in with the account that has Viewer access to the sheet:\n');
console.log(authUrl + '\n');
openInBrowser(authUrl);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${errorParam}. You can close this tab.`);
    console.error(`\nAuthorization failed: ${errorParam}`);
    server.close(() => process.exit(1));
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorized. You can close this tab and return to the terminal.');

    if (!tokens.refresh_token) {
      console.error(
        '\nNo refresh_token returned. This usually means the account already granted this app ' +
          'consent before. Revoke access at https://myaccount.google.com/permissions and re-run `npm run auth`.',
      );
      server.close(() => process.exit(1));
      return;
    }

    console.log('\nGOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log(
      '\nAdd that line to .env.local, and add the same value as a GitHub Actions secret ' +
        '(GOOGLE_OAUTH_REFRESH_TOKEN) for the sync workflow.',
    );
  } catch (err) {
    console.error('\nToken exchange failed:', err.message);
  } finally {
    server.close(() => process.exit(0));
  }
});

server.listen(PORT);
