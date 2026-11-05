import { createHash } from 'node:crypto';
import { diff } from 'node:util';
import type { Page } from '@playwright/test';
import { drawFrame, measure, scrollAndHold } from './capture.ts';

// Chromium records paint only this far past the visible area, so longer pages need more than one read.
const RECORDED_PAST_SCREEN = 4000;

type Layer = { layerId: string; width: number; height: number; drawsContent: boolean; transform?: number[] };

/** What each layer paints and where it sits. The commands behind each one are kept under its pixel hash, only to explain a failure. */
export type PaintRecord = { lines: string[]; commands: Record<string, string[]>; tops: number[] };

type Command = { method: string; params?: Record<string, any> };

const round = (value: unknown) => Math.round(Number(value) * 10) / 10;

// Says what each drawing command drew and where in its layer, following the moves before it. Raw logs are megabytes of curve points that explain nothing.
function describeDrawing(log: Command[]) {
  const drawn: string[] = [];
  const saved: [number, number][] = [];
  let x = 0;
  let y = 0;

  for (const { method, params = {} } of log) {
    const color = params.paint?.color ? ` ${params.paint.color}` : '';
    const box = (rect: Record<string, number>) => `${round(rect.left! + x)},${round(rect.top! + y)} to ${round(rect.right! + x)},${round(rect.bottom! + y)}`;

    if (method === 'save' || method === 'saveLayer') saved.push([x, y]);
    else if (method === 'restore') [x, y] = saved.pop() ?? [0, 0];
    else if (method === 'translate') [x, y] = [x + params.dx, y + params.dy];
    else if (method === 'concat44') [x, y] = [x + params.matrix44[12], y + params.matrix44[13]];
    else if (method === 'drawTextBlob') drawn.push(`text at ${round(params.x + x)},${round(params.y + y)}${color}`);
    else if (method === 'drawImageRect') drawn.push(`image ${params.image?.width}x${params.image?.height} at ${box(params.dst)}`);
    else if (method === 'drawRect') drawn.push(`box ${box(params.rect)}${color}`);
    else if (method === 'drawRRect') drawn.push(`rounded box ${box(params.rrect)} radius ${round(params.rrect.upperLeftRadius?.xRadius)}${color}`);
    else if (method === 'drawPath') {
      const first = params.path?.pathPoints?.[0]?.points?.[0];

      drawn.push(`shape at ${round((first?.x ?? 0) + x)},${round((first?.y ?? 0) + y)}${color}`);
    } else if (method.startsWith('draw')) drawn.push(`${method}${color}`);
  }

  return drawn;
}

const NO_PICTURE = /does not produce picture/;
const LAYER_GONE = /No layer matching given id/;

/**
 * Reads what Chromium painted, per layer and without the compositor, so scroll position and in-flight motion can't change it.
 * Drawing order is left out of the verdict because harmless reordering changes it.
 */
export async function paintReader(page: Page) {
  const cdp = await page.context().newCDPSession(page);

  // Subscribing fresh for every read is what guarantees a current list. The list only arrives after a frame commits.
  const readLayers = async () => {
    let layers: Layer[] = [];
    const note = (event: { layers?: unknown }) => {
      layers = (event.layers as Layer[] | undefined) ?? layers;
    };

    cdp.on('LayerTree.layerTreeDidChange', note);
    await cdp.send('LayerTree.enable');

    for (let tries = 0; tries < 40 && !layers.length; tries++) {
      await drawFrame(page);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    cdp.off('LayerTree.layerTreeDidChange', note);

    if (!layers.length) {
      throw new Error('Chromium reported no layers for this page.');
    }

    return layers.filter(({ drawsContent, width, height }) => drawsContent && width && height);
  };

  const readLayer = async (layer: Layer) => {
    const { snapshotId } = await cdp.send('LayerTree.makeSnapshot', { layerId: layer.layerId });
    const { dataURL } = await cdp.send('LayerTree.replaySnapshot', { snapshotId });
    const { commandLog } = await cdp.send('LayerTree.snapshotCommandLog', { snapshotId });

    await cdp.send('LayerTree.releaseSnapshot', { snapshotId });

    return {
      pixels: createHash('sha1').update(dataURL).digest('hex'),
      commands: describeDrawing(commandLog as unknown as Command[]),
    };
  };

  return async function readPaint(): Promise<PaintRecord> {
    const { height, lastScroll } = await measure(page);
    const screen = height - lastScroll;
    const stops: number[] = [];

    for (let top = RECORDED_PAST_SCREEN; ; top += 2 * RECORDED_PAST_SCREEN + screen) {
      stops.push(Math.min(top, lastScroll));

      if (top + screen + RECORDED_PAST_SCREEN >= height) {
        break;
      }
    }

    const lines: string[] = [];
    const commands: PaintRecord['commands'] = {};

    for (const [stop, top] of stops.entries()) {
      // Callers settle the page after changing it, so only a move needs another wait.
      if (Math.round(await page.evaluate(() => scrollY)) !== Math.round(top)) {
        await scrollAndHold(page, top);
      }

      for (let attempts = 0; ; attempts++) {
        try {
          const found: string[] = [];

          for (const layer of await readLayers()) {
            const place = `${stop} ${layer.width}x${layer.height} ${(layer.transform ?? []).map((value) => +value.toFixed(2)).join(',')}`;

            try {
              const { pixels, commands: drawn } = await readLayer(layer);

              found.push(`${place} ${pixels}`);
              commands[pixels] = drawn;
            } catch (error) {
              // A playing video draws outside the paint record, so only its size and place can be compared.
              if (!NO_PICTURE.test((error as Error).message)) {
                throw error;
              }

              found.push(`${place} video`);
            }
          }

          lines.push(...found);
          await cdp.send('LayerTree.disable');
          break;
        } catch (error) {
          await cdp.send('LayerTree.disable');

          // A frame can replace a layer between listing and reading it.
          if (attempts === 8 || !LAYER_GONE.test((error as Error).message)) {
            throw error;
          }

          await scrollAndHold(page, top);
        }
      }
    }

    return { lines: lines.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), commands, tops: stops };
  };
}

