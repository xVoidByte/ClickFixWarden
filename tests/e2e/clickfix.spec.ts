import { BASE, detectionCount, expect, lastDetection, overlayShown, readClipboard, site, test, writeClipboard } from './fixtures';

const SAFE = 'ClickFix Warden';

test.beforeEach(async ({ context }) => {
  // Nothing in these tests may reach the internet. Blockchain lookups get a canned answer.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|[^/]*\.test[:/])/, (route) => route.abort());
  await context.route(/bnbchain\.org|binance\.org/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":"0x"}' }),
  );
});

test.describe('lure pages', () => {
  test('fake Turnstile box using clipboard.writeText', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/turnstile-writetext.html');
    await page.click('#cb');
    await expect(page).toHaveTitle('written');
    const clip = await readClipboard(page);
    expect(clip).toContain(SAFE);
    expect(clip).not.toContain('iwr');
    await expect.poll(() => overlayShown(page)).toBe(true);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('clipboard');
  });

  test('fake reCAPTCHA using a hidden textarea and execCommand', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/recaptcha-execcommand.html');
    await page.click('#captcha');
    await expect(page).toHaveTitle(/copied/);
    const clip = await readClipboard(page);
    expect(clip).toContain(SAFE);
    expect(clip).not.toContain('mshta');
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('clipboard');
  });

  test('clipboard.write with a ClipboardItem', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/clipboarditem-write.html');
    await page.click('#go');
    await expect(page).toHaveTitle('written');
    expect(await readClipboard(page)).toContain(SAFE);
  });

  test('copy handler that swaps in a payload with setData', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/copy-event-setdata.html');
    await page.click('#fix');
    await expect(page).toHaveTitle(/copied/);
    const clip = await readClipboard(page);
    expect(clip).toContain(SAFE);
    expect(clip).not.toContain('finger');
  });

  test('borrowing an unwrapped clipboard from a fresh iframe', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/iframe-bypass.html');
    await page.click('#cb');
    await expect(page).toHaveTitle(/written|error/);
    expect(await readClipboard(page)).not.toContain('conhost');
  });

  test('FileFix path padded with blank space', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/filefix.html');
    await page.click('#open');
    await expect(page).toHaveTitle('written');
    expect(await readClipboard(page)).toContain(SAFE);
  });

  test('macOS Terminal lure with Base64 into bash', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/macos-terminal.html');
    await page.click('#copy');
    await expect(page).toHaveTitle('written');
    expect(await readClipboard(page)).toContain(SAFE);
  });

  test('plain download-and-run caught by the Win+X instructions', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/winx-plain.html');
    await page.click('#go');
    await expect(page).toHaveTitle('written');
    expect(await readClipboard(page)).toContain(SAFE);
  });

  test('an instruction box injected late into a long busy page, inside a closed shadow root, is found', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/shadow-box-late.html');
    await expect.poll(() => overlayShown(page), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('page-instructions');
  });

  test('a wrapper that swaps in a command under harmless text is still checked', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/wrapper-swaps-text.html');
    await page.click('#cb');
    await expect(page).toHaveTitle('written');
    expect(await readClipboard(page)).toContain(SAFE);
  });

  test('a fake check made of a plain div still counts as a lure box', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/div-checkbox.html');
    await expect.poll(() => overlayShown(page), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('page-instructions');
  });

  test('a later recheck never replaces something the visitor copied in the meantime', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/late-instructions.html');
    await page.click('#box');
    await expect(page).toHaveTitle('written');
    // The visitor copies their own text before the rechecks run.
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('h1')!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(9000);
    expect(await readClipboard(page)).toContain('example-shop.invalid');
  });

  test('a writeText wrapped later by someone else still reaches our check first', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/wrapped-by-another.html');
    await page.click('#cb');
    await expect.poll(() => overlayShown(page)).toBe(true);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('clipboard');
  });

  test('borderline command is stopped when the paste steps appear after the copy', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/late-instructions.html');
    await page.click('#box');
    await expect(page).toHaveTitle('written');
    await expect.poll(() => readClipboard(page), { timeout: 10_000 }).toContain(SAFE);
    await expect.poll(() => overlayShown(page)).toBe(true);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('clipboard');
  });

  test('borderline command whose download address is reported', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/payload-reported.html');
    await page.click('#go');
    await expect(page).toHaveTitle('written');
    await expect.poll(() => readClipboard(page)).toContain(SAFE);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('clipboard');
  });

  test('typing the copy by hand with Ctrl+C', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/manual-copy.html');
    await writeClipboard(page, 'before');
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('cmd')!);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press('Control+C');
    await expect.poll(() => readClipboard(page)).toContain(SAFE);
  });

  test('ConsentFix paste of a sign-in code link', async ({ context, sw }) => {
    const page = await context.newPage();
    // The clipboard API needs a secure page, so copy on 127.0.0.1 and run the lure on its own host, since 127.0.0.1 may receive sign-in links.
    await page.goto(BASE + '/site.html');
    await writeClipboard(page, 'http://localhost:53682/?code=0.AXEAabcdefghijklmnopqrstuvwxyz1234567890&state=xyz123');
    await page.goto(site('phish.test', '/lures/consentfix.html'));
    await page.click('#code');
    await page.keyboard.press('Control+V');
    await expect.poll(() => overlayShown(page)).toBe(true);
    expect(await page.inputValue('#code')).toBe('');
    const last = await sw.evaluate(async () => ((await chrome.storage.local.get('log')).log as Record<string, unknown>[])[0]);
    expect(last.kind).toBe('paste');
    expect(JSON.stringify(last)).not.toContain('abcdefghij');
  });

  test('applescript link that opens Script Editor', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/applescript-link.html');
    await page.click('#open');
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('protocol');
    expect(page.url()).toContain('/lures/applescript-link.html');
  });

  test('window.open to a search-ms link on a remote share', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/applescript-link.html');
    await page.click('#scripted');
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('protocol');
  });

  test('fake Windows Update trying full screen and keyboard lock', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/jackfix-fullscreen.html');
    await page.click('#go');
    await expect(page).toHaveTitle(/fullscreen NotAllowedError/);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('fullscreen');
  });

  test('hacked site loading code from a test-network smart contract', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/clearfake-web3.html');
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('web3-loader');
    await expect.poll(() => overlayShown(page)).toBe(true);
  });

  test('Leave this site button takes the tab away', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/lures/turnstile-writetext.html');
    await page.click('#cb');
    await expect.poll(() => overlayShown(page)).toBe(true);
    // The dialog focuses its Leave button, the shadow root is closed so the keyboard drives it.
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url()).not.toContain('turnstile-writetext');
  });
});

