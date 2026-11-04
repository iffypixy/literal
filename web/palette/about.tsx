import { Back } from "./back.tsx";
import { Legal } from "./legal.tsx";

export function About(props: { onBack: () => void }) {
  return (
    <div class="view">
      <Back onClick={props.onBack} />
      <h2 id="view-title" tabindex="-1">
        Literal
      </h2>
      <p>Instant notes, on all your devices.</p>
      <p class="section">
        Made by Ansat
        <br />
        Write to <a href="mailto:hello@literal.ink">hello@literal.ink</a>
      </p>
      <p class="section">
        <Legal /> ·{" "}
        <a href="https://github.com/iffypixy/literal" target="_blank">
          Source
        </a>
      </p>
    </div>
  );
}