export const paintSummary = ({ lines }: PaintRecord) => `${lines.join('\n')}\n`;

function commandChanges(before: string[], after: string[]) {
  const lines: string[] = [];

  // Node marks entries from its first argument with 1 and those only in its second with -1.
  for (const [change, command] of diff(after, before)) {
    if (change !== 0) {
      lines.push(`  ${change < 0 ? '-' : '+'} ${command}`);
    }
  }

  return lines;
}

const parseLines = ({ lines }: PaintRecord) =>
  lines.map((line) => {
    const [stop, size, matrix, pixels] = line.split(' ');
    const parts = (matrix ?? '').split(',').map(Number);

    return { stop: Number(stop), size, matrix, pixels: pixels!, x: parts[12] ?? 0, y: parts[13] ?? 0 };
  });

/** Where on the page drawing changed, to name the elements there. */
export function changedPoints(saved: PaintRecord, now: PaintRecord) {
  const before = parseLines(saved);
  const after = parseLines(now);

  if (before.length !== after.length) {
    return [];
  }

  return after.flatMap((layer, index) =>
    layer.pixels === before[index]!.pixels
      ? []
      : commandChanges(saved.commands[before[index]!.pixels] ?? [], now.commands[layer.pixels] ?? [])
          .map((line) => line.match(/(?:at|box) (-?[\d.]+),(-?[\d.]+)/))
          .filter((match) => match !== null)
          .map((match) => ({ x: Number(match[1]) + layer.x, y: Number(match[2]) + layer.y + (now.tops[layer.stop] ?? 0) })),
  );
}

/** Say what differs in a form an agent can act on. This only explains. The comparison of the lines decides. */
export function explainPaint(saved: PaintRecord, now: PaintRecord) {
  const before = parseLines(saved);
  const after = parseLines(now);

  if (before.length !== after.length) {
    return [`Layers changed from ${before.length} to ${after.length}.`];
  }

  const lines = new Set<string>();
  const moved = new Set<string>();

  before.forEach((layer, index) => {
    const other = after[index]!;
    const named = layer.size === other.size ? `Layer ${layer.size}` : `Layer ${layer.size}, now ${other.size},`;

    if (layer.matrix !== other.matrix) {
      moved.add(`${named} moved from ${layer.x},${layer.y} to ${other.x},${other.y}.`);
    }

    if (layer.pixels !== other.pixels) {
      const changes = commandChanges(saved.commands[layer.pixels] ?? [], now.commands[other.pixels] ?? []);

      lines.add(`${named} painted differently${changes.length ? ':' : '. Its drawing commands match, so the content of a text or image changed.'}`);
      changes.slice(0, 8).forEach((change) => lines.add(change));

      if (changes.length > 8) {
        lines.add(`  and ${changes.length - 8} more drawing changes`);
      }
    }
  });

  const [first, ...others] = moved;

  return [...lines, ...(first ? [first] : []), ...(others.length ? [`${others.length} more layers moved.`] : [])];
}
