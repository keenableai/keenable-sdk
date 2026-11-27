# Keenable in the browser (TypeScript)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/keenableai/keenable-sdk/tree/main/examples/stackblitz?file=index.ts)

A minimal Node + TypeScript project that runs a keyless Keenable search and
prints the results as a numbered, citable block (`toContext()`). No account and
no API key needed.

On StackBlitz it installs and runs by itself; edit `index.ts` and run
`npm start` in the terminal to try another query.

Locally (Node 18+):

```bash
npm install
npm start
```

Set `KEENABLE_API_KEY` to lift the keyless hourly cap. More in the
[TypeScript SDK reference](../../typescript).
