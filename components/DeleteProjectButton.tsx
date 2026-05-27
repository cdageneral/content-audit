"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteProjectButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setConfirming(true);
  }

  async function handleConfirm(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDeleting(true);
    try {
      await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  function handleCancel(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setConfirming(false);
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        <button
          onClick={handleCancel}
          className="text-xs px-2 py-1 rounded-md"
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "var(--text-3)",
            cursor: "pointer",
          }}>
          No
        </button>
        <button
          onClick={handleConfirm}
          disabled={deleting}
          className="text-xs px-2 py-1 rounded-md"
          style={{
            background: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.3)",
            color: "#f87171",
            cursor: deleting ? "not-allowed" : "pointer",
          }}>
          {deleting ? "…" : "Delete"}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      title="Delete project"
      className="flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
      style={{
        width: 28, height: 28,
        background: "transparent",
        border: "1px solid transparent",
        color: "var(--text-3)",
        cursor: "pointer",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.12)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(239,68,68,0.25)";
        (e.currentTarget as HTMLButtonElement).style.color = "#f87171";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent";
        (e.currentTarget as HTMLButtonElement).style.color = "var(--text-3)";
      }}>
      {/* Trash icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
        <path d="M10 11v6M14 11v6"/>
        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
      </svg>
    </button>
  );
}
