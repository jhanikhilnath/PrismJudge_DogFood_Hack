import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = path.resolve('docs/screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Spin up headless Chrome on port 9222
const chromeProc = spawn('/usr/bin/google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--remote-debugging-port=9222',
  '--user-data-dir=/tmp/dogfood-chrome-ss-' + Date.now(),
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

// Wait for Chrome debugging port to open
async function waitForChrome(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('http://localhost:9222/json/version');
      if (res.ok) {
        const json = await res.json();
        return json.webSocketDebuggerUrl;
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error('Chrome remote debugging did not become available.');
}

async function run() {
  try {
    const wsUrl = await waitForChrome();
    console.log('Connected to Chrome WebSocket:', wsUrl);

    // Create a new target/tab
    const newTabRes = await fetch('http://localhost:9222/json/new', { method: 'PUT' });
    const tabInfo = await newTabRes.json();
    const tabWsUrl = tabInfo.webSocketDebuggerUrl;

    const ws = new WebSocket(tabWsUrl);
    let idCounter = 1;
    const pending = new Map();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    function sendCommand(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = idCounter++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await sendCommand('Page.enable');
    await sendCommand('Network.enable');

    const targets = [
      {
        name: 'hero.png',
        url: 'http://localhost:8080/',
        cookie: null,
      },
      {
        name: 'gallery.png',
        url: 'http://localhost:8080/projects',
        cookie: null,
      },
      {
        name: 'project_detail.png',
        url: 'http://localhost:8080/projects/prj_01',
        cookie: null,
      },
      {
        name: 'ballot.png',
        url: 'http://localhost:8080/vote',
        cookie: null,
      },
      {
        name: 'judge_dashboard.png',
        url: 'http://localhost:8080/judge/dashboard',
        cookie: { name: 'session', value: 'jdg_a_91bc', domain: 'localhost', path: '/' },
      },
      {
        name: 'pairwise_arena.png',
        url: 'http://localhost:8080/judge/pairwise',
        cookie: { name: 'session', value: 'jdg_a_91bc', domain: 'localhost', path: '/' },
      },
      {
        name: 'organizer_console.png',
        url: 'http://localhost:8080/organizer/dashboard',
        cookie: { name: 'session', value: 'org_7f2a', domain: 'localhost', path: '/' },
      },
      {
        name: 'event_settings.png',
        url: 'http://localhost:8080/organizer/settings?tab=timeline',
        cookie: { name: 'session', value: 'org_7f2a', domain: 'localhost', path: '/' },
      },
      {
        name: 'results_portal.png',
        url: 'http://localhost:8080/results',
        cookie: { name: 'session', value: 'org_7f2a', domain: 'localhost', path: '/' },
      },
      {
        name: 'teams_credentials.png',
        url: 'http://localhost:8080/organizer/teams',
        cookie: { name: 'session', value: 'org_7f2a', domain: 'localhost', path: '/' },
      },
      {
        name: 'certificate_honors.png',
        url: 'http://localhost:8080/certificates/prj_01',
        cookie: { name: 'session', value: 'usr_part_33aa', domain: 'localhost', path: '/' },
      },
      {
        name: 'certificate_judge.png',
        url: 'http://localhost:8080/certificates/judge/jdg_01',
        cookie: { name: 'session', value: 'jdg_a_91bc', domain: 'localhost', path: '/' },
      },
    ];

    for (const t of targets) {
      console.log(`Capturing ${t.name}...`);
      await sendCommand('Network.clearBrowserCookies');
      if (t.cookie) {
        await sendCommand('Network.setCookie', t.cookie);
      }

      await sendCommand('Page.navigate', { url: t.url });
      // Wait for page to render and styles to settle
      await new Promise(r => setTimeout(r, 1200));

      const { data } = await sendCommand('Page.captureScreenshot', {
        format: 'png',
        quality: 100,
        captureBeyondViewport: false,
      });

      const buffer = Buffer.from(data, 'base64');
      fs.writeFileSync(path.join(SCREENSHOT_DIR, t.name), buffer);
      console.log(`Saved ${t.name} (${buffer.length} bytes)`);
    }

    ws.close();
  } catch (err) {
    console.error('Screenshot capture error:', err);
  } finally {
    chromeProc.kill('SIGKILL');
  }
}

run();
