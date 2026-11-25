import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderScript } from '../src/panel/folder.js';

test('the folder picker script quotes both paths it receives', () => {
  const script = folderScript("C:\\Temp\\it's out.txt", "D:\\It's a repo");
  assert.match(script, /\[System\.IO\.File\]::WriteAllText\('C:\\Temp\\it''s out\.txt'/);
  assert.match(script, /\$dialog\.SelectedPath = 'D:\\It''s a repo'/);
  assert.match(script, /ShowDialog\(\$owner\) -eq \[System\.Windows\.Forms\.DialogResult\]::OK/);
});

test('the folder picker script omits the initial path when none was given', () => {
  const script = folderScript('C:\\Temp\\out.txt', undefined);
  assert.doesNotMatch(script, /SelectedPath = /);
  assert.match(script, /New-Object System\.Windows\.Forms\.FolderBrowserDialog/);
});

test('the dialog is owned by a transparent topmost form so it cannot open behind the browser', () => {
  const script = folderScript('C:\\Temp\\out.txt', 'C:\\Repo');
  assert.match(script, /\$owner\.TopMost = \$true/);
  assert.match(script, /\$owner\.Opacity = 0/);
  assert.match(script, /\$dialog\.ShowDialog\(\$owner\)/);
  assert.ok(script.indexOf('$owner.Show()') < script.indexOf('$dialog.ShowDialog'));
});
