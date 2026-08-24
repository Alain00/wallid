import { useCallback, useEffect, useRef, useState } from "react";
import {
  CELL,
  FLIGHT_MS,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  cellToScreen,
  cellUnder,
  clampZoom,
  flightAt,
  framing,
  moveBy,
  pinchTo,
  placeInFreeSpace,
  screenToCell,
  zoomAt,
  type Camera,
  type Pinch,
  type Viewport,
} from "@/wall/camera";
import {
  cellInfo,
  claimedCells,
  heldBy,
  type ChunkBody,
  type CellEntry,
  type ClaimEntry,
} from "@/wall/chunk";
import {
  SIDE,
  cellIndex,
  chunkOf,
  inBounds,
  rectFromDrag,
  type Cell,
  type Rect,
} from "@/wall/geometry";
import { money, nextPrice, quote } from "@/wall/pricing";
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

/**
 * How far a pointer may travel and still count as a click.
 *
 * A drag of two pixels is a click with a shaky hand, and the difference matters
 * here more than usual: a click on a held cell opens somebody's website, and a
 * drag over it starts a purchase. Cell equality alone is not enough of a test,
 * because at low zoom a cell is eight pixels wide and a genuine drag can begin
 * and end inside one.
 */
const CLICK_SLOP = 4;

/**
 * How long a finger has to rest before it is drawing a rectangle rather than
 * dragging the wall.
 *
 * Touch has one gesture where a mouse has three — no buttons, no modifier
 * keys, no hand tool worth reaching for — and something has to give. What gives
 * is selecting: on a phone the wall *is* the page, and a finger that draws a
 * rectangle the moment it lands is a finger that cannot look around. So pan and
 * pinch are free, and the rectangle costs a press and hold.
 *
 * 400ms is the length every platform's own long press already is, which is the
 * only argument for it that matters: it is not a number to be tuned, it is a
 * number to be matched.
 */
const LONG_PRESS_MS = 400;

/**
 * How far a finger may travel and still be resting.
 *
 * Wider than `CLICK_SLOP`, because a fingertip is a centimetre across and its
 * reported point wanders inside that while nothing is moving. Four pixels would
 * cancel most long presses before they landed and call the rest of them drags.
 */
const TOUCH_SLOP = 10;

/** Pixels one arrow-key press moves the wall. A little under a small viewport's
 * half, so held keys travel at a readable speed rather than teleporting. */
const KEY_PAN = 90;

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
  /**
   * The claim being filled in, drawn where it would go.
   *
   * The rectangle also becomes the hole in the scrim — see below. Dimming the
   * preview along with the wall would be dimming the one thing the buyer is
   * being asked to look at.
   */
  draft?: { rect: Rect; claim: ClaimEntry } | null;
  /**
   * Screen space something else is using — the buy panel's own box.
   *
   * The wall flies the draft's rectangle into what is left, because a preview
   * of what you are buying is worthless underneath the form asking you to buy
   * it. Measured by the panel and passed through rather than assumed here; see
   * `onBox` in `BuyPanel`.
   */
  reserved?: DOMRect | null;
  /**
   * The claim a buyer has just come back from Stripe having paid for.
   *
   * Their cells are settled by the time they land here — the webhook does that
   * — but the wall they are looking at may not know: the index is served with
   * `max-age=30`, so the browser can answer the first fetch out of its own
   * cache with a copy from before the purchase. Which is a buyer arriving on a
   * page that does not show the thing they just paid for, and reaching for a
   * hard refresh.
   *
   * So this forces the read past every cache, and then flies them to it.
   */
  arrived?: string | null;
  /**
   * God mode, from `src/wall/god.ts`: development only, and a constant `false`
   * in a production build. What it adds here is one button on the claim card —
   * the ability to take a claim off the wall, which production has no route for
   * and should not.
   */
  god?: boolean;
  /** Free the cells under a claim. Only ever called from the god-mode button. */
  onFree?: (rect: Rect) => void;
  /**
   * Bumped by the page when something changed the wall behind the client's
   * back — a god-mode placement or deletion. The index is cached for thirty
   * seconds and the poll would eventually notice, but "eventually" is a wall
   * that ignores you for half a minute after you press a button.
   */
  refresh?: number;
};

