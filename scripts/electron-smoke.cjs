// Real Electron regression checks; all documents, settings and exports are disposable.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
// Match openHtmlFile's realpath normalization before deriving fixture paths/URLs.
// Windows CI may expose TEMP through an 8.3 alias (RUNNER~1); macOS may use a symlink.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-qa-')));
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const fixture = '# Classroom QA\n\nalpha beta gamma\n\n<!-- note: PRIVATE_TEACHER_NOTE -->\n\n## Topic\n\nSecond paragraph.\n';
const lesson = path.join(scratch, 'lesson.md');
const other = path.join(scratch, 'other.md');
fs.writeFileSync(lesson, fixture);
fs.writeFileSync(other, '# Other lesson\n\nAnother document.\n');
const htmlDir = path.join(scratch, 'HTML only');
fs.mkdirSync(htmlDir);
const htmlFile = path.join(htmlDir, '课堂 #1.HTML');
const htmlUrl = pathToFileURL(htmlFile).toString();
const linkedHtml = path.join(htmlDir, 'next.htm');
fs.writeFileSync(htmlFile, '<!doctype html><html><head><title>Local HTML lesson</title><link rel="stylesheet" href="style.css"></head><body><h1>HTML classroom</h1><img src="diagram.svg"><button id="increment">Clicks: 0</button><a href="next.htm">Next page</a><script src="lesson.js"></script></body></html>');
fs.writeFileSync(linkedHtml, '<!doctype html><title>Next HTML lesson</title><h1>Next page</h1>');
fs.writeFileSync(path.join(htmlDir, 'style.css'), 'h1 { color: rgb(12, 34, 56); }');
fs.writeFileSync(path.join(htmlDir, 'lesson.js'), 'let clicks = 0; document.querySelector("#increment").onclick = event => event.target.textContent = `Clicks: ${++clicks}`;');
fs.writeFileSync(path.join(htmlDir, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>');
for (const color of ['red', 'blue']) {
  const dir = path.join(scratch, color);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'lesson.md'), `# ${color}\n\n![diagram](diagram.svg)\n`);
  fs.writeFileSync(path.join(dir, 'diagram.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="${color}"/></svg>`);
}
const bootstrap = path.join(scratch, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(scratch, 'profile'))});require(${JSON.stringify(path.join(root, 'dist/main/main.js'))});`);
const executablePath = process.env.MARKFLOW_ELECTRON_PATH || require('electron');
const results = [];
let app, page;
const errors = [];
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<html><title>MarkFlow QA Web</title><body><h1>Web classroom</h1><input aria-label="Web editor" /></body></html>');
});
const readDoc = () => page.locator('.cm-content').evaluate(el => el.cmTile.view.state.doc.toString());
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const press = async key => { await page.keyboard.press(key); await settle(); };
// CDP keyboard events bypass Electron's before-input-event. Exercise native web shortcuts
// through WebContents.sendInputEvent so this checks the actual main-process routing.
const webKey = async (url, keyCode, modifiers = ['control']) => {
  await app.evaluate(({ webContents }, input) => {
    const contents = webContents.getAllWebContents().find(w => w.getURL().startsWith(input.url));
    if (!contents) throw new Error('Test web content not found');
    contents.sendInputEvent({ type: 'keyDown', keyCode: input.keyCode, modifiers: input.modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: input.keyCode, modifiers: input.modifiers });
  }, { url, keyCode, modifiers });
  await settle();
};
async function test(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    console.log(`FAIL ${name}: ${error.stack}`);
    await page?.screenshot({ path: path.join(output, `failure-${results.length}.png`) }).catch(() => {});
  }
}
async function launch(args = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  app = await electron.launch({ executablePath, args: [bootstrap, ...args], cwd: scratch, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.cm-content', { state: 'attached' });
  await app.evaluate(({ clipboard }) => {
    globalThis.qaClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
  });
}
async function restoreClipboard() {
  await app?.evaluate(({ clipboard }) => { if (globalThis.qaClipboard) clipboard.write(globalThis.qaClipboard); }).catch(() => {});
}
async function closePolicy(response, savePath, cancelSave = false) {
  await app.evaluate(({ dialog }, config) => {
    globalThis.qaCloseDialogs = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.qaCloseDialogs.push(options);
      return { response: config.response, checkboxChecked: false };
    };
    dialog.showSaveDialog = async () => ({ canceled: config.cancelSave, filePath: config.savePath });
  }, { response, savePath, cancelSave });
}
async function requestWindowClose(expectClosed) {
  if (expectClosed) await restoreClipboard();
  const closed = expectClosed ? page.waitForEvent('close', { timeout: 6000 }) : null;
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=edit')).close();
  });
  if (closed) { await closed; await app.close().catch(() => {}); }
  else {
    // Wait for the asynchronous native dialog / response, then allow the close continuation to run.
    for (let i = 0; i < 60; i++) {
      if (await app.evaluate(() => globalThis.qaCloseDialogs.length > 0)) break;
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(100);
    assert.equal(page.isClosed(), false);
  }
}
async function open(file = lesson) {
  const closeSearch = page.getByRole('button', { name: 'close', exact: true });
  if (await closeSearch.count()) await closeSearch.click();
  if ((await page.locator('.workspaceSplit').getAttribute('class')).includes('webActive')) {
    await page.locator('.tabButton').first().click();
  }
  if ((await page.getByRole('button', { name: 'Present', exact: true }).getAttribute('class')).includes('active')) {
    await page.getByRole('button', { name: 'Present', exact: true }).click();
  }
  await page.evaluate(filePath => window.markflow.docOpenPath({ filePath }), file);
  await page.waitForFunction(text => document.querySelector('.cm-content').cmTile.view.state.doc.toString() === text, fs.readFileSync(file, 'utf8'));
  await page.locator('.cm-content').evaluate(el => {
    const view = el.cmTile.view;
    view.focus();
    view.dispatch({ selection: { anchor: 0 } });
  });
  await settle();
}
async function present() {
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.view.state.readOnly);
}
async function selectAlpha() {
  await page.locator('.cm-content').evaluate(el => {
    const view = el.cmTile.view;
    const from = view.state.doc.toString().indexOf('alpha');
    view.dispatch({ selection: { anchor: from, head: from + 5 } });
    view.focus();
  });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await launch([lesson]);
    await test('File-argument startup registers IPC and loads document', async () => {
      assert.equal((await page.evaluate(() => window.markflow.webTabList())).success, true);
      await page.waitForFunction(text => document.querySelector('.cm-content').cmTile.view.state.doc.toString() === text, fixture);
    });
    await test('HTML-only folders appear in the sidebar alongside Markdown', async () => {
      const { entries } = await page.evaluate(dirPath => window.markflow.folderList({ dirPath }), scratch);
      assert.ok(entries.some(entry => entry.path === htmlDir && entry.kind === 'directory'));
      assert.ok(entries.some(entry => entry.path === htmlFile && entry.isHtml && !entry.isMarkdown));
      assert.ok(entries.some(entry => entry.path === linkedHtml && entry.isHtml));
      assert.ok(entries.some(entry => entry.path === lesson && entry.isMarkdown && !entry.isHtml));
      assert.ok(!entries.some(entry => entry.name === 'style.css'));
      await app.evaluate(({ dialog }, dirPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dirPath] }); }, htmlDir);
      await page.getByRole('button', { name: '☰ Function', exact: true }).click();
      await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
      await page.locator('.workspaceItem').filter({ hasText: path.basename(htmlFile) }).waitFor();
      assert.ok((await page.locator('.workspaceSummary').innerText()).includes('2 HTML'));
    });
    await test('Switching unsaved Markdown to HTML can be canceled', async () => {
      await open();
      await page.keyboard.insertText('Unsaved HTML test ');
      const before = await readDoc();
      const prompts = [];
      const cancel = async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); };
      page.on('dialog', cancel);
      try {
        await page.locator('.workspaceItem').filter({ hasText: path.basename(htmlFile) }).click();
        await settle();
        assert.equal(prompts.length, 2);
        assert.equal(await readDoc(), before);
        assert.equal(await page.getByLabel('HTML document content').count(), 0);
        assert.equal(await page.locator('.tabButton').count(), 1);
        assert.equal(fs.readFileSync(lesson, 'utf8'), fixture);
      } finally {
        page.off('dialog', cancel);
      }
    });
    await test('HTML replaces the document area after saving, without a new top tab', async () => {
      const before = await readDoc();
      page.once('dialog', dialog => dialog.accept());
      const htmlWindow = app.waitForEvent('window');
      await page.locator('.workspaceItem').filter({ hasText: path.basename(htmlFile) }).click();
      const web = await htmlWindow;
      await web.waitForURL(htmlUrl);
      await page.getByLabel('HTML document content').waitFor();
      await page.waitForFunction(() => document.querySelector('[aria-label="HTML document content"]').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.workspaceSidebar').isVisible(), true);
      assert.equal(await page.locator('.tabButton').count(), 1);
      assert.ok((await page.locator('.tabButton').first().innerText()).includes(path.basename(htmlFile)));
      assert.equal((await page.evaluate(() => window.markflow.webTabList())).tabs.length, 0);
      assert.ok(!(await page.locator('.workspaceSplit').getAttribute('class')).includes('webActive'));
      assert.ok((await page.locator('.workspaceItem.active').innerText()).includes(path.basename(htmlFile)));
      const bounds = await app.evaluate(({ BrowserWindow }, url) => {
        const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=edit'));
        return window.contentView.children.find(view => view.webContents.getURL() === url).getBounds();
      }, htmlUrl);
      const sidebar = await page.locator('.workspaceSidebar').boundingBox();
      assert.ok(bounds.x >= sidebar.x + sidebar.width);
      assert.equal(await web.locator('h1').innerText(), 'HTML classroom');
      assert.equal(await web.locator('h1').evaluate(el => getComputedStyle(el).color), 'rgb(12, 34, 56)');
      assert.equal(await web.locator('img').evaluate(el => el.complete && el.naturalWidth > 0), true);
      await web.locator('#increment').click();
      assert.equal(await web.locator('#increment').innerText(), 'Clicks: 1');
      assert.deepEqual(await web.evaluate(() => [typeof require, typeof process, typeof window.markflow]), ['undefined', 'undefined', 'undefined']);
      const prefs = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(w => w.getURL() === url).getLastWebPreferences(), htmlUrl);
      assert.equal(prefs.sandbox, true);
      assert.equal(prefs.webSecurity, true);
      await webKey(htmlUrl, '=');
      await page.waitForFunction(() => [...document.querySelectorAll('.bottomBar .pill')].some(el => el.textContent.includes('Zoom 110%')));
      await page.screenshot({ path: path.join(output, 'html-preview.png') });
      assert.equal(await page.locator('.dirtyMark').count(), 0);
      assert.equal(fs.readFileSync(lesson, 'utf8'), before);
      fs.writeFileSync(lesson, fixture);
    });
    await test('Open File reuses the HTML document view and handles cancellation', async () => {
      await app.evaluate(({ dialog }, filePath) => {
        globalThis.qaFilePickCount = 0;
        dialog.showOpenDialog = async (_window, options) => {
          globalThis.qaFilePickCount++;
          globalThis.qaFileFilters = options.filters;
          return { canceled: false, filePaths: [filePath] };
        };
      }, htmlFile);
      const id = await page.getByLabel('HTML document content').getAttribute('data-content-id');
      await press('Control+o');
      assert.equal(await app.evaluate(() => globalThis.qaFilePickCount), 1);
      await settle();
      assert.equal(await page.locator('.tabButton').count(), 1);
      assert.equal(await page.getByLabel('HTML document content').getAttribute('data-content-id'), id);
      const filters = await app.evaluate(() => globalThis.qaFileFilters);
      assert.ok(filters.some(filter => filter.extensions.includes('html') && filter.extensions.includes('htm')));
      await webKey(htmlUrl, 'o');
      await settle();
      assert.equal(await app.evaluate(() => globalThis.qaFilePickCount), 2);
      assert.equal(await page.locator('.tabButton').count(), 1);
      assert.equal(await app.context().pages().find(p => p.url() === htmlUrl).locator('#increment').innerText(), 'Clicks: 1');
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      assert.equal(await page.evaluate(() => window.markflow.docOpen()), null);
      const result = await page.evaluate(filePath => window.markflow.docOpenPath({ filePath }), htmlFile);
      assert.equal(result.docPath, htmlFile);
      assert.equal(result.html.id, id);
      assert.equal((await page.evaluate(() => window.markflow.webTabList())).tabs.length, 0);
      await assert.rejects(page.evaluate(filePath => window.markflow.docOpenPath({ filePath }), path.join(htmlDir, 'missing.html')));
      await assert.rejects(page.evaluate(filePath => window.markflow.docOpenPath({ filePath }), path.join(htmlDir, 'style.css')));
    });
    await test('Local HTML navigation stays scoped and remote links use separate tabs', async () => {
      const web = app.context().pages().find(p => p.url() === htmlUrl);
      assert.ok(web);
      await web.getByRole('link', { name: 'Next page', exact: true }).click();
      await web.waitForURL(pathToFileURL(linkedHtml).toString());
      await page.waitForFunction(name => document.querySelector('.tabButton').textContent.includes(name), path.basename(linkedHtml));
      assert.equal(await page.locator('.tabButton').count(), 1);
      assert.ok((await page.locator('.workspaceItem.active').innerText()).includes(path.basename(linkedHtml)));
      const id = await page.getByLabel('HTML document content').getAttribute('data-content-id');
      assert.equal((await page.evaluate(args => window.markflow.webTabNavigate(args), { id, url: htmlUrl })).success, true);
      await web.waitForURL(htmlUrl);
      await web.evaluate(url => { location.href = url; }, pathToFileURL(lesson).toString());
      await settle();
      assert.equal(web.url(), htmlUrl);
      const loaded = await web.evaluate(url => new Promise(resolve => {
        const img = new Image(); img.onload = () => resolve(true); img.onerror = () => resolve(false); img.src = url;
      }), pathToFileURL(path.join(scratch, 'red', 'diagram.svg')).toString());
      assert.equal(loaded, false);
      if (process.platform !== 'win32') {
        const escaped = path.join(htmlDir, 'escaped.svg');
        fs.symlinkSync(path.join(scratch, 'red', 'diagram.svg'), escaped);
        assert.equal(await web.evaluate(url => new Promise(resolve => {
          const img = new Image(); img.onload = () => resolve(true); img.onerror = () => resolve(false); img.src = url;
        }), pathToFileURL(escaped).toString()), false);
      }
      await web.evaluate(url => { location.href = url; }, url);
      await page.waitForFunction(async url => (await window.markflow.webTabList()).tabs.some(tab => tab.url === url && !tab.loading), url);
      assert.equal(web.url(), htmlUrl);
      const tabs = (await page.evaluate(() => window.markflow.webTabList())).tabs;
      const remote = tabs.find(tab => tab.url === url);
      assert.equal((await page.evaluate(args => window.markflow.webTabNavigate(args), { id: remote.id, url: htmlUrl })).success, false);
      assert.equal(await page.locator('.tabButton').count(), 2);
      await page.locator('.tabButton').first().click();
      await page.getByLabel('HTML document content').waitFor();
      assert.equal(await page.locator('.workspaceSidebar').isVisible(), true);
      assert.equal(await web.locator('h1').innerText(), 'HTML classroom');
      for (const tab of tabs) await page.evaluate(id => window.markflow.webTabClose({ id }), tab.id);
      await page.waitForFunction(() => !document.querySelector('.workspaceSplit').classList.contains('webActive'));
      await open();
    });
    await test('Switching HTML and HTM keeps one document slot and cannot overwrite HTML', async () => {
      const htmlWindow = app.waitForEvent('window');
      await page.evaluate(filePath => window.markflow.docOpenPath({ filePath }), htmlFile);
      const previous = await htmlWindow;
      await previous.waitForURL(htmlUrl);
      const htmWindow = app.waitForEvent('window');
      await page.locator('.workspaceItem').filter({ hasText: path.basename(linkedHtml) }).click();
      const htm = await htmWindow;
      await htm.waitForURL(pathToFileURL(linkedHtml).toString());
      await page.waitForFunction(name => document.querySelector('.tabButton').textContent.includes(name), path.basename(linkedHtml));
      assert.equal(previous.isClosed(), true);
      assert.equal(await page.locator('.tabButton').count(), 1);
      assert.equal(await page.locator('.workspaceSidebar').isVisible(), true);
      assert.equal(await htm.locator('h1').innerText(), 'Next page');
      const original = fs.readFileSync(linkedHtml, 'utf8');
      await webKey(pathToFileURL(linkedHtml).toString(), 's');
      assert.equal(await page.evaluate(filePath => window.markflow.docSave({ docPath: filePath, markdown: 'must not overwrite' }), linkedHtml), null);
      assert.equal(fs.readFileSync(linkedHtml, 'utf8'), original);
      await page.getByRole('button', { name: '✎ Edit', exact: true }).click();
      assert.ok(await page.locator('.menuDropdown .menuItem').evaluateAll(items => items.every(item => item.disabled)));
      await page.getByRole('button', { name: '✎ Edit', exact: true }).click();
      await open();
      assert.equal(htm.isClosed(), true);
      assert.equal(await page.getByLabel('HTML document content').count(), 0);
      assert.equal(await page.locator('.tabButton').count(), 1);
      assert.equal(await readDoc(), fixture);
    });
    await test('Open File canceled Save As preserves unsaved Markdown; discard switches to HTML', async () => {
      await restoreClipboard();
      await app.close();
      fs.writeFileSync(path.join(scratch, 'profile', 'state.json'), JSON.stringify({ lastDocPath: null, lastWorkspaceDirPath: htmlDir }));
      await launch();
      await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.view.state.doc.length === 0);
      await page.locator('.cm-content').click();
      await page.keyboard.insertText('Untitled HTML switch');
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
        dialog.showSaveDialog = async () => ({ canceled: true });
      }, htmlFile);
      page.once('dialog', dialog => dialog.accept());
      await press('Control+o');
      assert.equal(await readDoc(), 'Untitled HTML switch');
      assert.equal(await page.getByLabel('HTML document content').count(), 0);
      let prompts = 0;
      const discard = async dialog => { if (prompts++ === 0) await dialog.dismiss(); else await dialog.accept(); };
      page.on('dialog', discard);
      const htmlWindow = app.waitForEvent('window');
      try {
        await page.locator('.workspaceItem').filter({ hasText: path.basename(htmlFile) }).click();
        const html = await htmlWindow;
        await html.waitForURL(htmlUrl);
        await page.getByLabel('HTML document content').waitFor();
        assert.equal(prompts, 2);
        assert.equal(await page.locator('.tabButton').count(), 1);
        assert.equal(await page.locator('.workspaceSidebar').isVisible(), true);
      } finally {
        page.off('dialog', discard);
      }
      await open();
    });
    await test('HTML startup argument renders in the shared document area', async () => {
      await restoreClipboard();
      await app.close();
      await launch([htmlFile]);
      await page.getByLabel('HTML document content').waitFor();
      await page.waitForFunction(() => document.querySelector('[aria-label="HTML document content"]').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('.tabButton').count(), 1);
      assert.equal(await page.locator('.workspaceSidebar').isVisible(), true);
      assert.equal((await page.evaluate(() => window.markflow.webTabList())).tabs.length, 0);
      const web = app.context().pages().find(p => p.url() === htmlUrl);
      assert.equal(await web.title(), 'Local HTML lesson');
      for (const tab of (await page.evaluate(() => window.markflow.webTabList())).tabs) await page.evaluate(id => window.markflow.webTabClose({ id }), tab.id);
      await open();
    });
    for (const key of ['Control+b', 'Control+i', 'Control+e', 'Control+k', 'Control+Shift+x', 'Control+Shift+c', 'Control+Shift+t', 'Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3', 'Control+Shift+7', 'Control+Shift+8']) {
      await test(`Present blocks ${key}`, async () => {
        await open();
        await present();
        await press(key);
        assert.equal(await readDoc(), fixture);
      });
    }
    await test('Present blocks typing, deletion, paste, undo and redo', async () => {
      await open();
      await press('Control+End');
      await page.keyboard.insertText('Changed');
      const before = await readDoc();
      await present();
      await page.locator('.cm-content').evaluate(el => el.cmTile.view.focus());
      await page.keyboard.insertText('Accidental typing');
      await app.evaluate(({ clipboard }) => clipboard.writeText('Accidental paste'));
      for (const key of ['Backspace', 'Delete', 'Control+v', 'Control+z', 'Control+Shift+z']) await press(key);
      assert.equal(await readDoc(), before);
      await page.getByRole('button', { name: 'Present', exact: true }).click();
      await press('Control+End');
      await page.keyboard.insertText('After');
      assert.equal(await readDoc(), `${before}After`);
    });
    await test('Present disables all edit menu commands', async () => {
      await open(); await present();
      await page.getByRole('button', { name: '✎ Edit', exact: true }).click();
      const states = await page.locator('.menuDropdown .menuItem').evaluateAll(items => items.map(item => item.disabled));
      assert.ok(states.length >= 14 && states.every(Boolean));
      await page.getByRole('button', { name: '✎ Edit', exact: true }).click();
    });
    await test('Find and copy work in Present; replace is blocked', async () => {
      await open(); await selectAlpha(); await present();
      await page.locator('.cm-content').evaluate(el => el.cmTile.view.focus());
      await press('Control+c');
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'alpha');
      await press('Control+f');
      await page.getByRole('textbox', { name: 'Find', exact: true }).fill('alpha');
      await page.getByRole('button', { name: 'next', exact: true }).click();
      await page.getByTitle('Show replace', { exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Replace', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'replace all', exact: true }).isDisabled(), true);
      assert.equal(await readDoc(), fixture);
      await press('Escape');
    });
    for (const [key, expected] of [['Control+Alt+1', 'Classroom QA'], ['Control+Alt+2', '## Classroom QA'], ['Control+Alt+3', '### Classroom QA'], ['Control+Shift+7', '- # Classroom QA'], ['Control+Shift+8', '1. # Classroom QA']]) {
      await test(`Edit shortcut ${key}`, async () => {
        await open(); await press(key);
        assert.equal((await readDoc()).split('\n')[0], expected);
      });
    }
    for (const [key, marker] of [['Control+b', '**'], ['Control+i', '*'], ['Control+e', '`']]) {
      await test(`Format toggle ${key}`, async () => {
        await open(); await selectAlpha(); await press(key);
        assert.ok((await readDoc()).includes(`${marker}alpha${marker}`));
        await press(key);
        assert.equal(await readDoc(), fixture);
      });
    }
    await test('Find-field formatting shortcut does not edit document', async () => {
      await open(); await press('Control+f');
      await page.getByRole('textbox', { name: 'Find', exact: true }).fill('alpha');
      await press('Control+b');
      assert.equal(await readDoc(), fixture);
      await press('Escape');
    });
    await test('Replace all in edit mode and save round-trip', async () => {
      await open(); await press('Control+f');
      await page.getByRole('textbox', { name: 'Find', exact: true }).fill('alpha');
      await page.getByTitle('Show replace', { exact: true }).click();
      await page.getByRole('textbox', { name: 'Replace', exact: true }).fill('updated');
      await page.getByRole('button', { name: 'replace all', exact: true }).click();
      assert.equal(await readDoc(), fixture.replace('alpha', 'updated'));
      await press('Escape'); await press('Control+s');
      await page.waitForFunction(() => !document.querySelector('.dirtyMark'));
      assert.equal(fs.readFileSync(lesson, 'utf8'), fixture.replace('alpha', 'updated'));
      fs.writeFileSync(lesson, fixture);
    });
    await test('Switching directories resolves each document image', async () => {
      let previous;
      for (const color of ['red', 'blue']) {
        await open(path.join(scratch, color, 'lesson.md'));
        await page.waitForFunction(() => {
          const img = document.querySelector('.mf-image-preview img');
          return img?.complete && img.naturalWidth > 0;
        });
        const src = await page.locator('.mf-image-preview img').getAttribute('src');
        assert.ok(decodeURIComponent(src).includes(color));
        assert.notEqual(src, previous); previous = src;
      }
    });
    await test('Opening a document starts independent undo history', async () => {
      await open();
      await press('Control+End');
      await page.keyboard.insertText('First document edit');
      await open(other);
      const before = await readDoc();
      await press('Control+z');
      assert.equal(await readDoc(), before);
      await page.keyboard.insertText('New edit');
      await press('Control+z');
      assert.equal(await readDoc(), before);
    });
    await test('Ctrl+H expands replace; Escape closes the search panel', async () => {
      await open(); await press('Control+h');
      await page.getByRole('textbox', { name: 'Replace', exact: true }).waitFor();
      await press('Escape');
      assert.equal(await page.locator('.mf-search-panel').count(), 0);
    });
    await test('Notes open, show private text, synchronize scroll and close', async () => {
      const notesLesson = path.join(scratch, 'notes.md');
      fs.writeFileSync(notesLesson, fixture + Array.from({ length: 60 }, (_, i) => `\nParagraph ${i}.\n`).join(''));
      await open(notesLesson);
      const pendingNotes = app.waitForEvent('window');
      await press('F5');
      const notesPage = await pendingNotes;
      assert.ok(notesPage);
      await notesPage.getByText('PRIVATE_TEACHER_NOTE', { exact: true }).waitFor();
      assert.equal(await page.locator('.mf-note-source-line').evaluate(el => getComputedStyle(el).opacity), '0');
      await page.locator('.cm-scroller').evaluate(el => { el.scrollTop = 300; });
      await notesPage.waitForFunction(() => document.querySelector('.notesWindowScroller').scrollTop >= 250);
      // Let the incoming scroll update clear its one-frame feedback-loop guard
      // before simulating a new scroll originating in the notes window.
      await notesPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await notesPage.locator('.notesWindowScroller').evaluate(el => { el.scrollTop = 700; });
      await page.waitForFunction(() => document.querySelector('.cm-scroller').scrollTop >= 600);
      const closed = notesPage.waitForEvent('close');
      await notesPage.keyboard.press('Escape').catch(error => { if (!notesPage.isClosed()) throw error; });
      await closed;
      await page.waitForFunction(() => !!document.querySelector('.cm-content'));
    });
    await test('Present toggle preserves scroll position', async () => {
      const long = path.join(scratch, 'long.md');
      fs.writeFileSync(long, Array.from({ length: 150 }, (_, i) => `## Section ${i}\n\nParagraph ${i}.\n`).join('\n'));
      await open(long);
      await page.locator('.cm-scroller').evaluate(el => { el.scrollTop = 2000; });
      await settle();
      const top = await page.locator('.cm-scroller').evaluate(el => el.scrollTop);
      await present();
      await page.getByRole('button', { name: 'Present', exact: true }).click();
      assert.ok(Math.abs(await page.locator('.cm-scroller').evaluate(el => el.scrollTop) - top) < 50);
    });
    await test('Web tabs isolate Node, zoom independently, and route app shortcuts', async () => {
      await open();
      assert.equal((await page.evaluate(url => window.markflow.webTabCreate({ url }), 'file:///C:/Windows/win.ini')).success, false);
      const created = await page.evaluate(url => window.markflow.webTabCreate({ url }), url);
      assert.equal(created.success, true);
      await page.locator('.tabButton').filter({ hasText: 'MarkFlow QA Web' }).click();
      const web = app.context().pages().find(p => p.url().startsWith(url));
      assert.ok(web);
      assert.deepEqual(await web.evaluate(() => [typeof require, typeof process, typeof window.markflow]), ['undefined', 'undefined', 'undefined']);
      await web.getByRole('textbox', { name: 'Web editor' }).click();
      await webKey(url, '=');
      await page.waitForFunction(async id => (await window.markflow.webTabList()).tabs.find(t => t.id === id).zoomFactor > 1, created.tab.id);
      await webKey(url, '1');
      await page.waitForFunction(() => !document.querySelector('.workspaceSplit').classList.contains('webActive'));
      assert.ok((await page.locator('.subbar').last().innerText()).includes('100%'));
      await press('Control+2');
      await web.getByRole('textbox', { name: 'Web editor' }).click();
      await webKey(url, 'l');
      await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
      await web.getByRole('textbox', { name: 'Web editor' }).click();
      await webKey(url, 'w');
      await page.waitForFunction(async () => (await window.markflow.webTabList()).tabs.length === 0);
    });
    await test('Remix settings validate, reset, persist and drive the shortcut without navigating existing tabs', async () => {
      await open();
      assert.equal((await page.evaluate(() => window.markflow.quickOpenGet())).url, 'https://app.remix.live/');
      const showSettings = async () => {
        await page.getByRole('button', { name: '☰ Function', exact: true }).click();
        await page.getByRole('button', { name: '默认url设置', exact: true }).click();
      };
      await showSettings();
      await page.getByLabel('默认 URL').fill('javascript:alert(1)');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('alert').waitFor();
      assert.equal((await page.evaluate(() => window.markflow.quickOpenGet())).url, 'https://app.remix.live/');
      await page.getByRole('button', { name: '恢复默认', exact: true }).click();
      assert.equal(await page.getByLabel('默认 URL').inputValue(), 'https://app.remix.live/');
      await page.getByLabel('默认 URL').fill(url + 'custom');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await press('Control+Shift+r');
      await page.waitForFunction(async expected => (await window.markflow.webTabList()).tabs.some(t => t.url === expected), url + 'custom');
      await showSettings();
      await page.screenshot({ path: path.join(output, 'remix-settings.png') });
      await page.getByRole('button', { name: '恢复默认', exact: true }).click();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal((await page.evaluate(() => window.markflow.webTabList())).tabs[0].url, url + 'custom');
      await showSettings();
      await page.getByLabel('默认 URL').fill(url + 'persisted');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      for (const tab of (await page.evaluate(() => window.markflow.webTabList())).tabs) {
        await page.evaluate(id => window.markflow.webTabClose({ id }), tab.id);
      }
      await open();
      await page.getByRole('textbox', { name: 'Quick-open URL', exact: true }).fill(url + 'typed');
      await press('Enter');
      await page.waitForFunction(async expected => (await window.markflow.webTabList()).tabs.some(t => t.url === expected), url + 'typed');
      assert.equal((await page.evaluate(() => window.markflow.quickOpenGet())).url, url + 'persisted');
    });
    await test('PDF export includes local images and excludes teacher notes', async () => {
      await open();
      const pdf = path.join(scratch, 'lesson.pdf');
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
      const markdown = fixture + '\n![diagram](red/diagram.svg)\n\n$x^2$\n';
      await app.evaluate(({ app }) => {
        app.once('browser-window-created', (_, win) => {
          const print = win.webContents.printToPDF.bind(win.webContents);
          win.webContents.printToPDF = async options => {
            globalThis.qaPrintedContent = await win.webContents.executeJavaScript(`({text: document.querySelector('.printContent').innerText, images: [...document.images].map(img => img.complete && img.naturalWidth > 0)})`);
            return print(options);
          };
        });
      });
      const exported = await page.evaluate(payload => window.markflow.exportPdf(payload), { markdown, docPath: lesson });
      assert.equal(exported.success, true, exported.message);
      const printed = await app.evaluate(() => globalThis.qaPrintedContent);
      assert.ok(printed.text.includes('Classroom QA') && !printed.text.includes('PRIVATE_TEACHER_NOTE'));
      assert.deepEqual(printed.images, [true]);
      assert.ok(fs.statSync(pdf).size > 1000);
      assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
    });
    await test('Restore last document and workspace after restart', async () => {
      await open(other);
      await page.evaluate(dirPath => window.markflow.workspaceStateSet({ dirPath }), scratch);
      await restoreClipboard();
      await app.close(); await launch();
      await page.waitForFunction(text => document.querySelector('.cm-content').cmTile.view.state.doc.toString() === text, fs.readFileSync(other, 'utf8'));
      assert.equal((await page.evaluate(() => window.markflow.workspaceStateGet())).dirPath, scratch);
      assert.equal((await page.evaluate(() => window.markflow.quickOpenGet())).url, url + 'persisted');
    });
    await test('No renderer exceptions', async () => assert.deepEqual(errors, []));
    await page.screenshot({ path: path.join(output, 'smoke-final.png') });
    await test('Cancel closing retains unsaved content', async () => {
      await open(); await page.keyboard.insertText('Unsaved cancel ');
      const expected = await readDoc();
      await closePolicy(2);
      await requestWindowClose(false);
      assert.equal(await readDoc(), expected);
      assert.equal(fs.readFileSync(lesson, 'utf8'), fixture);
      const options = await app.evaluate(() => globalThis.qaCloseDialogs[0]);
      assert.deepEqual(options.buttons, ['保存', '放弃修改', '取消']);
      assert.equal(options.cancelId, 2);
    });
    await test('Cancel application quit keeps document open', async () => {
      await closePolicy(2);
      await app.evaluate(({ app }) => app.quit());
      await page.waitForTimeout(200);
      assert.equal(page.isClosed(), false);
      assert.equal((await app.evaluate(() => globalThis.qaCloseDialogs)).length, 1);
    });
    await test('Cancel installing an update preserves unsaved work', async () => {
      await closePolicy(2);
      assert.equal(await page.evaluate(() => window.markflow.updateInstall()), false);
      assert.equal(page.isClosed(), false);
      assert.equal((await app.evaluate(() => globalThis.qaCloseDialogs)).length, 1);
    });
    await test('Save on close writes the latest keystrokes before exit', async () => {
      await open(); await closePolicy(0);
      await page.keyboard.insertText('Latest edit ');
      await requestWindowClose(true);
      assert.equal(fs.readFileSync(lesson, 'utf8'), 'Latest edit ' + fixture);
      fs.writeFileSync(lesson, fixture);
      await launch();
    });
    await test('Discard closes without writing changes', async () => {
      await open(); await page.keyboard.insertText('Discard this ');
      await closePolicy(1); await requestWindowClose(true);
      assert.equal(fs.readFileSync(lesson, 'utf8'), fixture);
      await launch();
    });
    await test('Clean document closes without confirmation', async () => {
      await open();
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => { throw new Error('Clean document must not prompt'); }; });
      await requestWindowClose(true); await launch();
    });
    await test('Cancel Save As keeps an untitled document open', async () => {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=edit')).webContents.send('doc:update', { docPath: null, markdown: '' });
      });
      await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.view.state.doc.length === 0);
      await page.locator('.cm-content').evaluate(el => el.cmTile.view.focus());
      await page.keyboard.insertText('Untitled work');
      await closePolicy(0, undefined, true); await requestWindowClose(false);
      assert.equal(await readDoc(), 'Untitled work');
    });
    await test('Save failure retains the document and reports the error', async () => {
      await closePolicy(0, path.join(scratch, 'missing-directory', 'failed.md'));
      await requestWindowClose(false);
      assert.equal(await readDoc(), 'Untitled work');
      const dialogs = await app.evaluate(() => globalThis.qaCloseDialogs);
      assert.equal(dialogs.length, 2);
      assert.equal(dialogs[1].type, 'error');
    });
    await test('Save As on close creates the untitled document', async () => {
      const untitledPath = path.join(scratch, 'saved-untitled.md');
      await closePolicy(0, untitledPath); await requestWindowClose(true);
      assert.equal(fs.readFileSync(untitledPath, 'utf8'), 'Untitled work');
      await launch();
    });
  } finally {
    await restoreClipboard();
    await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {});
    await app?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'smoke-results.json'), JSON.stringify({ scratch, results }, null, 2));
    console.log(`${results.filter(r => r.passed).length}/${results.length} passed. Evidence: ${output}`);
    if (results.some(r => !r.passed)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
