# vendored/

Nothing in this directory is committed. It holds the board module the app builds against, which is
deliberately not part of this repo.

Drop a module here as `board/plugin.js`:

```js
export default {
  id: 'board',
  name: 'Board',
  register(ctx) {
    ctx.registerMany([{ id: 'page', area: ROUTES_AREA, title: 'Board', data: { path: '/board' }, render: () => <Page /> }])
  }
}
```

…or point the build at a module anywhere on disk:

```sh
BOARD_MODULE=/absolute/path/to/module.js npm --prefix packages/app run build
```

See the "Bring your own board module" section of the README for the full `ctx` and `host` surface.
