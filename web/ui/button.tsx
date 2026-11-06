import { splitProps, type JSX } from "solid-js";
import { classes } from "#/web/lib/classes.ts";
import "#/web/ui/button.css";

/** Bordered, unless the main action, a destructive one, or text alone. */
export type ButtonVariant = "plain" | "primary" | "danger" | "link";

type Props = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** While set, the button is disabled and says this instead, like "Sending…". */
  busy?: string;
};

const Variant = {
  plain: "button",
  primary: "button primary",
  danger: "button danger",
  link: "link",
} satisfies Record<ButtonVariant, string>;

export function Button(props: Props) {
  const [own, rest] = splitProps(props, ["variant", "busy", "disabled", "class", "children"]);
  return (
    <button
      {...rest}
      class={classes(Variant[own.variant ?? "plain"], own.class)}
      disabled={own.disabled || own.busy !== undefined}
    >
      {own.busy ?? own.children}
    </button>
  );
}
