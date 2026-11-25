import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderScript } from '../src/panel/folder.js';

test('the folder picker script quotes both paths it receives', () => {
  const script = folderScript("C:\\Temp\\it's out.txt", "D:\\It's a repo");
  assert.match(script, /\[System\.IO\.File\]::WriteAllText\('C:\\Temp\\it''s out\.txt'/);
  assert.match(script, /\$dialog\.SelectedPath = 'D:\\It''s a repo'/);
  assert.match(script, /ShowDialog\(\) -eq \[System\.Windows\.Forms\.DialogResult\]::OK/);
});

test('the folder picker script omits the initial path when none was given', () => {
  const script = folderScript('C:\\Temp\\out.txt', undefined);
  assert.doesNotMatch(script, /SelectedPath = /);
  assert.match(script, /New-Object System\.Windows\.Forms\.FolderBrowserDialog/);
});
