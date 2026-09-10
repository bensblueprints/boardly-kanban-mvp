import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "client",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "landing-motion-entry",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] === "/landing/motion.js")
            req.url = "/marketing.js";
          next();
        });
      },
    },
  ],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve("client/index.html"),
        marketing: resolve("client/marketing.js"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "marketing"
            ? "landing/motion.js"
            : "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5316,
    proxy: {
      "/api": "http://localhost:5315",
      "/uploads": "http://localhost:5315",
    },
  },
});
