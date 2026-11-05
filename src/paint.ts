import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { diff } from 'node:util';
import type { Page } from '@playwright/test';
import { drawFrame, measure, scrollAndHold } from './capture.ts';

// Chromium records paint only this far past the visible area, so longer pages need more than one
// read.
const RECORDED_PAST_SCREEN = 4000;

interface Layer {
  layerId: string;
  backendNodeId?: number;
  width: number;
  height: number;
  drawsContent: boolean;
  transform?: number[];
}

/**
 * What each layer paints and where it sits. The commands behind each one are kept under its pixel
 * hash, only to explain a failure.
 */
export interface PaintRecord {
  lines: string[];
  commands: Record<string, string[]>;
  tops: number[];
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Command {
  method: string;
  params?: {
    paint?: { color?: string };
    dx?: number;
    dy?: number;
    matrix44?: number[];
    x?: number;
    y?: number;
    image?: { width?: number; height?: number };
    dst?: Rect;
    rect?: Rect;
    rrect?: Rect & { upperLeftRadius?: { xRadius?: number } };
    path?: { pathPoints?: Array<{ points?: Array<{ x?: number; y?: number }> }> };
  };
}

function round(value: number | undefined) {
  return Math.round(Number(value) * 10) / 10;
}

// Says what each drawing command drew and where in its layer, following the moves before it. Raw
// logs are megabytes of curve points that explain nothing.
function describeDrawing(log: Command[]) {
  const drawn: string[] = [];
  const saved: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  const point = (left: number, top: number) => `${round(left + x)},${round(top + y)}`;
  const box = (rect: Rect) => `${point(rect.left, rect.top)} to ${point(rect.right, rect.bottom)}`;

  for (const { method, params = {} } of log) {
    const color = params.paint?.color ? ` ${params.paint.color}` : '';

    switch (method) {
      case 'save':
      case 'saveLayer':
        saved.push([x, y]);
        break;
      case 'restore':
        [x, y] = saved.pop() ?? [0, 0];
        break;
      case 'translate':
        [x, y] = [x + params.dx!, y + params.dy!];
        break;
      case 'concat44':
        [x, y] = [x + params.matrix44![12], y + params.matrix44![13]];
        break;
      case 'drawTextBlob':
        drawn.push(`text at ${point(params.x!, params.y!)}${color}`);
        break;
      case 'drawImageRect':
        drawn.push(`image ${params.image?.width}x${params.image?.height} at ${box(params.dst!)}`);
        break;
      case 'drawRect':
        drawn.push(`box ${box(params.rect!)}${color}`);
        break;
      case 'drawRRect':
        drawn.push(
          `rounded box ${box(params.rrect!)} radius ${round(params.rrect!.upperLeftRadius?.xRadius)}${color}`,
        );
        break;
      case 'drawPath': {
        const first = params.path?.pathPoints?.[0]?.points?.[0];

        drawn.push(`shape at ${point(first?.x ?? 0, first?.y ?? 0)}${color}`);
        break;
      }

      default:
        if (method.startsWith('draw')) {
          drawn.push(`${method}${color}`);
        }
    }
  }

  return drawn;
}

/**
 * What the compositor applies on top of a layer's own pixels, from the element that owns it and
 * every element around it. None of it is in the paint record. Runs in the page.
 */
function compositedEffects(this: Node) {
  let opacity = 1;
  const others: string[] = [];

  for (
    let element = this instanceof Element ? this : this.parentElement;
    element;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);

    opacity *= Number(style.opacity);

    for (const value of [
      style.filter,
      style.backdropFilter,
      style.mixBlendMode,
      style.clipPath,
      style.maskImage,
    ]) {
      if (value !== 'none' && value !== 'normal') {
        others.push(value);
      }
    }
  }

  if (opacity !== 1) {
    others.unshift(`opacity ${opacity.toFixed(3)}`);
  }

  return others.join(', ');
}

const NO_PICTURE = /does not produce picture/;
const LAYER_GONE = /No layer matching given id/;

async function scrollStops(page: Page) {
  const { height, lastScroll } = await measure(page);
  const screen = height - lastScroll;
  const stops: number[] = [];

  for (let top = RECORDED_PAST_SCREEN; ; top += 2 * RECORDED_PAST_SCREEN + screen) {
    stops.push(Math.min(top, lastScroll));

    if (top + screen + RECORDED_PAST_SCREEN >= height) {
      return stops;
    }
  }
}

/**
 * Reads what Chromium painted, per layer and without the compositor, so scroll position and
 * in-flight motion can't change it.
 * Drawing order is left out of the verdict because harmless reordering changes it.
 */