test.describe('normal pages stay untouched', () => {
  test('documentation copy buttons keep their commands', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/benign/docs-copy-buttons.html');
    const blocks = page.locator('.block');
    const count = await blocks.count();
    for (let i = 0; i < count; i++) {
      const expected = (await blocks.nth(i).locator('pre').textContent())!;
      await blocks.nth(i).locator('button').click();
      await expect.poll(() => readClipboard(page)).toBe(expected);
    }
    expect(await overlayShown(page)).toBe(false);
    expect(await detectionCount(sw)).toBe(0);
  });

  test('support article with a Win+R step raises nothing', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/benign/support-article.html');
    await page.click('#copy');
    await expect.poll(() => readClipboard(page)).toBe('msconfig');
    await page.waitForTimeout(3000);
    expect(await overlayShown(page)).toBe(false);
    expect(await detectionCount(sw)).toBe(0);
  });

  test('long news article about ClickFix raises nothing', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/benign/security-news.html');
    await page.waitForTimeout(3000);
    expect(await overlayShown(page)).toBe(false);
    expect(await detectionCount(sw)).toBe(0);
  });

  test('news article that quotes a lure next to share buttons raises nothing', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/benign/news-quotes-lure.html');
    await page.waitForTimeout(4000);
    expect(await overlayShown(page)).toBe(false);
    expect(await detectionCount(sw)).toBe(0);
  });

  test('blog post that quotes a lure next to a checklist and share icons raises nothing', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/benign/blog-quotes-lure.html');
    await page.waitForTimeout(4000);
    expect(await overlayShown(page)).toBe(false);
    expect(await detectionCount(sw)).toBe(0);
  });

  test('video player can still go full screen', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/benign/fullscreen-video.html');
    await page.click('#fs');
    await expect(page).toHaveTitle('fullscreen ok');
    expect(await detectionCount(sw)).toBe(0);
  });

  test('wallet dashboard on the main network raises nothing', async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(BASE + '/benign/dapp-mainnet.html');
    await page.waitForTimeout(2500);
    expect(await overlayShown(page)).toBe(false);
    expect(await detectionCount(sw)).toBe(0);
  });
});

