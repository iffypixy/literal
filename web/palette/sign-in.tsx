import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { CodeLength } from "#protocol.ts";
import { Fragile, hasKeyboard, reducedMotion } from "#web/device.ts";
import { pressed } from "#web/shortcuts.ts";
import { sendCode, verify, WrongCode } from "#web/sync/account.ts";
import { Button } from "#web/ui/button.tsx";
import { Legal } from "./about.tsx";
import { Alert, View } from "./view.tsx";
import "./sign-in.css";

/** Seconds before a code can be sent again. */
const ResendAfter = 30;

type Props = {
  onBack: () => void;
  onDone: (email: string) => void;
};

export function SignIn(props: Props) {
  /** The step's one field: the email, then the code. */
  let field!: HTMLInputElement;

  const [step, setStep] = createSignal<"email" | "code">("email");
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [wait, setWait] = createSignal(0);
  const address = () => email().trim();

  onMount(() => {
    if (hasKeyboard()) field.focus();
  });

  createEffect(() => {
    const left = wait();
    if (!left) return;
    const tick = setTimeout(() => setWait(left - 1), 1000);
    onCleanup(() => clearTimeout(tick));
  });

  async function send(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    const problem = await sendCode(address());
    setBusy(false);
    if (problem) return setError(problem);
    setStep("code");
    setCode("");
    setWait(ResendAfter);
    field.focus();
  }

  async function check() {
    if (busy() || code().length !== CodeLength) return;
    setBusy(true);
    setError("");
    const problem = await verify(address(), code());
    setBusy(false);
    if (!problem) return props.onDone(address());
    // Gone back to the email meanwhile, so the answer is about a code no longer asked for.
    if (step() !== "code") return;
    setError(problem);
    setCode("");
    field.focus();
    // A wrong code shakes, as a wrong passcode does.
    if (problem === WrongCode) shake();
  }

  function shake() {
    if (reducedMotion.matches) return;
    field.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-6px)" },
        { transform: "translateX(5px)" },
        { transform: "translateX(-3px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 320, easing: "ease-out" },
    );
  }

  function onCode(input: HTMLInputElement) {
    const digits = input.value.replace(/\D/g, "").slice(0, CodeLength);
    // Anything but a digit leaves code() as it was, so Solid wouldn't take it back out of the field.
    input.value = digits;
    setCode(digits);
    setError("");
    if (digits.length === CodeLength) void check();
  }

  function restart() {
    setStep("email");
    setError("");
    setWait(0);
    field.focus();
  }

  // Esc on the code step goes back to the email. On the email step it's the palette's.
  function onKeyDown(event: KeyboardEvent) {
    if (step() !== "code" || !pressed(event, "Escape")) return;
    event.preventDefault();
    restart();
  }

  return (
    <View
      title={step() === "email" ? "Sync across devices" : "Check your email"}
      onBack={() => (step() === "code" ? restart() : props.onBack())}
      class="sign-in"
      onKeyDown={onKeyDown}
    >
      <Switch>
        <Match when={step() === "email"}>
          <p>
            Sign in to keep your notes on all your devices.
            {Fragile && " Safari can clear notes from sites you haven't opened in 7 days. Syncing keeps them."}
          </p>

          <form class="section" onSubmit={send}>
            <label class="visually-hidden" for="sign-in-email">
              Email
            </label>
            <input
              ref={field}
              id="sign-in-email"
              type="email"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
              placeholder="you@email.com"
              autocomplete="email"
              autocapitalize="none"
              spellcheck="false"
              enterkeyhint="send"
              required
            />
            <Button variant="primary" busy={busy() && "Sending…"} disabled={!address()}>
              Send code
            </Button>
          </form>
          <Alert message={error()} />
          <p class="section">No password. We'll email you a {CodeLength}-digit code.</p>
          <p class="fine">
            <Legal />
          </p>
        </Match>

        <Match when={step() === "code"}>
          <p>
            Enter the code we sent to <strong>{address()}</strong>.
          </p>
          <label class="visually-hidden" for="sign-in-code">
            Code
          </label>
          <input
            ref={field}
            id="sign-in-code"
            class="code section"
            classList={{ wrong: Boolean(error()) }}
            value={code()}
            onInput={(event) => onCode(event.currentTarget)}
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength={CodeLength}
            placeholder={"0".repeat(CodeLength)}
            readOnly={busy()}
          />
          <Alert message={error()} />
          <p class="links section">
            <Show
              when={wait()}
              fallback={
                <Button variant="link" onClick={() => void send()}>
                  Resend code
                </Button>
              }
            >
              <span>Resend code in {wait()}s</span>
            </Show>
            <span>·</span>
            <Button variant="link" onClick={restart}>
              Use another email
            </Button>
          </p>
        </Match>
      </Switch>
    </View>
  );
}
