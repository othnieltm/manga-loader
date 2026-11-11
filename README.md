# Manga Loader

## Run locally

Install the frontend dependencies from the repository root with
`npm --prefix frontend ci --include=optional`. Start the API with
`npm --prefix backend start`, then start Vite in another terminal with
`npm --prefix frontend run dev`. The Vite dev server proxies `/api` requests to
the local API on port 3001.

## Deploy to Vercel

Import the repository into Vercel with the **Root Directory** set to the
repository root (`.`). The root `vercel.json` defines separate `backend` and
`frontend` services. The `/api/*` rewrite exposes the backend; the catch-all
rewrite sends all other public paths to the Vite frontend. No service bindings
are required: browser requests use the public same-origin `/api` route, and the
backend does not call the frontend service.

Use `vercel dev` from the repository root to run the services together locally.

The API intentionally supports the TCB One Piece source and its image CDN only.
PDF exports can take time because the function downloads and combines the
chapter images; Vercel's configured maximum function duration is five minutes.
