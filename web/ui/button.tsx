import { splitProps, type JSX } from "solid-js";
import "./button.css";

type Props = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class"> & {
  /** Bordered, unless the main action (`primary`), a destructive one (`danger`), or text alone (`link`). */
  variant?: "primary" | "danger" | "link";
  /** While set, the button is disabled and says this instead, like "Sending…". */
  busy?: string | false;
};

export function Button(props: Props) {
  const [own, rest] = splitProps(props, ["variant", "busy", "disabled", "children"]);
  return (
    <button
      {...rest}
      class={own.variant === "link" ? "link" : own.variant ? `button ${own.variant}` : "button"}
      disabled={own.disabled || Boolean(own.busy)}
    >
      {own.busy || own.children}
    </button>
  );
}