test.describe('reputation', () => {
  test('reported malware site is stopped before it loads with a malware warning', async ({ context, sw, extId }) => {
    const page = await context.newPage();
    await page.goto(site('reported.test')).catch(() => undefined);
    await expect.poll(() => page.url()).toContain(`chrome-extension://${extId}/warning.html`);
    await expect(page.locator('#lead')).toContainText('can infect your computer');
    await expect(page.locator('.advice')).toBeHidden();
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('reputation-block');
  });

  test('with blocking before load turned off a reported site shows the warning bar', async ({ context, sw }) => {
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ settings: { blockPage: false } });
    });
    await expect
      .poll(() => sw.evaluate(async () => ((await chrome.storage.local.get('effective')).effective as { settings: { blockPage: boolean } } | undefined)?.settings.blockPage))
      .toBe(false);
    const page = await context.newPage();
    await page.goto(site('reported.test'));
    await expect.poll(() => overlayShown(page)).toBe(true);
    await expect.poll(async () => (await lastDetection(sw))?.kind).toBe('reputation');
  });

  test('known ClickFix site is stopped before it loads, Continue anyway opens it', async ({ context, extId }) => {
    const page = await context.newPage();
    await page.goto(site('clickfix-site.test')).catch(() => undefined);
    await expect.poll(() => page.url()).toContain(`chrome-extension://${extId}/warning.html`);
    await expect(page.locator('#reports')).toContainText('ThreatFox');
    await expect(page.locator('#lead')).toContainText('a ClickFix page that spreads ClearFake');
    // Opening it anyway needs the risk box ticked first.
    await page.click('#continue');
    const confirm = page.locator('.g-btn.danger');
    await expect(confirm).toBeDisabled();
    await page.locator('.g-check input').check();
    await confirm.click();
    await expect.poll(() => page.url()).toBe(site('clickfix-site.test'));
    await expect.poll(() => overlayShown(page)).toBe(true);
  });

  test('download link from the daily URLhaus part is stopped before it loads', async ({ context, extId }) => {
    const page = await context.newPage();
    await page.goto(site('download.test', '/setup.exe')).catch(() => undefined);
    await expect.poll(() => page.url()).toContain(`chrome-extension://${extId}/warning.html`);
    await expect(page.locator('#reports')).toContainText('URLhaus');
  });

  test('hourly change list adds and removes reports', async ({ context, sw, extId }) => {
    const before = await sw.evaluate(async () => ((await chrome.storage.local.get('feedMeta')).feedMeta as { hotGenerated: string }).hotGenerated);
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extId}/popup.html`);
    await ext.evaluate(() => (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }).chrome.runtime.sendMessage({ type: 'update-now' }));
    await expect
      .poll(() => sw.evaluate(async () => ((await chrome.storage.local.get('feedMeta')).feedMeta as { hotGenerated: string }).hotGenerated))
      .not.toBe(before);
    const added = await context.newPage();
    await added.goto(site('delta-added.test')).catch(() => undefined);
    await expect.poll(() => added.url()).toContain(`chrome-extension://${extId}/warning.html`);
    const removed = await context.newPage();
    await removed.goto(site('payload-reported.test'));
    await removed.waitForTimeout(2000);
    expect(await overlayShown(removed)).toBe(false);
  });

  test('trusted site is not checked', async ({ context, sw }) => {
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ settings: { trustedSites: ['reported.test'] } });
    });
    await expect
      .poll(() => sw.evaluate(async () => ((await chrome.storage.local.get('effective')).effective as { settings: { trustedSites: string[] } } | undefined)?.settings.trustedSites ?? []))
      .toContain('reported.test');
    const page = await context.newPage();
    await page.goto(site('reported.test'));
    await page.waitForTimeout(2000);
    expect(await overlayShown(page)).toBe(false);
  });
});

