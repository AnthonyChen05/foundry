<script lang="ts">
  import { onMount } from "svelte";
  import { activeChatBinding, idem, socket } from "$lib/foundry.svelte";

  let path = $state(".");
  let rows = $state<{ path: string; size: number; mtime: string; isDir: boolean }[]>([]);
  let note = $state("");
  let busy = $state(false);

  let viewing = $state<{ path: string; text: string; truncated: boolean } | undefined>(undefined);
  let newFileVisible = $state(false);
  let newPath = $state("");
  let newContent = $state("");

  onMount(() => {
    ls(".");
  });

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    note = "";
    try {
      await action();
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function ls(p: string): void {
    void run(async () => {
      path = p;
      viewing = undefined;
      // ADR-015: read the ACTIVE CHAT's env when it is bound (local chats hit
      // the desktop sandbox); default = the user's primary backend env.
      const bind = activeChatBinding();
      rows = await socket().filesList(
        { path: p, ...(bind.envId !== undefined ? { envId: bind.envId } : {}) },
      );
    });
  }

  function openEntry(entry: { path: string; isDir: boolean }): void {
    if (entry.isDir) {
      ls(entry.path);
      return;
    }
    void run(async () => {
      const res = await socket().filesRead({ path: entry.path });
      let text: string;
      if (res.b64 === true) {
        const bin = atob(res.content);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        text = new TextDecoder().decode(bytes.slice(0, 16_000));
      } else {
        text = res.content.slice(0, 16_000);
      }
      viewing = { path: entry.path, text, truncated: res.content.length > 16_000 };
    });
  }

  function join(dir: string, name: string): string {
    const base = dir === "." ? "" : dir.endsWith("/") ? dir : dir + "/";
    return base + name;
  }

  function up(): void {
    if (path === "." || path === "/") {
      ls(".");
      return;
    }
    const parent = path.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
    ls(parent === "" ? "." : parent);
  }

  function save(): void {
    const p = newPath.trim();
    if (p.length === 0) return;
    void run(async () => {
      await socket().filesWrite({ path: p, content: newContent }, idem("files"));
      newFileVisible = false;
      newPath = "";
      newContent = "";
      ls(path);
    });
  }

  function mkdir(): void {
    const p = newPath.trim();
    if (p.length === 0) return;
    void run(async () => {
      await socket().filesMkdir({ path: p, recursive: true }, idem("files"));
      newFileVisible = false;
      newPath = "";
      ls(path);
    });
  }

  function rm(entry: { path: string; isDir: boolean }): void {
    void run(async () => {
      await socket().filesRm({ path: entry.path, recursive: entry.isDir }, idem("files"));
      ls(path);
    });
  }
</script>

<div class="pane">
  <div class="pane-head">
    <h2>Files</h2>
    <span class="crumb">
      <button onclick={() => ls(".")}>workspace</button>
      {path !== "." ? `/ ${path}` : ""}
    </span>
    <button class="ghost" onclick={up} disabled={path === "."}>↑</button>
    <div class="spacer"></div>
    <button class="ghost" onclick={() => (newFileVisible = !newFileVisible)}>New file…</button>
  </div>

  {#if newFileVisible}
    <div class="newfile">
      <input placeholder="workspace-relative path, e.g. notes/hello.txt" bind:value={newPath} />
      <textarea rows="4" placeholder="file content" bind:value={newContent}></textarea>
      <div class="row">
        <button class="primary" onclick={save} disabled={newPath.trim().length === 0}>Save</button>
        <button onclick={mkdir} disabled={newPath.trim().length === 0}>Create dir</button>
        <button class="ghost" onclick={() => (newFileVisible = false)}>Cancel</button>
      </div>
    </div>
  {/if}

  <div class="pane-body">
    {#if note !== ""}
      <p class="error-text">{note}</p>
    {/if}

    {#if viewing !== undefined}
      <p class="crumb">
        <button onclick={() => (viewing = undefined)}>← back to listing</button> · {viewing.path}
      </p>
      <pre>{viewing.text}{viewing.truncated ? "\n…" : ""}</pre>
    {:else}
      <table>
        <thead>
          <tr><th>path</th><th>size</th><th>modified</th><th></th></tr>
        </thead>
        <tbody>
          {#each rows as r (r.path)}
            <tr>
              <td class="mono">
                <button class="link" onclick={() => openEntry(r)}>{r.path}{r.isDir ? "/" : ""}</button>
              </td>
              <td>{r.isDir ? "—" : String(r.size)}</td>
              <td class="muted">{r.mtime}</td>
              <td><button class="ghost" onclick={() => rm(r)}>rm</button></td>
            </tr>
          {:else}
            <tr><td colspan="4" class="muted">{busy ? "loading…" : "empty (or path missing)"}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .newfile {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-soft);
  }

  .newfile .row {
    display: flex;
    gap: 8px;
  }

  table .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--info);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  table .link:hover {
    text-decoration: underline;
  }
</style>