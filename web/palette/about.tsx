import { View } from "#/web/palette/view.tsx";

export function About(props: { onBack: () => void }) {
  return (
    <View title="Literal" onBack={props.onBack}>
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
    </View>
  );
}

/** The terms and the privacy policy, each opening in a tab of its own. */
export function Legal() {
  return (
    <>
      <a href="/terms" target="_blank">
        Terms
      </a>{" "}
      ·{" "}
      <a href="/privacy" target="_blank">
        Privacy
      </a>
    </>
  );
}
