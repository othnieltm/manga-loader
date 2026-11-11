# Manga Loader

## Run locally

Install the frontend dependencies from the repository root with
`npm --prefix frontend ci --include=optional`. Start the API with
`npm --prefix backend start`, then start Vite in another terminal with
`npm --prefix frontend run dev`. The Vite dev server proxies `/api` requests to
the local API on port 3001.

## Deploy to Vercel

Import the repository into Vercel and set **Root Directory** to the repository
root (`.`), not `frontend`. The root `vercel.json` installs and builds the frontend,
publishes `frontend/dist`, and deploys the three API routes as Node.js
Functions. No environment variables are required when the frontend and API
share the Vercel domain.

The API intentionally supports the TCB One Piece source and its image CDN only.
PDF exports can take time because the function downloads and combines the
chapter images; Vercel's configured maximum function duration is five minutes.
