import { IconButton } from "../ui/icon.tsx";
import "./back.css";

export function Back(props: { onClick: () => void }) {
  return <IconButton class="back" label="Back" icon="back" onClick={() => props.onClick()} />;
}