/** A held cell somebody has clicked: the card that offers its website. */
type Focus = { cell: Cell; entry: CellEntry; claim: ClaimEntry };

export function Wall({
  onSelect,
  optimistic,
  dim,
  draft,
  reserved,
  arrived,
  god,
  onFree,
  refresh,
}: WallProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const source = useRef<Source>(null as unknown as Source);
  const sprites = useRef(createSprites());

  const [camera, setCamera] = useState<Camera>({ x: SIDE / 2, y: SIDE / 2, zoom: 0.5 });
  const [view, setView] = useState<Viewport>({ width: 0, height: 0 });
  const [hover, setHover] = useState<Cell | null>(null);
  const [drag, setDrag] = useState<{ from: Cell; to: Cell } | null>(null);
  const [panning, setPanning] = useState(false);
  /** The hand tool: the toggle in the corner, or the space bar held down. */
  const [handTool, setHandTool] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [, setTick] = useState(0);

  /* The wheel handler is attached by hand rather than through `onWheel`, and
   * needs today's viewport without being rebuilt on every resize. */
  const viewRef = useRef(view);
  viewRef.current = view;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  /** The running flight, so a gesture can cut it short. Nothing is more
   * irritating than a camera that keeps moving after you grabbed the wall. */
  const flight = useRef(0);
  const stopFlight = useCallback(() => {
    if (flight.current) cancelAnimationFrame(flight.current);
    flight.current = 0;
  }, []);
  /** The rectangle already flown to, so a keystroke in the panel does not
   * re-fly a camera that is already there. */
  const flown = useRef("");

  if (!source.current) source.current = createSource();

  const grabbing = handTool || spaceHeld;
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
      draft,
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

  /*
   * A buyer, just returned, whose cells may not be on the wall they can see.
   *
   * Polled rather than fetched once, because the webhook and the redirect race:
   * Stripe sends the browser back the moment the payment succeeds and delivers
   * the event separately, so the claim can settle a second or two *after* the
   * buyer is already looking at the wall. A single forced read would lose that
   * race about as often as it won it.
   *
   * Bounded, and it gives up quietly. If the event is genuinely late the
   * thirty-second poll below will bring the claim in anyway; there is nothing
   * to tell the buyer and nothing they could do about it.
   */
  useEffect(() => {
    if (!arrived) return;
    let live = true;
    let tries = 0;

    const look = async () => {
      if (!live) return;
      tries += 1;
      await source.current.load(true);
      const found = [...claimedCells(source.current.wall().chunks)].find(
        cell => cell.claim.id === arrived,
      );
      setTick(t => t + 1);

      if (found) {
        // Their own cells, centred and legible: the arrival is the one moment
        // on this wall where the camera knows exactly what somebody wants to
        // look at.
        setCamera(current =>
          flightAt(current, placeInFreeSpace(viewRef.current, null, found.claim.rect), 1),
        );
        return;
      }
      if (live && tries < 8) setTimeout(() => void look(), 1200);
    };

    void look();
    return () => {
      live = false;
    };
  }, [arrived]);

  useEffect(() => {
    if (!optimistic) return;
    source.current.claim(optimistic);
    setTick(t => t + 1);
  }, [optimistic]);

  /* Forced past the index's TTL, because the caller already knows the wall
   * changed — it is the one that changed it. */
  useEffect(() => {
    if (!refresh) return;
    let live = true;
    void source.current.load(true).then(() => live && setTick(t => t + 1));
    return () => {
      live = false;
    };
  }, [refresh]);

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
   * The wheel zooms, and it is attached by hand.
   *
   * By hand because React registers `wheel` on its root as a *passive*
   * listener, and a passive listener's `preventDefault` does nothing: the
   * gesture would zoom the wall and scroll or page-zoom the document as well.
   * `{ passive: false }` is the only way to own the gesture, and owning it is
   * safe here in a way it usually is not — the page is one viewport tall with
   * no scroll of its own, so nothing is being taken away from anyone.
   *
   * A bare wheel zooms rather than pans because on this page there is nothing
   * else a wheel could mean, and because "scroll to zoom" is what every map a
   * visitor has ever used does. Two exceptions, both of them a trackpad: a
   * pinch arrives as ctrl+wheel and still zooms, and a two-finger swipe with a
   * sideways component is a pan, because that is the gesture people use to
   * shove a map along and it would be a lurching zoom otherwise.
   */
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stopFlight();
      // Line and page modes come from mice with notched wheels and from a few
      // Firefox configurations; the numbers are meaningless until scaled to
      // pixels.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;

      const pinch = event.ctrlKey || event.metaKey;
      if (!pinch && Math.abs(dx) > Math.abs(dy)) {
        setCamera(current => moveBy(current, dx, dy));
        return;
      }

      const box = element.getBoundingClientRect();
      setCamera(current =>
        zoomAt(
          current,
          viewRef.current,
          Math.pow(ZOOM_STEP, -dy / 100),
          event.clientX - box.left,
          event.clientY - box.top,
        ),
      );
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [stopFlight]);

  /*
   * The keyboard drives the camera too.
   *
   * Not an accessibility box-tick: a wall you can only cross by dragging is a
   * wall a trackpad user crosses in a dozen strokes. Space is the hand tool
   * everyone already knows from every canvas application, held rather than
   * toggled, so it costs nothing to reach for and nothing to leave.
   */
  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      return (
        element.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
      );
    };

    const step = (dx: number, dy: number) => setCamera(current => moveBy(current, dx, dy));

    const onKeyDown = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (event.key === "Escape") return setFocus(null);
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case " ":
          event.preventDefault();
          return setSpaceHeld(true);
        case "ArrowLeft":
          event.preventDefault();
          return step(-KEY_PAN, 0);
        case "ArrowRight":
          event.preventDefault();
          return step(KEY_PAN, 0);
        case "ArrowUp":
          event.preventDefault();
          return step(0, -KEY_PAN);
        case "ArrowDown":
          event.preventDefault();
          return step(0, KEY_PAN);
        case "+":
        case "=":
          return setCamera(c => ({ ...c, zoom: clampZoom(c.zoom * ZOOM_STEP) }));
        case "-":
        case "_":
          return setCamera(c => ({ ...c, zoom: clampZoom(c.zoom / ZOOM_STEP) }));
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    // A window that loses focus mid-gesture never delivers the keyup, and the
    // wall would be stuck in the hand tool with no way to tell why.
    const onBlur = () => setSpaceHeld(false);

    addEventListener("keydown", onKeyDown);
    addEventListener("keyup", onKeyUp);
    addEventListener("blur", onBlur);
    return () => {
      removeEventListener("keydown", onKeyDown);
      removeEventListener("keyup", onKeyUp);
      removeEventListener("blur", onBlur);
    };
  }, []);

  /** An event's position in the canvas's own pixels. Every pointer calculation
   * here starts from this: `clientX` is relative to the window, and the canvas
   * is not at its corner. */
  const pointAt = (event: { clientX: number; clientY: number }) => {
    const box = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  /*
   * Fly a new selection into the space the panel is not using.
   *
   * Two things are being solved at once and `framing` does both: where the
   * rectangle lands on screen, and how close. The landing point is the middle
   * of whatever the panel left over — the strip to its left when it is docked,
   * the space above it when it is a sheet — and the zoom is whatever makes the
   * rectangle fill a comfortable part of that, so a 1x1 is worth looking at and
   * a 16x16 fits.
   *
   * Only on a new rectangle. The panel reports a draft on every keystroke, and
   * a camera that re-flew each time somebody typed a letter would be unusable.
   */
  useEffect(() => {
    if (!draft || !view.width || !reserved) return;

    const key = `${draft.rect.x},${draft.rect.y},${draft.rect.w},${draft.rect.h}`;
    if (flown.current === key) return;
    flown.current = key;

    const to = placeInFreeSpace(view, reserved, draft.rect);

    const from = cameraRef.current;
    const start = performance.now();
    stopFlight();
    const step = (at: number) => {
      const t = Math.min(1, (at - start) / FLIGHT_MS);
      setCamera(flightAt(from, to, t));
      flight.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    flight.current = requestAnimationFrame(step);
    return stopFlight;
  }, [draft, view, reserved, stopFlight]);

  /* A closed panel means the next selection is a new one, wherever it lands. */
  useEffect(() => {
    if (!draft) flown.current = "";
  }, [draft]);

  const cellAtEvent = (event: { clientX: number; clientY: number }): Cell => {
    const at = pointAt(event);
    return cellUnder(camera, view, at.x, at.y);
  };

  /*
   * The point on the wall a pan grabbed, in fractional cell space.
   *
   * A ref, and the anchor for the whole gesture rather than for one event. The
   * alternative — add up each move's delta — is a different thing that only
   * looks the same: every move re-reads a `pan` position from React state, so
   * a frame that coalesces two moves, or a render that lands late, drops the
   * difference on the floor and the wall arrives somewhere the cursor did not
   * ask for. Solving for "this cell is under this pixel" has no state to fall
   * behind: whatever the events do, the grabbed point is under the cursor.
   */
  const grabbed = useRef<{ x: number; y: number } | null>(null);

  const infoAt = (cell: Cell) =>
    cellInfo(source.current.wall().chunks, chunkOf(cell.x, cell.y), cellIndex(cell.x, cell.y));

  /*
   * Every pointer currently down, by id, in canvas pixels.
   *
   * A mouse never has more than one and none of this applies to it. A hand has
   * as many as it puts on the glass, and the count is the gesture: one finger
   * is a pan, two are a pinch, and the change from one to two has to be able to
   * take the gesture away from whatever the first finger had started.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  /** The pinch as of the last move, or `null` when fewer than two fingers are
   * down. Held rather than recomputed from scratch because a pinch is a
   * *change* — the camera follows the difference between two frames of it. */
  const pinch = useRef<Pinch | null>(null);

  /** The armed long press: the timer, the cell it would select, and where the
   * finger landed, so a wander of more than `TOUCH_SLOP` can disarm it. */
  const press = useRef<{ timer: number; cell: Cell; at: { x: number; y: number } } | null>(null);

  const clearPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  /* A component that unmounts mid-press must not leave a timer holding a
   * setState. */
  useEffect(() => clearPress, [clearPress]);

  const fingers = () => [...pointers.current.values()];
  const spanOf = (a: { x: number; y: number }, b: { x: number; y: number }): Pinch => ({
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  });

  /** Everything a gesture leaves behind, dropped at once. */
  const endGesture = () => {
    clearPress();
    pinch.current = null;
    grabbed.current = null;
    down.current = null;
    setPanning(false);
  };

  /**
   * One cell, clicked or tapped: somebody's card if it is held, a purchase of
   * it if it is not.
   *
   * Shared by the mouse and the finger deliberately. A tap and a click mean the
   * same thing to the person doing them, and the two paths through this file
   * had already started to disagree about what that thing was.
   */
  const pick = (cell: Cell) => {
    const info = infoAt(cell);
    if (info) {
      setFocus({ cell, ...info });
      return;
    }
    const rect = { x: cell.x, y: cell.y, w: 1, h: 1 };
    onSelect(rect, quote(rect, heldBy(source.current.wall().chunks)).totalCents);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    (event.target as Element).setPointerCapture(event.pointerId);
    const at = pointAt(event);
    pointers.current.set(event.pointerId, at);

    if (event.pointerType === "touch") {
      // A second finger is a pinch, whatever the first one had begun. Panning
      // and any half-drawn rectangle are abandoned rather than continued
      // alongside it: two fingers on a map mean one thing.
      if (pointers.current.size === 2) {
        clearPress();
        grabbed.current = null;
        setDrag(null);
        setHover(null);
        const [a, b] = fingers();
        pinch.current = spanOf(a!, b!);
        setPanning(true);
        return;
      }
      if (pointers.current.size > 2) return;

      // One finger pans from the first pixel — see `LONG_PRESS_MS`. The press
      // is armed underneath it and takes the gesture over if the finger stays
      // still long enough.
      grabbed.current = screenToCell(camera, view, at.x, at.y);
      setPanning(true);

      const cell = cellUnder(camera, view, at.x, at.y);
      if (grabbing || !inBounds(cell.x, cell.y)) return;
      press.current = {
        cell,
        at,
        timer: window.setTimeout(() => {
          press.current = null;
          // The handover: the finger stops dragging the wall and starts drawing
          // on it, anchored where it has been resting rather than where it
          // first landed.
          grabbed.current = null;
          setPanning(false);
          setDrag({ from: cell, to: cell });
          setHover(cell);
          // The only signal that the mode changed, on a device with no cursor
          // to change shape. Ignored by everything that does not have a motor.
          navigator.vibrate?.(10);
        }, LONG_PRESS_MS),
      };
      return;
    }

    // Anything but the primary button pans, as does the hand tool, as does
    // shift: the primary button draws a rectangle, because selecting is what
    // this wall is for and panning is how you get somewhere to select.
    if (event.button !== 0 || grabbing || event.shiftKey) {
      grabbed.current = screenToCell(camera, view, at.x, at.y);
      setPanning(true);
      return;
    }
    const cell = cellAtEvent(event);
    if (!inBounds(cell.x, cell.y)) return;
    setDrag({ from: cell, to: cell });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const at = pointAt(event);
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, at);

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = fingers();
      const span = spanOf(a!, b!);
      const last = pinch.current;
      pinch.current = span;
      setCamera(current => pinchTo(current, viewRef.current, last, span));
      return;
    }

    // A finger that has left the spot it landed on is not resting on it.
    if (press.current && Math.hypot(at.x - press.current.at.x, at.y - press.current.at.y) > TOUCH_SLOP) {
      clearPress();
    }

    if (grabbed.current) {
      // The camera that puts the grabbed point back under the cursor. Exact,
      // and exactness is the whole feel of a pan: the wall is being dragged by
      // the spot you took hold of, not scrolled by a gesture that resembles it.
      const hold = grabbed.current;
      setCamera(current => framing(view, hold, at, current.zoom));
      return;
    }

    const cell = cellUnder(camera, view, at.x, at.y);
    const inside = inBounds(cell.x, cell.y);
    // A finger has no hover: it is either drawing a rectangle, in which case
    // the plate should follow it, or it is not on the wall at all. Setting
    // hover from a touch move otherwise leaves a tile lit after the hand has
    // gone.
    if (event.pointerType !== "touch" || drag) setHover(inside ? cell : null);
    if (drag) setDrag({ ...drag, to: cell });
  };

  /* Whether this gesture has travelled far enough to be a drag. Tracked on the
   * pointer's own pixels rather than on which cell it ended in, so a click on a
   * held cell is a click at every zoom. */
  const down = useRef<{ x: number; y: number } | null>(null);

  const onPointerUp = (event: React.PointerEvent) => {
    const at = pointAt(event);
    const wasPinching = pinch.current !== null;
    pointers.current.delete(event.pointerId);
    const held = press.current;
    clearPress();

    // Still two fingers down: a third leaving changes nothing.
    if (pointers.current.size >= 2) return;

    if (wasPinching) {
      pinch.current = null;
      const [rest] = fingers();
      // The finger left on the glass takes the pan over, anchored where it is
      // *now*. Keeping the anchor from before the pinch would snap the wall by
      // however far the hand travelled during it.
      if (rest) {
        grabbed.current = screenToCell(cameraRef.current, viewRef.current, rest.x, rest.y);
        return;
      }
      setPanning(false);
      return;
    }

    grabbed.current = null;
    setPanning(false);

    if (event.pointerType === "touch") {
      if (drag) {
        // A rectangle drawn after a long press is always a rectangle, even a
        // one-cell one held still: the hold was the asking.
        const rect = rectFromDrag(drag.from, drag.to);
        setDrag(null);
        setHover(null);
        down.current = null;
        onSelect(rect, quote(rect, heldBy(source.current.wall().chunks)).totalCents);
        return;
      }
      // A tap: the press never landed and the finger barely moved.
      down.current = null;
      setHover(null);
      if (held && Math.hypot(at.x - held.at.x, at.y - held.at.y) <= TOUCH_SLOP) pick(held.cell);
      return;
    }

    if (!drag) return;
    const rect = rectFromDrag(drag.from, drag.to);
    const start = down.current;
    const travelled = start ? Math.hypot(event.clientX - start.x, event.clientY - start.y) : 0;
    down.current = null;
    setDrag(null);

    // A click on a held cell asks about that cell rather than buying it: the
    // wall is full of other people's websites and there was no way to reach
    // one. The card it opens offers both — visit, or take it.
    if (travelled <= CLICK_SLOP && rect.w === 1 && rect.h === 1) {
      pick(drag.from);
      return;
    }

    onSelect(rect, quote(rect, heldBy(source.current.wall().chunks)).totalCents);
  };

  /* The browser taking the gesture back — a system edge swipe, a call arriving.
   * Nothing is committed: whatever was being drawn is dropped rather than
   * finished at wherever the pointer was when it vanished. */
  const onPointerCancel = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      endGesture();
      setDrag(null);
      setHover(null);
    }
  };

  /* What the pointer is over, priced. The figure that follows the cursor is
   * computed from the chunks the client already holds rather than fetched:
   * a quote per pointer move would be a request per pointer move. */
  const under = hover ? infoAt(hover) : null;

  const live = selection
    ? quote(selection, heldBy(source.current.wall().chunks))
    : null;

  /* The card points at the middle of its tile, so the half-cell: a cell's
   * coordinate is its top-left corner, which is where the tile starts. */
  const focusAt = focus ? cellToScreen(camera, view, focus.cell.x + 0.5, focus.cell.y + 0.5) : null;

  /* The draft's rectangle in screen pixels, which is where the scrim's hole
   * goes. Recomputed every render because the camera moves under it. */
  const spotlight = (() => {
    if (!draft || !view.width) return null;
    const at = cellToScreen(camera, view, draft.rect.x, draft.rect.y);
    const scale = CELL * camera.zoom;
    return { x: at.x, y: at.y, w: draft.rect.w * scale, h: draft.rect.h * scale };
  })();

  return (
    <div ref={wrap} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvas}
        className="h-full w-full touch-none select-none"
        style={{
          cursor: panning ? "grabbing" : grabbing ? "grab" : under ? "pointer" : "crosshair",
        }}
        onPointerDown={event => {
          stopFlight();
          down.current = { x: event.clientX, y: event.clientY };
          setFocus(null);
          onPointerDown(event);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => setHover(null)}
      />

      {/*
        A scrim between the canvas and whatever is being read over it, with the
        buyer's own rectangle punched out of it.

        Nine tenths rather than opaque: "you found a nice spot" means nothing if
        you cannot see what the spot is next to. And a hole, because the preview
        drawn in that rectangle is the subject of the whole panel — a flat scrim
        would dim the wall and the answer together.

        It was three quarters, and three quarters is what a scrim is worth over
        a *sparse* wall. Over a full one it is not enough: on a desktop the
        panel has no background of its own — `md:bg-transparent` in
        `BuyPanel.tsx`, on the argument that the scrim is already doing the
        separating — so the only thing between a form field and somebody's logo
        is this number. At 70 a wordmark behind the panel was legible through
        it, which made the panel look like a bug.

        The hole is what keeps this from being an argument for opacity: however
        far this goes, the cells being bought stay at full strength.

        The hole is a spread `box-shadow` rather than a second element or a
        clip-path: one box, positioned on the selection, casting the scrim
        outward in every direction. It follows the rectangle across a pan for
        free, and it still transitions its opacity like the flat one did.
      */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute transition-opacity duration-300",
          dim ? "opacity-90" : "opacity-0",
          spotlight ? "rounded-[0.7rem]" : "bg-ground inset-0",
        )}
        style={
          spotlight
            ? {
                left: spotlight.x,
                top: spotlight.y,
                width: spotlight.w,
                height: spotlight.h,
                boxShadow: "0 0 0 9999px var(--color-ground)",
              }
            : undefined
        }
      />

      {/*
        Somebody's website, reachable.

        Anchored to its own cell rather than parked in a corner, because the
        card is about *that* tile and a card in the corner is about the page.
        It travels with the camera for the same reason, and the wall stays
        pannable under it.
      */}
      {focus && focusAt && !dim && (
        <ClaimCard
          focus={focus}
          at={focusAt}
          view={view}
          god={god}
          onFree={
            onFree &&
            (() => {
              const rect = focus.claim.rect;
              setFocus(null);
              onFree(rect);
            })
          }
          onClose={() => setFocus(null)}
          onTake={() => {
            const rect = { x: focus.cell.x, y: focus.cell.y, w: 1, h: 1 };
            setFocus(null);
            onSelect(rect, quote(rect, heldBy(source.current.wall().chunks)).totalCents);
          }}
        />
      )}

      {/*
        The price of whatever the pointer is on, which is the one number that
        has to be answerable without clicking anything.

        Bottom centre, floating, in the same pill as every other chip on the
        page. Keyed by cell so that moving to the next one genuinely remounts it
        and the entry animation fires again — one price announcing itself per
        cell. See `.wall-plate` in `styles.css`.
      */}
      {(live || under) && hover && !dim && !focus && (
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
                · held at {money(under.entry.priceCents)} · click to open
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
        {/* The hand, as a latch for anyone who does not know that space or the
            middle button pans — which is most people. */}
        <ZoomButton
          label={handTool ? "Stop panning" : "Pan the wall"}
          aria-pressed={handTool}
          onClick={() => setHandTool(on => !on)}
          className={cn(handTool && "border-muted text-ink")}
        >
          <Hand />
        </ZoomButton>
      </div>
    </div>
  );
}

