/**
 * Three soft dots, staggered. Used while the assistant is mid-stream and we
 * haven't yet emitted a text chunk for the current turn.
 */
export function TypingIndicator() {
  return (
    <div
      role="status"
      aria-label="Thinking"
      className="inline-flex items-center gap-1 px-1 py-1.5"
    >
      <span className="h-1.5 w-1.5 animate-[chatdot_1.2s_ease-in-out_infinite] rounded-full bg-foreground/55 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-[chatdot_1.2s_ease-in-out_infinite] rounded-full bg-foreground/55 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-[chatdot_1.2s_ease-in-out_infinite] rounded-full bg-foreground/55" />
      <style>{`
        @keyframes chatdot {
          0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
          40% { opacity: 1; transform: translateY(-2px); }
        }
      `}</style>
    </div>
  )
}
