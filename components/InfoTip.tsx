"use client";

// Small ⓘ affordance for summary cards: click to open a plain-language
// explanation of what the card measures; click anywhere to dismiss.

import { useState } from "react";

export default function InfoTip({ title, text }: { title?: string; text: string }) {
  const [open, setOpen] = useState(false);

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
            className="absolute z-50 top-5 left-1/2 -translate-x-1/2 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-lg text-left"
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
