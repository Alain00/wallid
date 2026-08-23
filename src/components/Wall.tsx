import { useCallback, useEffect, useRef, useState } from "react";
import {
  CELL,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  cellUnder,
  clampZoom,
  panBy,
  zoomAt,
  type Camera,
  type Viewport,
} from "@/wall/camera";
import { cellInfo, heldBy, type ChunkBody } from "@/wall/chunk";
import {
  SIDE,
  cellIndex,
  chunkOf,
  inBounds,
  rectFromDrag,
  type Cell,
  type Rect,
} from "@/wall/geometry";
import { money, quote } from "@/wall/pricing";
import { createSprites, paint } from "@/wall/paint";
import { createSource, type Source } from "@/wall/source";
import { cn } from "@/lib/utils";

/**
 * The wall.
 *
 * One canvas, a camera, and a drag that means "I want this rectangle". Nothing
 * here decides prices — that is `pricing.ts`, shared with the Worker — and
 * nothing here talks to Stripe. It reports a selection upward and draws what
 * the source hands it.
 */

/** Frames are requested, never scheduled on a timer. A wall nobody is touching
 * should cost nothing, and an idle `setInterval` redraw is the most common way
 * a canvas quietly burns a laptop battery. */
function useFrame(draw: () => void) {
  const pending = useRef(0);
  return useCallback(() => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      draw();
    });
  }, [draw]);
}

export type WallProps = {
  onSelect: (rect: Rect, totalCents: number) => void;
  /** The claim just bought, drawn before the server has heard about it. */
  optimistic?: { rect: Rect; claim: ChunkBody["claims"][number]; prices: number[] } | null;
  /**
   * Recede, because something in front is being read.
   *
   * A scrim rather than a disabled canvas: the wall stays pannable underneath
   * and dismissing the panel is a click on it. What dimming buys is that the
   * panel stops competing with several hundred logos for the eye — it can only
   * win that competition by shouting, and dimming ends it instead.
   */
  dim?: boolean;
};

