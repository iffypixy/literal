import "./back.css";

export function Back(props: { onClick: () => void }) {
  return (
    <button class="back" aria-label="Back" onClick={() => props.onClick()}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M12 5 7 10l5 5" />
      </svg>
    </button>
  );
}
