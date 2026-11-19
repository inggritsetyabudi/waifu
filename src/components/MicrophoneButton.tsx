interface Props {
  active: boolean;
  pending?: boolean;
  onClick: () => void;
}

export function MicrophoneButton({ active, pending = false, onClick }: Props) {
  const label = active ? "Batalkan mikrofon" : "Mulai mikrofon";
  return (
    <button type="button" className={`microphone-button${active ? " is-active" : ""}`}
      aria-label={label} title={label} aria-pressed={active} aria-busy={pending}
      disabled={pending} onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onClick(); }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        {active && <path d="M3 3l18 18" />}
      </svg>
    </button>
  );
}