export function Wall({ onSelect, optimistic, dim }: WallProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const source = useRef<Source>(null as unknown as Source);
  const sprites = useRef(createSprites());

  const [camera, setCamera] = useState<Camera>({ x: SIDE / 2, y: SIDE / 2, zoom: 0.5 });
  const [view, setView] = useState<Viewport>({ width: 0, height: 0 });
  const [hover, setHover] = useState<Cell | null>(null);
  const [drag, setDrag] = useState<{ from: Cell; to: Cell } | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  const [, setTick] = useState(0);

  if (!source.current) source.current = createSource();

  const selection: Rect | null = drag ? rectFromDrag(drag.from, drag.to) : null;

  const redraw = useFrame(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !view.width) return;
    paint({
      ctx,
      camera,
      view,
      chunks: source.current.wall().chunks,
      sprites: sprites.current,
      selection,
      hover,
      onLoad: () => setTick(t => t + 1),
    });
  });

  useEffect(redraw);

  /* The wall is sixteen chunks, so there is nothing viewport-shaped to fetch:
   * load the board, then poll at the index's own TTL. */
  useEffect(() => {
    let live = true;
    const pull = async () => {
      if (await source.current.load()) setTick(t => t + 1);
    };
    void pull();
    const timer = setInterval(() => live && void pull(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!optimistic) return;
    source.current.claim(optimistic);
    setTick(t => t + 1);
  }, [optimistic]);

  useEffect(() => {
    const element = wrap.current;
    if (!element) return;

    /*
     * The backing store and the CSS size are set together, always.
     *
     * A canvas has two sizes and they are not the same property. The `width`
     * attribute is the pixel buffer; the CSS box is what it is stretched over.
     * Set only the second and every line is drawn at the wrong scale into a
     * 300x150 default buffer, which is the classic blurry-canvas bug.
     */
    const measure = (width: number, height: number) => {
      setView({ width, height });
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (!canvas.current) return;
      canvas.current.width = Math.round(width * dpr);
      canvas.current.height = Math.round(height * dpr);
    };

    /*
     * Measured once here, and then again whenever the box changes.
     *
     * The observer is supposed to deliver an initial entry on `observe`, and in
     * a browser somebody is looking at, it does. It is not guaranteed to have
     * done so by any particular moment, and when it has not the canvas sits at
     * zero and paints nothing — a blank wall that looks exactly like a wall
     * with nothing on it. Measuring up front makes the first frame depend on
     * layout rather than on a callback's timing.
     */
    const box = element.getBoundingClientRect();
    if (box.width) measure(box.width, box.height);

    const observer = new ResizeObserver(([entry]) => {
      const next = entry!.contentRect;
      measure(next.width, next.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /*
   * Zoom is ctrl+wheel and the buttons, never a bare wheel.
   *
   * The wall is the page here rather than a section in the middle of one, so
   * capturing the wheel is defensible in a way it would not be otherwise — but
   * a bare wheel still scrolls, because the rules and the receipt sit below the
   * fold and a board that eats the scroll gesture traps people on it. A pinch
   * arrives as ctrl+wheel and means nothing else.
   */
  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const box = canvas.current!.getBoundingClientRect();
    setCamera(current =>
      zoomAt(
        current,
        view,
        Math.pow(ZOOM_STEP, -event.deltaY / 100),
        event.clientX - box.left,
        event.clientY - box.top,
      ),
    );
  };

  const cellAtEvent = (event: { clientX: number; clientY: number }): Cell => {
    const box = canvas.current!.getBoundingClientRect();
    return cellUnder(camera, view, event.clientX - box.left, event.clientY - box.top);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    (event.target as Element).setPointerCapture(event.pointerId);
    // Middle button and space-drag pan; the primary button draws a rectangle,
    // because selecting is what this wall is for and panning is how you get
    // somewhere to select.
    if (event.button === 1 || event.shiftKey) {
      setPan({ x: event.clientX, y: event.clientY });
      return;
    }
    const cell = cellAtEvent(event);
    if (!inBounds(cell.x, cell.y)) return;
    setDrag({ from: cell, to: cell });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (pan) {
      setCamera(current =>
        panBy(current, (pan.x - event.clientX) / (CELL * current.zoom), (pan.y - event.clientY) / (CELL * current.zoom)),
      );
      setPan({ x: event.clientX, y: event.clientY });
      return;
    }
    const cell = cellAtEvent(event);
    setHover(inBounds(cell.x, cell.y) ? cell : null);
    if (drag) setDrag({ ...drag, to: cell });
  };

  const onPointerUp = () => {
    setPan(null);
    if (!drag) return;
    const rect = rectFromDrag(drag.from, drag.to);
    setDrag(null);
    onSelect(rect, quote(rect, heldBy(source.current.wall().chunks)).totalCents);
  };

  /* What the pointer is over, priced. The figure that follows the cursor is
   * computed from the chunks the client already holds rather than fetched:
   * a quote per pointer move would be a request per pointer move. */
  const under = hover ? cellInfo(
    source.current.wall().chunks,
    chunkOf(hover.x, hover.y),
    cellIndex(hover.x, hover.y),
  ) : null;

  const live = selection
    ? quote(selection, heldBy(source.current.wall().chunks))
    : null;

  return (
    <div ref={wrap} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvas}
        className="h-full w-full touch-none select-none"
        style={{ cursor: pan ? "grabbing" : "crosshair" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
      />

      {/*
        A scrim between the canvas and whatever is being read over it.

        Three quarters rather than opaque: "you found a nice spot" means nothing
        if you cannot see what the spot is next to.
      */}
      <div
        aria-hidden="true"
        className={cn(
          "bg-ground pointer-events-none absolute inset-0 transition-opacity duration-300",
          dim ? "opacity-70" : "opacity-0",
        )}
      />

      {/*
        The price of whatever the pointer is on, which is the one number that
        has to be answerable without clicking anything.

        Bottom centre, floating, in the same pill as every other chip on the
        page. Keyed by cell so that moving to the next one genuinely remounts it
        and the entry animation fires again — one price announcing itself per
        cell. See `.wall-plate` in `styles.css`.
      */}
      {(live || under) && hover && !dim && (
        <div
          key={`${hover.x},${hover.y}`}
          className="wall-plate border-line/70 bg-ground/70 pointer-events-none absolute bottom-6 left-1/2 rounded-full border px-5 py-2.5 backdrop-blur"
        >
          {live ? (
            <>
              <span className="text-ink text-lg">{money(live.totalCents)}</span>
              <span className="text-muted text-sm">
                {" "}
                for {live.cells.length} cell{live.cells.length === 1 ? "" : "s"}
                {live.takeovers > 0 && ` · taking ${live.takeovers} from someone`}
              </span>
            </>
          ) : under ? (
            <>
              <span className="text-ink">{under.claim.label || "hidden"}</span>
              <span className="text-muted text-sm">
                {" "}
                · held at {money(under.entry.priceCents)}
              </span>
            </>
          ) : null}
        </div>
      )}

      <div className="absolute top-4 right-4 flex flex-col gap-1.5 sm:top-6 sm:right-6">
        <ZoomButton
          label="Zoom in"
          onClick={() => setCamera(c => ({ ...c, zoom: clampZoom(c.zoom * ZOOM_STEP) }))}
          disabled={camera.zoom >= MAX_ZOOM}
        >
          +
        </ZoomButton>
        <ZoomButton
          label="Zoom out"
          onClick={() => setCamera(c => ({ ...c, zoom: clampZoom(c.zoom / ZOOM_STEP) }))}
          disabled={camera.zoom <= MIN_ZOOM}
        >
          −
        </ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  children,
  ...props
}: React.ComponentProps<"button"> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      className={cn(
        "border-line/70 bg-ground/70 text-ink/70 size-9 rounded-full border backdrop-blur",
        "hover:text-ink hover:border-muted text-lg leading-none transition-colors duration-150",
        "disabled:hover:text-ink/70 disabled:hover:border-line/70 disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
