# Contributing

Requires Node.js 22.19 or newer.

```bash
npm ci
npm run typecheck
npm test
npm run release:check
npm run package:smoke
```

Keep capability changes fail-closed. Add one focused regression test for behavior changes. Pull requests should state the user-visible contract and any compatibility impact.
