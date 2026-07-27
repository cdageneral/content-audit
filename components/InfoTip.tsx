"use client";

// Small ⓘ affordance for summary cards: click to open a plain-language
// explanation of what the card measures; click anywhere to dismiss.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Layout effect on the client, plain effect on the server — a bare
// useLayoutEffect warns during Next's server prerender of client components.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const VIEWPORT_MARGIN = 8;

export default function InfoTip({ title, text }: { title?: string; text: string }) {
  const [open, setOpen] = useState(false);
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

  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`What is ${title ?? "this"}?`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`w-[15px] h-[15px] rounded-full border inline-flex items-center justify-center leading-none select-none transition-colors ${
          open
            ? "border-indigo-400 text-indigo-500 bg-indigo-50"
            : "border-slate-300 text-slate-400 hover:border-indigo-400 hover:text-indigo-500"
        }`}
        style={{ fontSize: 9, fontStyle: "italic", fontFamily: "Georgia, serif" }}
      >
        i
      </button>
      {open && (
        <>
          {/* click-away layer */}
          <span
            className="fixed inset-0 z-40 cursor-default"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
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
        </>
      )}
    </span>
  );
}
