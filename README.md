# Canary Yellow Applications Site

Fresh Astro project for rebuilding `canaryyellowapplications.com` locally before publishing through GitHub.

## Local setup

This machine has an older global Node installed at `/usr/local/bin/node`, and Astro needs the newer Homebrew one.
Use this in any new terminal before running project commands:

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

Then run:

```sh
npm run dev
```

Open `http://localhost:4321`.

## Useful commands

- `npm run dev` starts the local development server
- `npm run build` creates the production build in `dist/`
- `npm run preview` previews the production build locally
- `npm run check` runs Astro's project checks

## Project structure

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
├── astro.config.mjs
└── package.json
```

## Current direction

- Start with a single polished homepage
- Add app showcase sections as your product suite grows
- Keep all design work local until it is ready to push