/**
 * The card over a held cell: whose it is, where it goes, what it costs to take.
 *
 * The link is the point of it. Every tile on this wall is somebody's website
 * and until now the wall was the only advertisement in the world you could not
 * click. `noopener` because these are arbitrary third-party URLs and the tab
 * they open must not get a handle on this one.
 */
function ClaimCard({
  focus,
  at,
  view,
  onClose,
  onTake,
  god,
  onFree,
}: {
  focus: Focus;
  at: { x: number; y: number };
  view: Viewport;
  onClose: () => void;
  onTake: () => void;
  god?: boolean;
  onFree?: () => void;
}) {
  const width = 268;
  // Above the cell where there is room, below it otherwise, and never hanging
  // off the side of the viewport.
  const left = Math.min(view.width - width - 12, Math.max(12, at.x - width / 2));
  const above = at.y > 190;
  const top = above ? at.y - 22 : at.y + 22;

  let host = focus.claim.url;
  try {
    host = new URL(focus.claim.url).host.replace(/^www\./, "");
  } catch {
    // A URL the Worker accepted and this parser did not: show it raw rather
    // than hiding the one piece of information the card exists to carry.
  }

  return (
    <div
      className="wall-plate border-line/70 bg-ground/90 absolute z-20 rounded-2xl border p-4 backdrop-blur"
      style={{
        left,
        top,
        width,
        transform: above ? "translateY(-100%)" : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-ink truncate text-base">{focus.claim.label || "untitled"}</div>
          <div className="text-muted truncate text-sm">{host}</div>
        </div>
        <button
          aria-label="Close"
          onClick={onClose}
          className="text-muted hover:text-ink -mt-1 text-lg leading-none transition-colors"
        >
          ×
        </button>
      </div>

      {/* `nowrap`, because both labels are two words with a symbol in them and a
          card this narrow will break them across lines given the chance. */}
      <div className="mt-3 flex items-center gap-1.5 whitespace-nowrap">
        <a
          href={focus.claim.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="border-line/70 text-ink hover:border-muted rounded-full border px-3 py-1.5 text-sm transition-colors"
        >
          visit ↗
        </a>
        <button
          onClick={onTake}
          className="border-line/70 text-muted hover:text-ink hover:border-muted rounded-full border px-3 py-1.5 text-sm transition-colors"
        >
          take it · {money(nextPrice(focus.entry.priceCents))}
        </button>
      </div>

      {/*
        The one thing the real wall cannot do.

        On its own row rather than beside the other two: three pills do not fit
        in this card, and crowding a third in wrapped both of the real ones onto
        two lines each. A development-only control must not reshape the card it
        is a guest in — production sees exactly the layout it always did.

        In `warn` and as text rather than a pill, which is the same reasoning
        from the other side: on a wall whose whole promise is that a cell is
        yours until somebody outbids you, a button that simply deletes somebody
        should look like what it is, and should not look like the two ordinary
        things next to it.
      */}
      {god && onFree && (
        <button
          onClick={onFree}
          className="text-warn/80 hover:text-warn mt-2.5 text-sm underline underline-offset-2 transition-colors"
        >
          remove from the wall
        </button>
      )}
    </div>
  );
}

/** The hand tool's mark. Drawn rather than imported: it is the only icon on the
 * page and a font for one glyph is a font too many. */
function Hand() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="mx-auto size-4">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11m0 0V4.5a1.5 1.5 0 0 1 3 0V11m0 0V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3l-1.6-2.8a1.5 1.5 0 0 1 2.5-1.6L8 15V11Z"
      />
    </svg>
  );
}

function ZoomButton({
  label,
  children,
  className,
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
        className,
      )}
    >
      {children}
    </button>
  );
}
