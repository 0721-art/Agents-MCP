// The panel assets are files next to this module in a checkout and embedded assets inside the
// single executable, so a double-clicked Agents-MCP.exe needs no source tree beside it.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled CommonJS build has no import.meta.url, so resolve the directory only when used.
function panelDirectory() {
  try {
    return fileURLToPath(new URL('../panel/', import.meta.url));
  } catch {
    return join(process.cwd(), 'panel');
  }
}

async function embeddedSea() {
  try {
    const { default: sea } = await import('node:sea');
    return sea?.isSea?.() ? sea : undefined;
  } catch {
    return undefined;
  }
}

export async function readPanelFile(name) {
  const sea = await embeddedSea();
  if (sea) {
    try {
      return Buffer.from(sea.getAsset(name, 'utf8'));
    } catch { /* Not embedded: fall through to the checkout. */ }
  }
  return readFile(join(panelDirectory(), name));
}
