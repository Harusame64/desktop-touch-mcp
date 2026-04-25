# Site Content Directory

This directory stores drafts and assets for the public-facing site.

## Purpose

- `docs/` holds design notes, research notes, and implementation planning
- `site/` holds content that is close to what readers should eventually see

This separation helps keep:

- internal planning separate from public-facing copy
- GitHub Pages and note-ready drafts easier to edit
- figures and evaluation data scoped to the site itself

## Current structure

```text
site/
  README.md
  site-plan.md
  index.md
  index.html
  articles/
    client-setup.html
    client-setup.md
    beyond-coordinate-roulette.html
    beyond-coordinate-roulette.md
    planned-evaluation.html
    planned-evaluation.md
    reactive-perception-graph.html
    reactive-perception-graph.md
  assets/
    figures/
    eval/
```

## File roles

- `site-plan.md`
  - overall site structure and page responsibilities
- `index.md`
  - home page draft
- `index.html`
  - published home page entry point
- `articles/client-setup.md`
  - client setup draft
- `articles/client-setup.html`
  - published client setup page
- `articles/beyond-coordinate-roulette.md`
  - philosophy explainer
- `articles/beyond-coordinate-roulette.html`
  - published philosophy page
- `articles/reactive-perception-graph.md`
  - RPG explainer
- `articles/reactive-perception-graph.html`
  - published RPG page
- `articles/planned-evaluation.md`
  - evaluation page draft
- `articles/planned-evaluation.html`
  - published evaluation page
- `assets/figures/`
  - visual drafts and diagrams
- `assets/eval/`
  - evaluation JSON / CSV / summarized data

## Publishing

The full `site/` directory is not meant to be published as-is.

- Markdown drafts and planning notes stay in the repository
- GitHub Pages publishes only the public HTML entry points and shared assets
- The publish workflow assembles a clean `_site/` artifact from:
  - `site/index.html`
  - `site/articles/*.html`
  - `site/assets/**`

The workflow file is:

- `.github/workflows/pages.yml`

## Editing policy

- reader-facing writing should go into `site/` first
- design planning and comparative notes should stay in `docs/`
- page structure and copy should be stabilized here before turning them into actual site files
