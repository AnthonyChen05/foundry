<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { activeChatBinding, idem, socket } from "$lib/foundry.svelte";

  let host = $state<HTMLDivElement | undefined>(undefined);
  let termId = $state("");
  let status = $state("");
  let busy = $state(false);

  let t: Terminal | undefined;
  let fit: FitAddon | undefined;
  let ro: ResizeObserver | undefined;

  // The hub floods every frame to every connection; route by channel.
  const off = socket().on((event, channel, _seq, payload) => {
    if (termId === "" || channel !== `term:${termId}`) return;
    if (t === undefined) return;
    const p = payload as Record<string, unknown>;
    if (event === "term.data") {
      const data = typeof p["data"] === "string" ? p["data"] : "";
      if (data.length === 0) return;
      if (p["b64"] === true) {
        t.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      } else {
        t.write(data);
      }
    } else if (event === "term.exit") {
      const code = p["code"];
      status =
        code === null || code === undefined
          ? "session closed"
          : `process exited (code ${String(code)}) — you can open a new one`;
    }
  });

  onMount(() => {
    return off;
  });

  onDestroy(() => {
    ro?.disconnect();
    try {
      void socket().termClose({ termId }, idem("termclose"));
    } catch {
      /* already disconnected */
    }
  });

  async function openTerm(): Promise<void> {
    if (busy || host === undefined) return;
    busy = true;
    status = "";
    try {
      t?.dispose();
      t = new Terminal({
        fontSize: 13,
        fontFamily: 'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
        cursorBlink: true,
        scrollback: 2000,
        // Terminal stays dark regardless of theme (like claude.ai code blocks);
        // warm grays + terracotta cursor to match the Claude scheme.
        theme: {
          background: "#1f1e1d",
          foreground: "#eae6dd",
          cursor: "#d97757",
          cursorAccent: "#1f1e1d",
          selectionBackground: "rgba(217, 119, 87, 0.35)",
        },
      });
      fit = new FitAddon();
      t.loadAddon(fit);
      host.replaceChildren();
      t.open(host);
      // ADR-015: open the ACTIVE CHAT's env when it is bound (local chats hit
      // the desktop sandbox); default = the user's primary backend env.
      const bind = activeChatBinding();
      const res = await socket().termOpen(
        bind.envId !== undefined ? { envId: bind.envId } : {},
        idem("term"),
      );
      termId = res.termId;
      if (res.replay.length > 0) t.write(res.replay);
      fit.fit();
      t.focus();
      await socket().termResize({ termId, cols: t.cols, rows: t.rows }, idem("termrsz")).catch(() => {});
      t.onData((data) => {
        void socket().termInput({ termId, data }, idem("termin")).catch(() => {});
      });
      ro = new ResizeObserver(() => {
        if (t === undefined || fit === undefined || termId === "") return;
        try {
          fit.fit();
          void socket().termResize({ termId, cols: t.cols, rows: t.rows }, idem("termrsz")).catch(() => {});
        } catch {
          /* unmeasurable between layout ticks */
        }
      });
      ro.observe(host);
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function closeTerm(): Promise<void> {
    if (termId === "") return;
    const id = termId;
    termId = "";
    status = "session closed";
    ro?.disconnect();
    ro = undefined;
    try {
      await socket().termClose({ termId: id }, idem("termclose"));
    } catch {
      /* sandbox may already be gone */
    }
    t?.dispose();
    t = undefined;
  }
</script>

<div class="pane">
  <div class="pane-head">
    <h2>Terminal</h2>
    <span class="crumb muted">{termId === "" ? "no session" : `term:${termId.slice(0, 8)}…`}</span>
    <div class="spacer"></div>
    {#if termId === ""}
      <button class="primary" onclick={() => void openTerm()} disabled={busy || host === undefined}>
        {busy ? "Opening…" : "Open shell"}
      </button>
    {:else}
      <button class="danger" onclick={() => void closeTerm()}>Close</button>
    {/if}
  </div>
  <div class="termwrap">
    <div class="termhost" bind:this={host}></div>
    {#if termId === "" && status === ""}
      <p class="muted hint">Opens a PTY in the user's sandbox environment. Scrollback replays on open.</p>
    {/if}
    {#if status !== ""}
      <p class="muted hint statuserr">{status}</p>
    {/if}
  </div>
</div>

<style>
  .termwrap {
    position: relative;
    flex: 1;
    min-height: 0;
    padding: 10px 14px;
    display: flex;
  }

  .termhost {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .hint {
    position: absolute;
    inset: auto 0 18px;
    text-align: center;
    margin: 0;
  }
</style>