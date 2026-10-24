<script lang="ts">
  import { onMount, tick } from "svelte";
  import { providers, sendCode, signInWith, verify, type Providers } from "../sync/account.svelte.ts";
  import Back from "./Back.svelte";

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
  <Back onclick={step === "code" ? restart : onback} />

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
      <span>·</span>
      <button class="link" onclick={restart}>Use another email</button>
    </p>
  {/if}
</div>

<style>
  /* The app's scale (see app.css): 16px around and between groups, 6px within one, 2px for a line's explanation. */
  .sign-in {
    display: flex;
    flex-direction: column;
    padding: var(--edge);
    overflow-y: auto;
  }

  h2 {
    margin: 0;
    font: inherit;
  }

  .lead {
    margin: var(--pair) 0 var(--group);
    color: var(--muted);
  }

  .lead strong {
    font-weight: 400;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .social {
    display: grid;
    gap: var(--gap);
  }

  .or {
    display: flex;
    align-items: center;
    gap: 2ch;
    margin: var(--gap) 0;
    color: var(--muted);
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
    gap: var(--gap);
  }

  input {
    box-sizing: border-box;
    width: 100%;
    height: var(--control);
    padding: 0 var(--inset);
    border: 1px solid var(--field);
    border-radius: var(--radius-small);
    background: var(--bg);
    outline: none;
    transition:
      border-color var(--quick) ease,
      box-shadow var(--quick) ease;
  }

  /* Focus is the accent's: the border takes it, with a hairline more so it reads at a glance. */
  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  input::placeholder {
    color: var(--faint);
    opacity: 1;
  }

  /* Letter-spacing adds space after every digit, the last one too: the same on the left keeps them centered. */
  .code {
    text-align: center;
    letter-spacing: 0.4em;
    padding: 0 var(--inset) 0 calc(var(--inset) + 0.4em);
    font-variant-numeric: tabular-nums;
  }

  .code.wrong {
    border-color: var(--danger);
  }

  .option,
  .primary {
    min-height: var(--control);
    border-radius: var(--radius-small);
    transition:
      transform var(--quick) var(--ease-out),
      background-color var(--quick) ease,
      opacity var(--quick) ease;
  }

  .option {
    border: 1px solid var(--line);
    background: var(--surface);
  }

  /* The one main action in the view: the accent, filled. */
  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
  }

  .option:active:not(:disabled),
  .primary:active:not(:disabled) {
    transform: scale(0.97);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Disabled, every button looks the same: a grey outline. The main one takes the accent once it can act. */
  .primary:disabled {
    border-color: var(--line);
    background: transparent;
    color: var(--muted);
  }

  .error {
    margin: var(--gap) 0 0;
    color: var(--danger);
  }

  .note {
    margin: var(--group) 0 0;
    color: var(--muted);
  }

  .fine {
    margin-top: var(--pair);
  }

  .fine a {
    color: inherit;
  }

  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 1ch;
    margin: var(--group) 0 0;
    color: var(--muted);
  }

  .link {
    text-decoration: underline;
  }

  @media (hover: hover) and (pointer: fine) {
    .option:hover:not(:disabled) {
      background: var(--hover);
    }

    .primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }
  }
</style>
