// Completing an OAuth authorization step without a person at a browser.
//
// Two ways, both stopping at the redirect back to the client (nothing needs to
// listen on the redirect URI):
//   browser: headless Chromium through Playwright. Works with any sign-in page
//            that has a user field, a password field and a submit button.
//   form:    plain fetch: GET the page, fill the first <form>, POST, follow
//            redirects. No browser; good enough for the stub and for CI.
//
// Selectors can be overridden for a different sign-in page:
//   LOGIN_USER_SELECTOR, LOGIN_PASSWORD_SELECTOR, LOGIN_SUBMIT_SELECTOR

import { createRequire } from 'node:module';

export interface Credentials { user: string; password: string }
export type LoginMode = 'browser' | 'form';

export interface LoginOptions extends Credentials {
  /** The callback is recognised by this prefix (the registered redirect URI). */
  redirectUri: string;
  timeoutMs?: number;
  /** Save a screenshot of the sign-in page here (browser mode). */
  screenshot?: string;
}

export const USER_SEL = process.env.LOGIN_USER_SELECTOR ?? 'input[name="username"], input[name="user"], input[name="email"], input[type="email"]';
export const PASS_SEL = process.env.LOGIN_PASSWORD_SELECTOR ?? 'input[type="password"]';
export const SUBMIT_SEL = process.env.LOGIN_SUBMIT_SELECTOR ?? 'button[type="submit"], input[type="submit"]';

/** Load Playwright from wherever it is installed (it is preinstalled globally here). */
// Playwright is not a dependency of the repository (it is preinstalled here, with
// its browsers), so it is typed loosely.
export type Playwright = { chromium: { launch(options?: { proxy?: { server: string; bypass?: string } }): Promise<any> } };

export function loadPlaywright(): Playwright | undefined {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch { /* fall through */ }
  for (const dir of (process.env.NODE_PATH ?? '').split(':').filter(Boolean)) {
    try { return req(req.resolve('playwright', { paths: [dir] })); } catch { /* next */ }
  }
  return undefined;
}

export async function login(mode: LoginMode, authorizationUrl: string, opts: LoginOptions): Promise<URL> {
  return mode === 'browser' ? loginWithBrowser(authorizationUrl, opts) : loginWithForm(authorizationUrl, opts);
}

export async function loginWithBrowser(authorizationUrl: string, opts: LoginOptions): Promise<URL> {
  const pw = loadPlaywright();
  if (!pw) throw new Error('Playwright not found; use --login form');
  const launch: { proxy?: { server: string; bypass?: string } } = {};
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxy && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(authorizationUrl)) {
    launch.proxy = { server: proxy, bypass: 'localhost,127.0.0.1' };
  }
  const browser = await pw.chromium.launch(launch);
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();
    let callback: URL | undefined;
    const done = new Promise<URL>((resolve) => {
      // Watch for the redirect back to the client. Routes do not see redirect
      // hops, request events do; the browser's attempt to load the redirect URI
      // itself may fail, which does not matter.
      context.on('request', (r: { url(): string }) => {
        if (!callback && r.url().startsWith(opts.redirectUri)) { callback = new URL(r.url()); resolve(callback); }
      });
    });
    await page.goto(authorizationUrl, { timeout: opts.timeoutMs ?? 30_000 });
    if (!callback) {
      const userField = page.locator(USER_SEL).first();
      if (await userField.count()) await userField.fill(opts.user);
      await page.locator(PASS_SEL).first().fill(opts.password);
      if (opts.screenshot) await page.screenshot({ path: opts.screenshot });
      await page.locator(SUBMIT_SEL).first().click();
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no redirect to ${opts.redirectUri} within ${opts.timeoutMs ?? 30_000} ms; page: ${page.url()}`)), opts.timeoutMs ?? 30_000);
    });
    try { return await Promise.race([done, timeout]); } finally { clearTimeout(timer); }
  } finally {
    await browser.close();
  }
}

/**
 * Sign in on behalf of another client (OpenCode, Open WebUI): open its
 * authorization URL, fill the sign-in page, and let the browser follow the
 * redirect to that client's own callback, which must load. Returns the
 * callback URL the client received.
 */
export async function completeInBrowser(authorizationUrl: string, creds: Credentials, o: { timeoutMs?: number; screenshot?: string } = {}): Promise<URL> {
  const pw = loadPlaywright();
  if (!pw) throw new Error('Playwright not found');
  const timeoutMs = o.timeoutMs ?? 30_000;
  const authOrigin = new URL(authorizationUrl).origin;
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(authorizationUrl, { timeout: timeoutMs });
    if (new URL(page.url()).origin === authOrigin) {
      const userField = page.locator(USER_SEL).first();
      if (await userField.count()) await userField.fill(creds.user);
      await page.locator(PASS_SEL).first().fill(creds.password);
      await page.locator(SUBMIT_SEL).first().click();
      await page.waitForURL((u: URL) => u.origin !== authOrigin, { timeout: timeoutMs, waitUntil: 'load' });
    }
    if (o.screenshot) await page.screenshot({ path: o.screenshot });
    return new URL(page.url());
  } finally {
    await browser.close();
  }
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  const v = m ? (m[2] ?? m[3] ?? m[4]) : undefined;
  return v?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export async function loginWithForm(authorizationUrl: string, opts: LoginOptions): Promise<URL> {
  let res = await fetch(authorizationUrl, { redirect: 'manual' });
  let url = new URL(authorizationUrl);
  for (let hops = 0; hops < 10; hops++) {
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, url);
      if (next.href.startsWith(opts.redirectUri)) return next;
      url = next;
      res = await fetch(next, { redirect: 'manual' });
      continue;
    }
    if (res.status !== 200 && res.status !== 401) throw new Error(`sign-in page returned ${res.status}: ${await res.text()}`);
    const html = await res.text();
    const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i)?.[0];
    if (!form) throw new Error('no form on the sign-in page');
    const err = html.match(/id="error">([^<]*)</)?.[1];
    if (hops > 0 && err) throw new Error(`sign-in failed: ${err}`);
    const formTag = form.match(/<form\b[^>]*>/i)![0];
    const action = new URL(attr(formTag, 'action') ?? url.href, url);
    const body = new URLSearchParams();
    for (const input of form.match(/<input\b[^>]*>/gi) ?? []) {
      const name = attr(input, 'name');
      if (!name) continue;
      const type = (attr(input, 'type') ?? 'text').toLowerCase();
      if (type === 'password') body.set(name, opts.password);
      else if (/^(username|user|email)$/i.test(name)) body.set(name, opts.user);
      else body.set(name, attr(input, 'value') ?? '');
    }
    url = action;
    res = await fetch(action, {
      method: (attr(formTag, 'method') ?? 'post').toUpperCase(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body, redirect: 'manual',
    });
  }
  throw new Error('too many redirects during sign-in');
}
