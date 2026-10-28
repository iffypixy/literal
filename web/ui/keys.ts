import "./keys.css";

/** A shortcut as key caps, like `Ctrl` `K`. Plain DOM, so the tooltip can draw it outside any component. */
export function Keys(props: { keys: string[] }): HTMLElement {
  const span = document.createElement("span");
  span.className = "keys";
  span.append(...props.keys.map((key) => Object.assign(document.createElement("kbd"), { textContent: key })));
  return span;
}
