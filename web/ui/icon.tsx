import { splitProps, type JSX } from "solid-js";
import { classes } from "#/web/lib/classes.ts";
import { aria } from "#/web/lib/keyboard.ts";
import { tooltip } from "#/web/ui/tooltip.ts";
import "#/web/ui/icon.css";

const Icons = {
  plus: () => <path d="M10 4.5v11M4.5 10h11" />,
  list: () => <path d="M4.5 6h11M4.5 10h11M4.5 14h7" />,
  back: () => <path d="M12 5 7 10l5 5" />,
  close: () => <path d="m6 6 8 8M14 6l-8 8" />,
  more: () => (
    <>
      <circle cx="5" cy="10" r="1.25" />
      <circle cx="10" cy="10" r="1.25" />
      <circle cx="15" cy="10" r="1.25" />
    </>
  ),
};

type Props = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  icon: keyof typeof Icons;
  /** Its shortcut, named in a tooltip along with the label. */
  keys?: string;
};

export function IconButton(props: Props) {
  const [own, rest] = splitProps(props, ["label", "icon", "keys", "class"]);
  return (
    <button
      {...rest}
      ref={(button) => own.keys && tooltip(button, own.label, own.keys)}
      class={classes("quiet icon", own.class)}
      aria-label={own.label}
      aria-keyshortcuts={own.keys && aria(own.keys)}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {Icons[own.icon]()}
      </svg>
    </button>
  );
}
