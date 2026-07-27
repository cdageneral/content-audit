"use client";

// Small ⓘ affordance for summary cards: click to open a plain-language
// explanation of what the card measures; click anywhere (or press Escape)
// to dismiss.
//
// 🔑 Dismissal is done with DOCUMENT-LEVEL listeners, never a `fixed inset-0`
// click-away overlay. The cards carry `.anim-fade-up`, whose keyframes end at
// `transform: translateY(0)` with fill-mode `both` — so the card keeps a
// permanent transform, and a transformed ancestor makes `position: fixed`
// resolve against THAT ancestor instead of the viewport. An overlay therefore
// only covered the card, and clicking anywhere else never closed the popover.
// (Same trap as the Edit-URLs modal.) Document listeners also let a click on
// a second ⓘ open it directly, instead of being swallowed by the first tip's
// overlay.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Layout effect on the client, plain effect on the server — a bare
// useLayoutEffect warns during Next's server prerender of client components.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const VIEWPORT_MARGIN = 8;

export default function InfoTip({ title, text }: { title?: string; text: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  // Horizontal nudge applied on top of the -50% centering so the popover can
  // never hang off the viewport. Without it a tip on a right-edge card adds
  // real horizontal page scroll (measured: +34px at 1024px, +67px at 390px).
  const [shift, setShift] = useState(0);

  useIsoLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const el = tipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let d = 0;
    if (r.right > vw - VIEWPORT_MARGIN) d = vw - VIEWPORT_MARGIN - r.right;
    if (r.left + d < VIEWPORT_MARGIN) d = VIEWPORT_MARGIN - r.left;
    // Deps are [open] only, so this settles in one pass — no measure loop.
    if (d !== 0) setShift(d);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: Event) {
      const root = rootRef.current;
      // A click inside this tip (its own icon or the popover) is not a dismiss.
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // pointerdown, not click: closes on press even if the press lands on
    // something that stops click propagation.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`What is ${title ?? "this"}?`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
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
      {open && (
        <span
          ref={tipRef}
          className="absolute z-50 top-5 left-1/2 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-lg text-left"
          style={{
            transform: `translateX(calc(-50% + ${shift}px))`,
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
        </span>
      )}
    </span>
  );
}
