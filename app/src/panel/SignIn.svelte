<script lang="ts">
  import { onMount, tick } from "svelte";
  import { providers, sendCode, signInWith, verify, type Providers } from "../sync/account.svelte.ts";

  type Props = {
    onback: () => void;
    ondone: (email: string) => void;
  };

  let { onback, ondone }: Props = $props();

  const RESEND_AFTER = 30;
  const OFFLINE = "You're offline. Connect and try again.";
  const touch = matchMedia("(pointer: coarse)").matches;

  let step = $state<"email" | "code">("email");
  let email = $state("");
  let code = $state("");
  let busy = $state(false);
  let error = $state("");
  let offered = $state<Providers>({ google: false, apple: false });
  let wait = $state(0);
  let field = $state<HTMLInputElement>();
  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    void providers().then((result) => (offered = result));
    if (!touch) field?.focus();
    return () => clearInterval(timer);
  });

  async function send(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    const problem = await sendCode(email.trim()).catch(() => OFFLINE);
    busy = false;
    if (problem) {
      error = problem;
      return;
    }
    step = "code";
    code = "";
    wait = RESEND_AFTER;
    clearInterval(timer);
    timer = setInterval(() => (wait = Math.max(0, wait - 1)), 1000);
    await tick();
    field?.focus();
  }

  async function check() {
    if (busy || code.length !== 6) return;
    busy = true;
    error = "";
    const problem = await verify(email.trim(), code).catch(() => OFFLINE);
    busy = false;
    if (!problem) {
      ondone(email.trim());
      return;
    }
    error = problem;
    code = "";
    field?.focus();
    // A wrong code shakes, as a wrong passcode does; being offline isn't wrong.
    if (problem !== OFFLINE) shake();
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

  function oncode() {
    code = code.replace(/\D/g, "").slice(0, 6);
    error = "";
    if (code.length === 6) void check();
  }

  async function restart() {
    step = "email";
    error = "";
    clearInterval(timer);
    await tick();
    field?.focus();
  }

  async function social(provider: "google" | "apple") {
    busy = true;
    await signInWith(provider).catch(() => {
      busy = false;
      error = "Couldn't reach the server. Try again.";
    });
  }
</script>

<div class="sign-in">
  <button class="back" aria-label="Back" onclick={step === "code" ? restart : onback}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5 7 10l5 5" /></svg>
  </button>

  {#if step === "email"}
    <h2>Sync your notes</h2>
    <p class="lead">Keep your notes on all your devices.</p>

    {#if offered.google || offered.apple}
      <div class="social">
        {#if offered.google}
          <button class="option" disabled={busy} onclick={() => social("google")}>Continue with Google</button>
        {/if}
        {#if offered.apple}
          <button class="option" disabled={busy} onclick={() => social("apple")}>Continue with Apple</button>
        {/if}
      </div>
      <p class="or"><span>or</span></p>
    {/if}

    <form onsubmit={send}>
      <label class="visually-hidden" for="sign-in-email">Email</label>
      <input
        bind:this={field}
        bind:value={email}
        id="sign-in-email"
        type="email"
        placeholder="you@email.com"
        autocomplete="email"
        autocapitalize="none"
        spellcheck="false"
        enterkeyhint="send"
        required
      />
      <button class="primary" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send code"}</button>
    </form>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <p class="note">No password. We'll email you a 6-digit code.</p>
    <p class="note fine"><a href="/terms" target="_blank">Terms</a> · <a href="/privacy" target="_blank">Privacy</a></p>
  {:else}
    <h2>Check your email</h2>
    <p class="lead">Enter the code we sent to <strong>{email.trim()}</strong>.</p>
    <label class="visually-hidden" for="sign-in-code">Code</label>
    <input
      bind:this={field}
      bind:value={code}
      oninput={oncode}
      id="sign-in-code"
      class="code"
      class:wrong={error}
      inputmode="numeric"
      autocomplete="one-time-code"
      maxlength="6"
      placeholder="000000"
      disabled={busy}
    />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <p class="links">
      {#if wait}
        <span>Resend in {wait}s</span>
      {:else}
        <button class="link" onclick={() => send()}>Resend code</button>
      {/if}
      <span class="dot">·</span>
      <button class="link" onclick={restart}>Use another email</button>
    </p>
  {/if}
</div>

<style>
  .sign-in {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 48px 20px 20px;
    overflow-y: auto;
  }

  .back {
    position: absolute;
    top: 12px;
    left: 12px;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 0;
    color: var(--muted);
  }

  .back svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  h2 {
    margin: 0;
    font: inherit;
  }

  .lead {
    margin: 6px 0 24px;
    color: var(--muted);
  }

  .lead strong {
    font-weight: 400;
    color: var(--text);
  }

  .social {
    display: grid;
    gap: 8px;
  }

  .or {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 16px 0;
    color: var(--faint);
  }

  .or::before,
  .or::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  form {
    display: grid;
    gap: 8px;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    height: 36px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 0;
    background: var(--bg);
    outline: none;
    transition: border-color 120ms ease;
  }

  input:focus {
    border-color: var(--accent);
  }

  input::placeholder {
    color: var(--faint);
    opacity: 1;
  }

  .code {
    text-align: center;
    letter-spacing: 0.4em;
    padding-left: 0.4em;
    font-variant-numeric: tabular-nums;
  }

  .code.wrong {
    border-color: var(--danger);
  }

  .option,
  .primary {
    height: 36px;
    border-radius: 0;
    transition:
      transform 120ms var(--ease-out),
      background-color 120ms ease,
      opacity 120ms ease;
  }

  .option {
    border: 1px solid var(--line);
    background: var(--surface);
  }

  .primary {
    border: 1px solid var(--text);
  }

  .option:active:not(:disabled),
  .primary:active:not(:disabled),
  .back:active {
    transform: scale(0.97);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    margin: 10px 0 0;
    color: var(--danger);
  }

  .note {
    margin: 16px 0 0;
    color: var(--faint);
  }

  .fine {
    margin-top: 4px;
  }

  .fine a {
    color: inherit;
  }

  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 16px 0 0;
    color: var(--muted);
  }

  .link {
    text-decoration: underline;
  }

  .dot {
    color: var(--faint);
  }

  @media (hover: hover) and (pointer: fine) {
    .back:hover {
      color: var(--text);
      background: var(--hover);
    }

    .option:hover:not(:disabled),
    .primary:hover:not(:disabled) {
      background: var(--hover);
    }
  }
</style>