test.describe('extension pages', () => {
  test('settings page lists every toggle with a tooltip', async ({ context, extId }) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`chrome-extension://${extId}/options.html`);
    await expect(page.locator('#toggles .setting')).toHaveCount(10);
    await expect(page.locator('#toggles .tip')).toHaveCount(11);
    await expect(page.locator('#language option')).toHaveCount(33);
    for (const tip of await page.locator('#toggles .tip').all()) expect((await tip.getAttribute('data-tip'))!.length).toBeGreaterThan(10);
    await expect(page.locator('#dbStatus')).toContainText('4 reports');
    expect(errors).toEqual([]);
  });

  test('adding a trusted site asks for confirmation first', async ({ context, sw, extId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.fill('#siteInput', 'intranet.example.com');
    await page.click('#addSite');
    await page.click('.g-card .g-btn.primary');
    await expect(page.locator('#sites')).not.toContainText('intranet.example.com');
    await page.click('#addSite');
    // On a normal window the risk sentence fits on one line.
    const lineHeight = await page.locator('.g-card .g-check span').evaluate((e) => e.getBoundingClientRect().height);
    expect(lineHeight).toBeLessThan(30);
    await page.locator('.g-card .g-check input').check();
    await page.click('.g-card .g-btn.danger');
    await expect(page.locator('#sites')).toContainText('intranet.example.com');
    const stored = await sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings as { trustedSites: string[] }).trustedSites);
    expect(stored).toContain('intranet.example.com');
  });

  test('the language picker switches the interface and English stays the default', async ({ context, extId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
    await expect(page.locator('nav .item.active')).toHaveText('Protection');
    await page.selectOption('#language', 'de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('nav .item.active')).not.toHaveText('Protection');
    const lure = await context.newPage();
    await lure.goto(BASE + '/lures/turnstile-writetext.html');
    await lure.click('#cb');
    await expect.poll(() => overlayShown(lure)).toBe(true);
    await page.bringToFront();
    await page.selectOption('#language', '');
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
  });

  test('clearing the log asks in a styled dialog, Cancel keeps it and the red button clears it', async ({ context, sw, extId }) => {
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ log: [{ id: '1', time: new Date().toISOString(), kind: 'clipboard', action: 'blocked', url: 'https://a.test/', host: 'a.test', reasons: [], what: 'a test entry' }] });
    });
    const page = await context.newPage();
    page.on('dialog', () => {
      throw new Error('the browser confirm box must not appear');
    });
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.click('#clearLog');
    await expect(page.locator('.g-card')).toContainText('This cannot be undone.');
    await page.click('.g-card .g-btn.primary');
    await expect(page.locator('.g-card')).toHaveCount(0);
    expect(await detectionCount(sw)).toBe(1);
    await page.click('#clearLog');
    await page.click('.g-card .g-btn.danger');
    await expect.poll(() => detectionCount(sw)).toBe(0);
  });

  test('a picked language copied by an older version is renewed after an update', async ({ context, sw, extId }) => {
    // The copy an older version left behind, with a sentence that no longer matches the code.
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ i18nOverride: { lang: 'en', messages: { popupUpdated: 'Updated $1, rules version $2', navProtection: 'Old text' }, version: '0.0.9' } });
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await expect(popup.locator('#stats')).toContainText('Updated');
    await expect(popup.locator('#stats')).not.toContainText('$2');
    await expect(popup.locator('#stats')).not.toContainText('rules version');
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('i18nOverride')).i18nOverride as { version: string; messages: Record<string, string> });
    expect(stored.version).toBe(await sw.evaluate(() => (chrome as unknown as { runtime: { getManifest(): { version: string } } }).runtime.getManifest().version));
    expect(stored.messages.navProtection).toBe('Protection');
  });

  test('popup renders', async ({ context, extId }) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`chrome-extension://${extId}/popup.html`);
    await expect(page.locator('#stats')).toContainText('4');
    expect(errors).toEqual([]);
  });
});