export async function paintReader(page: Page) {
  const cdp = await page.context().newCDPSession(page);

  await cdp.send('DOM.enable');

  // Subscribing fresh for every read is what guarantees a current list. The list only arrives
  // after a frame commits.
  const readLayers = async () => {
    let layers: Layer[] = [];
    const note = (event: { layers?: unknown }) => {
      // SAFETY: LayerTree.layerTreeDidChange reports Chromium's layer list.
      layers = (event.layers as Layer[] | undefined) ?? layers;
    };

    cdp.on('LayerTree.layerTreeDidChange', note);
    await cdp.send('LayerTree.enable');

    for (let tries = 0; tries < 40 && !layers.length; tries++) {
      await drawFrame(page);
      await sleep(20);
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
    const { commandLog }: { commandLog: unknown } = await cdp.send('LayerTree.snapshotCommandLog', {
      snapshotId,
    });

    await cdp.send('LayerTree.releaseSnapshot', { snapshotId });

    // SAFETY: Chromium's snapshot command log contains drawing commands with these fields.
    const log = commandLog as Command[];

    return {
      pixels: createHash('sha1').update(dataURL).digest('hex'),
      commands: describeDrawing(log),
    };
  };

  // Paint lines are split on spaces, so spaces in the effects become underscores.
  const effectsOf = async ({ backendNodeId }: Layer) => {
    if (!backendNodeId) {
      return '';
    }

    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: String(compositedEffects),
      returnByValue: true,
    });

    return result.value ? ` effects=${String(result.value).replaceAll(' ', '_')}` : '';
  };

  const readStop = async (stop: number, commands: PaintRecord['commands']) => {
    const found: string[] = [];

    for (const layer of await readLayers()) {
      const place = `${stop} ${layer.width}x${layer.height} ${(layer.transform ?? []).map((value) => +value.toFixed(2)).join(',')}`;
      const effects = await effectsOf(layer);

      try {
        const { pixels, commands: drawn } = await readLayer(layer);

        found.push(`${place} ${pixels}${effects}`);
        commands[pixels] = drawn;
      } catch (error) {
        // A playing video draws outside the paint record, so only its size and place can be
        // compared.
        // SAFETY: Chromium reports snapshot failures with a message.
        if (!NO_PICTURE.test((error as Error).message)) {
          throw error;
        }

        found.push(`${place} video${effects}`);
      }
    }

    return found;
  };

  return async function readPaint(): Promise<PaintRecord> {
    const stops = await scrollStops(page);
    const lines: string[] = [];
    const commands: PaintRecord['commands'] = {};

    for (const [stop, top] of stops.entries()) {
      // Callers settle the page after changing it, so only a move needs another wait.
      if (Math.round(await page.evaluate(() => scrollY)) !== Math.round(top)) {
        await scrollAndHold(page, top);
      }

      for (let attempts = 0; ; attempts++) {
        try {
          lines.push(...(await readStop(stop, commands)));
          await cdp.send('LayerTree.disable');
          break;
        } catch (error) {
          await cdp.send('LayerTree.disable');

          // A frame can replace a layer between listing and reading it.
          // SAFETY: Chromium reports layer failures with a message.
          if (attempts === 8 || !LAYER_GONE.test((error as Error).message)) {
            throw error;
          }

          await scrollAndHold(page, top);
        }
      }
    }

    return {
      lines: lines.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      commands,
      tops: stops,
    };
  };
}

export function paintSummary({ lines }: PaintRecord) {
  return `${lines.join('\n')}\n`;
}

export function lineChanges(before: string[], after: string[]): string[] {
  const lines: string[] = [];

  // Node marks entries from its first argument with 1 and those only in its second with -1.
  for (const [change, command] of diff(after, before)) {
    if (change !== 0) {
      lines.push(`  ${change < 0 ? '-' : '+'} ${command}`);
    }
  }

  return lines;
}

function parseLines({ lines }: PaintRecord) {
  return lines.map((line) => {
    const [stop, size, matrix, pixels, effects = ''] = line.split(' ');
    const parts = (matrix ?? '').split(',').map(Number);

    return {
      stop: Number(stop),
      size,
      matrix,
      pixels,
      effects: effects.replace('effects=', '').replaceAll('_', ' ') || 'none',
      x: parts[12] ?? 0,
      y: parts[13] ?? 0,
    };
  });
}

/** Where on the page drawing changed, to name the elements there. */
export function changedPoints(saved: PaintRecord, now: PaintRecord) {
  const before = parseLines(saved);
  const after = parseLines(now);
  const points: Array<{ x: number; y: number }> = [];

  if (before.length !== after.length) {
    return points;
  }

  for (const [index, layer] of after.entries()) {
    const { pixels } = before[index];

    if (layer.pixels === pixels) {
      continue;
    }

    const top = now.tops[layer.stop] ?? 0;
    const changes = lineChanges(saved.commands[pixels] ?? [], now.commands[layer.pixels] ?? []);

    for (const line of changes) {
      const match = line.match(/(?:at|box) (-?[\d.]+),(-?[\d.]+)/);

      if (match) {
        points.push({ x: Number(match[1]) + layer.x, y: Number(match[2]) + layer.y + top });
      }
    }
  }

  return points;
}

/**
 * Say what differs in a form an agent can act on. This only explains. The comparison of the lines
 * decides.
 */
export function explainPaint(saved: PaintRecord, now: PaintRecord) {
  const before = parseLines(saved);
  const after = parseLines(now);

  if (before.length !== after.length) {
    return [`Layers changed from ${before.length} to ${after.length}.`];
  }

  const lines = new Set<string>();
  const moved = new Set<string>();

  before.forEach((layer, index) => {
    const other = after[index];
    const named =
      layer.size === other.size ? `Layer ${layer.size}` : `Layer ${layer.size}, now ${other.size},`;

    if (layer.effects !== other.effects) {
      lines.add(`${named} is composited with ${other.effects}, instead of ${layer.effects}.`);
    }

    if (layer.matrix !== other.matrix) {
      moved.add(`${named} moved from ${layer.x},${layer.y} to ${other.x},${other.y}.`);
    }

    if (layer.pixels !== other.pixels) {
      const changes = lineChanges(
        saved.commands[layer.pixels] ?? [],
        now.commands[other.pixels] ?? [],
      );

      lines.add(
        `${named} painted differently${changes.length ? ':' : '. Its drawing commands match, so the content of a text or image changed.'}`,
      );
      changes.slice(0, 8).forEach((change) => lines.add(change));

      if (changes.length > 8) {
        lines.add(`  and ${changes.length - 8} more drawing changes`);
      }
    }
  });

  const [first, ...others] = moved;
  const explanation = [...lines];

  if (first) {
    explanation.push(first);
  }

  if (others.length) {
    explanation.push(`${others.length} more layers moved.`);
  }

  return explanation;
}
