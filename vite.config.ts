import { cloudflare } from "@cloudflare/vite-plugin";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The app lives in app/, the Worker behind it in worker/; one dev server runs both.
export default defineConfig({
  root: "app",
  plugins: [
    solid(),
    cloudflare({ configPath: here("wrangler.jsonc"), persistState: { path: here(".wrangler/state") } }),
    serviceWorker(),
  ],
});

/** Emits `sw.js`, which precaches every file of the app so it opens with no network at all. */
function serviceWorker(): Plugin {
  return {
    name: "literal:service-worker",
    apply: "build",
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_, bundle) {
      const hash = createHash("sha256");
      const files: string[] = [];
      for (const [name, chunk] of Object.entries(bundle)) {
        // Dotfiles, like `.assetsignore`, configure Cloudflare and aren't served.
        if (name.startsWith(".")) continue;
        files.push(url(name));
        hash.update(chunk.type === "chunk" ? chunk.code : chunk.source);
      }
      const publicDir = here("app/public");
      for (const name of readdirSync(publicDir, { recursive: true, encoding: "utf8" })) {
        const path = join(publicDir, name);
        // `_headers` is read by Cloudflare, not served.
        if (name.startsWith("_") || !statSync(path).isFile()) continue;
        files.push(url(name.replaceAll("\\", "/")));
        hash.update(readFileSync(path));
      }
      const source = readFileSync(here("app/sw.js"), "utf8")
        .replace('"__VERSION__"', JSON.stringify(hash.digest("hex").slice(0, 12)))
        .replace('["__FILES__"]', JSON.stringify(files));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/** Where a file is served. Pages go by their clean URL: Cloudflare redirects `/privacy.html` to `/privacy`. */
function url(file: string): string {
  return `/${file.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "")}`;
}
