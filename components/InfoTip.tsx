"use client";

// Small ⓘ affordance for summary cards and table labels: click to open a
// plain-language explanation of what the thing measures; click anywhere (or
// press Escape) to dismiss.
//
// ── Two hard-won rules live in this file ──────────────────────────────────
//
// 🔑 1. Dismissal uses DOCUMENT-LEVEL listeners, never a `fixed inset-0`
//    click-away overlay. The cards carry `.anim-fade-up`, whose keyframes end
//    at `transform: translateY(0)` with fill-mode `both` — so every card keeps
//    a permanent transform, and a transformed ancestor makes `position: fixed`
//    resolve against THAT ancestor instead of the viewport. An overlay
//    therefore only covered the card, and clicking anywhere else never closed
//    the popover. (Same trap as the Edit-URLs modal.) Document listeners also
//    let a click on a second ⓘ open it directly, instead of being swallowed by
//    the first tip's overlay.
//
// 🔑 2. The popover is PORTALED TO document.body and positioned from the
//    icon's measured rect. It used to be an absolutely-positioned sibling,
//    which was fine on open cards but got clipped the moment a tip lived
//    inside an `overflow-hidden` card or an `overflow-x-auto` scroller (the
//    competitor matrix is both), and painted underneath any later
//    `.anim-fade-up` section because each one is its own stacking context.
//    document.body has no transform, so `position: fixed` here means the
//    viewport, as intended — and nothing can clip or out-stack it.
//    Because it's fixed, an open tip is closed on scroll/resize rather than
//    left floating away from its icon.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Layout effect on the client, plain effect on the server — a bare
// useLayoutEffect warns during Next's server prerender of client components.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const VIEWPORT_MARGIN = 8;
const TIP_WIDTH = 256; // w-64
const GAP = 6;

export default function InfoTip({ title, text }: { title?: string; text: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function place() {
    const icon = rootRef.current?.getBoundingClientRect();
    if (!icon) return;
    const vw = document.documentElement.clientWidth;
    const width = Math.min(TIP_WIDTH, vw - VIEWPORT_MARGIN * 2);
    // First pass: below the icon, horizontally centred, clamped to the viewport.
    let left = icon.left + icon.width / 2 - width / 2;
    left = Math.min(left, vw - VIEWPORT_MARGIN - width);
    left = Math.max(left, VIEWPORT_MARGIN);
    setPos({ top: icon.bottom + GAP, left });
  }

  // Second pass: now that the popover has a real height, flip it above the
  // icon if it would run off the bottom. Deps are [open] only so this settles
  // in one pass — adding `pos` here would loop.
  useIsoLayoutEffect(() => {
    if (!open) return;
    const el = tipRef.current;
    const icon = rootRef.current?.getBoundingClientRect();
    if (!el || !icon) return;
    const r = el.getBoundingClientRect();
    const vh = document.documentElement.clientHeight;
    if (r.bottom > vh - VIEWPORT_MARGIN) {
      const above = icon.top - GAP - r.height;
      setPos((p) => (p ? { ...p, top: Math.max(VIEWPORT_MARGIN, above) } : p));
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: Event) {
      const root = rootRef.current;
      const tip = tipRef.current;
      // A click on this tip's own icon or inside its popover is not a dismiss.
      if (e.target instanceof Node && (root?.contains(e.target) || tip?.contains(e.target))) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // The popover is fixed-positioned, so any scroll would slide it away from
    // its icon — close instead of chasing.
    function onDetach() {
      setOpen(false);
    }
    // pointerdown, not click: closes on press even if the press lands on
    // something that stops click propagation.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onDetach, true);
    window.addEventListener("resize", onDetach);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onDetach, true);
      window.removeEventListener("resize", onDetach);
    };
  }, [open]);

  const popover =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <span
            ref={tipRef}
            data-infotip="open"
            className="fixed z-[9999] w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-lg text-left block"
            style={{
              top: pos.top,
              left: pos.left,
              maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <span className="block text-[11px] font-bold text-slate-800 mb-1 normal-case tracking-normal">
                {title}
              </span>
            )}
            <span className="block text-[11px] text-slate-600 font-normal normal-case tracking-normal leading-relaxed">
              {text}
            </span>
          </span>,
          document.body
        )
      : null;

  return (
    <span ref={rootRef} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`What is ${title ?? "this"}?`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            setOpen(false);
          } else {
            place();
            setOpen(true);
          }
        }}
        className={`w-4 h-4 rounded-full border inline-flex items-center justify-center leading-none select-none transition-colors ${
          open
            ? "border-indigo-600 bg-indigo-600 text-white"
            : "border-indigo-300 bg-indigo-50 text-indigo-600 hover:border-indigo-500 hover:bg-indigo-100"
        }`}
        style={{
          fontSize: 10,
          fontStyle: "italic",
          fontWeight: 700,
          fontFamily: "Georgia, serif",
        }}
      >
        i
      </button>
      {popover}
    </span>
  );
}
