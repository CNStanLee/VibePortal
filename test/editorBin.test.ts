import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorExtensionBin, parseRegPath } from '../src/core/actions';

test('a PATH changed after start is read back from the registry, variables expanded', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Ngrok.Ngrok_x;%Missing%\\bin;\r\n\r\n';
  assert.deepEqual(parseRegPath(out, { USERPROFILE: 'C:\\Users\\me' }), [
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Ngrok.Ngrok_x',
    '%Missing%\\bin',
  ]);
  assert.deepEqual(parseRegPath('ERROR: The system was unable to find the specified registry key or value.', {}), []);
});

const touch = (f: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
};

test('the CLI bundled with the Claude Code / Codex editor extension is found when nothing is on PATH', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ext-'));
  const vs = path.join(home, '.vscode', 'extensions');
  touch(path.join(vs, 'anthropic.claude-code-2.1.9-win32-x64', 'resources', 'native-binary', 'claude.exe'));
  touch(path.join(vs, 'anthropic.claude-code-2.1.292-win32-x64', 'resources', 'native-binary', 'claude.exe'));
  // an update in progress: VS Code lists the folder as obsolete before it deletes it
  touch(path.join(vs, 'anthropic.claude-code-2.2.0-win32-x64', 'resources', 'native-binary', 'claude.exe'));
  fs.writeFileSync(path.join(vs, '.obsolete'), JSON.stringify({ 'anthropic.claude-code-2.2.0-win32-x64': true }));
  // a half-extracted download is a dot-folder without the publisher prefix
  touch(path.join(vs, '.abbb6e0c-c027-4c5e', 'bin', 'windows-x86_64', 'codex.exe'));
  touch(path.join(vs, 'openai.chatgpt-26.1002.51308-win32-x64', 'bin', 'windows-x86_64', 'codex.exe'));
  // Cursor has a newer Codex extension
  touch(path.join(home, '.cursor', 'extensions', 'openai.chatgpt-26.1003.100-win32-x64', 'bin', 'windows-x86_64', 'codex.exe'));

  assert.equal(editorExtensionBin('claude', home, 'win32'), path.join(vs, 'anthropic.claude-code-2.1.292-win32-x64', 'resources', 'native-binary', 'claude.exe'), 'newest version that is not obsolete');
  assert.equal(editorExtensionBin('codex', home, 'win32'), path.join(home, '.cursor', 'extensions', 'openai.chatgpt-26.1003.100-win32-x64', 'bin', 'windows-x86_64', 'codex.exe'));
  assert.equal(editorExtensionBin('claude', home, 'linux'), null, 'no claude without .exe on Linux');
  assert.equal(editorExtensionBin('claude', fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ext-none-'))), null);
});
