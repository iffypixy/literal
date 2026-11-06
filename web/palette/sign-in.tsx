import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { CodeDigits } from "#/protocol.ts";
import { sendCode, verify, WrongCode } from "#/web/account.ts";
import { hasKeyboard, reducedMotion, storageAtRisk } from "#/web/lib/device.ts";
import { pressed } from "#/web/lib/keyboard.ts";
import { Legal } from "#/web/palette/about.tsx";
import { View } from "#/web/palette/view.tsx";
import { Alert } from "#/web/ui/alert.tsx";
import { Button } from "#/web/ui/button.tsx";
import "#/web/palette/sign-in.css";

type Props = {
  onBack: () => void;
  onDone: (email: string) => void;
};

const ResendAfterSeconds = 30;

export function SignIn(props: Props) {
  // The step's one field: the email, then the code.
  let field!: HTMLInputElement;

  const [step, setStep] = createSignal<"email" | "code">("email");
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [waitSeconds, setWaitSeconds] = createSignal(0);
  const address = () => email().trim();

  onMount(() => {
    if (hasKeyboard()) field.focus();
  });

  createEffect(() => {
    const left = waitSeconds();
    if (!left) return;
    const tick = setTimeout(() => setWaitSeconds(left - 1), 1000);
    onCleanup(() => clearTimeout(tick));
  });

  async function send(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    const asked = step();
    const outcome = await sendCode(address());
    setBusy(false);
    // Gone back to the email meanwhile, so the answer is about a code no longer asked for.
    if (step() !== asked) return;
    if (!outcome.ok) return setError(outcome.reason);

    setStep("code");
    setCode("");
    setWaitSeconds(ResendAfterSeconds);
    field.focus();
  }

  async function check() {
    if (busy() || code().length !== CodeDigits) return;
    setBusy(true);
    setError(null);
    const outcome = await verify(address(), code());
    setBusy(false);
    if (outcome.ok) return props.onDone(address());
    // Gone back to the email meanwhile, so the answer is about a code no longer asked for.
    if (step() !== "code") return;

    setError(outcome.reason);
    setCode("");
    field.focus();
    // A wrong code shakes, as a wrong passcode does.
    if (outcome.reason === WrongCode) shake();
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

  function handleCodeInput(input: HTMLInputElement) {
    const digits = input.value.replace(/\D/g, "").slice(0, CodeDigits);
    // Anything but a digit leaves code() as it was, so Solid wouldn't take it back out of the field.
    input.value = digits;
    setCode(digits);
    setError(null);
    if (digits.length === CodeDigits) void check();
  }

  function restart() {
    setStep("email");
    setError(null);
    setWaitSeconds(0);
    field.focus();
  }

  // Esc on the code step goes back to the email. On the email step it's the palette's.
  function handleKeyDown(event: KeyboardEvent) {
    if (step() !== "code" || !pressed(event, "Escape")) return;
    event.preventDefault();
    restart();
  }

  return (
    <View
      title={step() === "email" ? "Sync across devices" : "Check your email"}
      onBack={() => (step() === "code" ? restart() : props.onBack())}
      class="sign-in"
      onKeyDown={handleKeyDown}
    >
      <Switch>
        <Match when={step() === "email"}>
          <p>
            Sign in to keep your notes on all your devices.
            {storageAtRisk && " Safari can clear notes from sites you haven't opened in 7 days. Syncing keeps them."}
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
            <Button variant="primary" busy={busy() ? "Sending…" : undefined} disabled={!address()}>
              Send code
            </Button>
          </form>
          <Alert message={error()} />
          <p class="section">No password. We'll email you a {CodeDigits}-digit code.</p>
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
            aria-invalid={Boolean(error())}
            value={code()}
            onInput={(event) => handleCodeInput(event.currentTarget)}
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength={CodeDigits}
            placeholder={"0".repeat(CodeDigits)}
            readOnly={busy()}
          />
          <Alert message={error()} />
          <p class="links section">
            <Show
              when={waitSeconds()}
              fallback={
                <Button variant="link" onClick={() => void send()}>
                  Resend code
                </Button>
              }
            >
              <span>Resend code in {waitSeconds()}s</span>
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
