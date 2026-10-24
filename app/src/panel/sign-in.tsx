import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { sendCode, unreachable, verify } from "../sync/account.ts";
import { Back } from "./back.tsx";
import "./sign-in.css";

const ResendAfter = 30;
const touch = matchMedia("(pointer: coarse)").matches;

type Props = {
  /** Safari, not on the Home Screen: it may clear notes after a week away, which syncing guards against. */
  fragile: boolean;
  onBack: () => void;
  onDone: (email: string) => void;
};

export function SignIn(props: Props) {
  let field: HTMLInputElement | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const [step, setStep] = createSignal<"email" | "code">("email");
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [wait, setWait] = createSignal(0);

  onMount(() => {
    if (!touch) field?.focus();
  });
  onCleanup(() => clearInterval(timer));

  async function send(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    const problem = await sendCode(email().trim()).catch(unreachable);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    setStep("code");
    setCode("");
    setWait(ResendAfter);
    clearInterval(timer);
    timer = setInterval(() => setWait((left) => Math.max(0, left - 1)), 1000);
    field?.focus();
  }

  async function check() {
    if (busy() || code().length !== 6) return;
    setBusy(true);
    setError("");
    let reached = true;
    const problem = await verify(email().trim(), code()).catch(() => {
      reached = false;
      return unreachable();
    });
    setBusy(false);
    if (!problem) return props.onDone(email().trim());
    setError(problem);
    setCode("");
    field?.focus();
    // A wrong code shakes, as a wrong passcode does; a lost connection isn't wrong.
    if (reached) shake();
  }

  function shake() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    field?.animate(
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
    // Only digits stay: anything else typed comes straight back out.
    const digits = input.value.replace(/\D/g, "").slice(0, 6);
    input.value = digits;
    setCode(digits);
    setError("");
    if (digits.length === 6) void check();
  }

  function restart() {
    setStep("email");
    setError("");
    clearInterval(timer);
    field?.focus();
  }

  // Esc on the code step goes back to the email; on the email step it's the panel's, which goes back to the list.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || step() !== "code") return;
    event.preventDefault();
    restart();
  }

  return (
    <div class="sign-in" onKeyDown={onKeyDown}>
      <Back onClick={() => (step() === "code" ? restart() : props.onBack())} />

      <Switch>
        <Match when={step() === "email"}>
          <h2 id="view-title">Sync across devices</h2>
          <p class="lead">
            Sign in to keep your notes on all your devices.
            {props.fragile && " Safari can clear notes from sites you haven't opened in 7 days. Syncing keeps them."}
          </p>

          <form onSubmit={send}>
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
            <button class="primary" disabled={busy() || !email().trim()}>
              {busy() ? "Sending…" : "Send code"}
            </button>
          </form>
          <Show when={error()}>
            <p class="error" role="alert">
              {error()}
            </p>
          </Show>
          <p class="note">No password. We'll email you a 6-digit code.</p>
          <p class="note fine">
            <a href="/terms" target="_blank">
              Terms
            </a>{" "}
            ·{" "}
            <a href="/privacy" target="_blank">
              Privacy
            </a>
          </p>
        </Match>

        <Match when={step() === "code"}>
          <h2 id="view-title">Check your email</h2>
          <p class="lead">
            Enter the code we sent to <strong>{email().trim()}</strong>.
          </p>
          <label class="visually-hidden" for="sign-in-code">
            Code
          </label>
          <input
            ref={field}
            id="sign-in-code"
            class="code"
            classList={{ wrong: Boolean(error()) }}
            value={code()}
            onInput={(event) => onCode(event.currentTarget)}
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            readOnly={busy()}
          />
          <Show when={error()}>
            <p class="error" role="alert">
              {error()}
            </p>
          </Show>
          <p class="links">
            <Show
              when={wait()}
              fallback={
                <button class="link" onClick={() => send()}>
                  Resend code
                </button>
              }
            >
              <span>Resend code in {wait()}s</span>
            </Show>
            <span>·</span>
            <button class="link" onClick={restart}>
              Use another email
            </button>
          </p>
        </Match>
      </Switch>
    </div>
  );
}
