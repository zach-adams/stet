import { createHash } from 'node:crypto';
import { diff } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { CDPSession, Page } from '@playwright/test';
import { measure, scrollAndHold } from './capture.ts';

// Chromium records paint only this far past the visible area, so longer pages need more than one read.
const RECORDED_PAST_SCREEN = 4000;

type LayerTreeEvent = { layers?: { layerId: string; width: number; height: number; drawsContent: boolean; transform?: number[] }[] };

async function readLayers(page: Page, cdp: CDPSession) {
  let layers: NonNullable<LayerTreeEvent['layers']> = [];
  const note = (event: LayerTreeEvent) => {
    layers = event.layers ?? layers;
  };

  cdp.on('LayerTree.layerTreeDidChange', note);
  await cdp.send('LayerTree.enable');

  // The tree only arrives after a frame commits. Use Playwright's capture here, because a raw Page.captureScreenshot with a clip changes the layout on emulated phones.
  for (let tries = 0; tries < 40 && !layers.length; tries++) {
    await page.screenshot({ type: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 1, height: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  cdp.off('LayerTree.layerTreeDidChange', note);

  if (!layers.length) {
    throw new Error('Chromium reported no layers for this page.');
  }

  return layers.filter((layer) => layer.drawsContent && layer.width && layer.height);
}

// Drawing Chromium's own record per layer skips the compositor, so scroll position and in-flight motion can't change it.
export async function readPaintRecord(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const { height, lastScroll } = await measure(page);
  const screen = height - lastScroll;
  const stops: number[] = [];

  for (let top = RECORDED_PAST_SCREEN; ; top += 2 * RECORDED_PAST_SCREEN + screen) {
    stops.push(Math.min(top, lastScroll));

    if (top + screen + RECORDED_PAST_SCREEN >= height) {
      break;
    }
  }

  const layers: { line: string; commands: string[] }[] = [];

  for (const [stop, top] of stops.entries()) {
    await scrollAndHold(page, top);

    for (const layer of await readLayers(page, cdp)) {
      const { snapshotId } = await cdp.send('LayerTree.makeSnapshot', { layerId: layer.layerId });
      const { dataURL } = await cdp.send('LayerTree.replaySnapshot', { snapshotId });
      const { commandLog } = await cdp.send('LayerTree.snapshotCommandLog', { snapshotId });

      await cdp.send('LayerTree.releaseSnapshot', { snapshotId });

      const matrix = (layer.transform ?? []).map((value) => +value.toFixed(2)).join(',');
      const pixels = createHash('sha1').update(dataURL).digest('hex');

      layers.push({
        line: `${stop} ${layer.width}x${layer.height} ${matrix} ${pixels}`,
        // Image ids change on every load, so they can't be part of a comparison.
        commands: commandLog.map((command) => JSON.stringify(command, (key, value) => (key === 'uniqueID' ? undefined : value))),
      });
    }

    await cdp.send('LayerTree.disable');
  }

  await scrollAndHold(page, 0);
  await cdp.detach();
  layers.sort((a, b) => a.line.localeCompare(b.line, 'en', { numeric: true }));

  return {
    // The verdict: what each layer paints and where it sits. Drawing order is left out because harmless reordering changes it.
    summary: `${layers.map((layer) => layer.line).join('\n')}\n`,
    commands: gzipSync(JSON.stringify(layers.map((layer) => layer.commands))),
  };
}

const round = (value: unknown) => Math.round(Number(value) * 10) / 10;

function describeCommand(json: string) {
  const { method, params = {} } = JSON.parse(json);
  const color = params.paint?.color ? ` ${params.paint.color}` : '';
  const box = (rect: Record<string, number>) => `${round(rect.left)},${round(rect.top)} to ${round(rect.right)},${round(rect.bottom)}`;

  if (method === 'drawTextBlob') return `text at ${round(params.x)},${round(params.y)}${color}`;
  if (method === 'drawImageRect') return `image ${params.image?.width}x${params.image?.height} at ${box(params.dst)}`;
  if (method === 'drawRect') return `box ${box(params.rect)}${color}`;
  if (method === 'drawRRect') return `rounded box ${box(params.rrect)} radius ${round(params.rrect.upperLeftRadius?.xRadius)}${color}`;
  if (method === 'drawPath') return `shape${color}`;
  if (method.startsWith('draw')) return `${method}${color}`;

  return undefined;
}

function commandChanges(before: string[], after: string[]) {
  const lines: string[] = [];

  // Node marks entries from its first argument with 1 and those only in its second with -1.
  for (const [change, command] of diff(after, before)) {
    const described = change === 0 ? undefined : describeCommand(command);

    if (described) {
      lines.push(`  ${change < 0 ? '-' : '+'} ${described}`);
    }
  }

  return lines.length > 8 ? [...lines.slice(0, 8), `  and ${lines.length - 8} more drawing changes`] : lines;
}

/** Say what differs in a form an agent can act on. This only explains. The summary comparison decides. */
export function explainPaint(beforeSummary: string, afterSummary: string, beforeCommands: Buffer, afterCommands: Buffer) {
  const parse = (summary: string) =>
    summary.trim().split('\n').map((line) => {
      const [stop, size, matrix, pixels] = line.split(' ');
      const parts = (matrix ?? '').split(',');

      return { stop, size, matrix, pixels, position: `${parts[12] ?? 0},${parts[13] ?? 0}` };
    });
  const before = parse(beforeSummary);
  const after = parse(afterSummary);

  if (before.length !== after.length) {
    return [`Layers changed from ${before.length} to ${after.length}.`];
  }

  const beforeLogs: string[][] = JSON.parse(gunzipSync(beforeCommands).toString());
  const afterLogs: string[][] = JSON.parse(gunzipSync(afterCommands).toString());
  const lines = new Set<string>();
  const moved = new Set<string>();

  before.forEach((layer, index) => {
    const other = after[index]!;
    const named = layer.size === other.size ? `Layer ${layer.size}` : `Layer ${layer.size}, now ${other.size},`;

    if (layer.matrix !== other.matrix) {
      moved.add(`${named} moved from ${layer.position} to ${other.position}.`);
    }

    if (layer.pixels !== other.pixels) {
      const changes = commandChanges(beforeLogs[index] ?? [], afterLogs[index] ?? []);

      lines.add(`${named} painted differently${changes.length ? ':' : '. Its drawing commands match, so the content of a text or image changed.'}`);
      changes.forEach((change) => lines.add(change));
    }
  });

  const [first, ...others] = moved;

  return [...lines, ...(first ? [first] : []), ...(others.length ? [`${others.length} more layers moved.`] : [])];
}
